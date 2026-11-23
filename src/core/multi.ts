import { estimateTokens, MalformedOutput, type ChatMessage } from './llm.js'
import { PROMPT_VERSION, ROLES, personalSystem, specialistSystem, type Role } from './prompts.js'
import {
  emergencyReport,
  emit,
  isBudgetStop,
  normalizeReport,
  toolAsk,
  toolCourse,
  toolSearch,
  type RunContext,
} from './runtime.js'
import type { Finding } from './types.js'

export const MULTI_VERSION = `${PROMPT_VERSION}/B`
export const ALL_ROLES = Object.keys(ROLES) as Role[]
const MAX_HANDOFF_DEPTH = 2

/** Shared JSON record maintained by the Personal Agent and passed to specialists. */
interface Board {
  facts: Record<string, string>
  findings: Finding[]
  asked: Set<string>
}

/**
 * Condition B — Personal Agent + institution-scoped specialists, sequential
 * controller. All specialist, handoff and repair calls share the run ledger.
 */
export async function runMulti(ctx: RunContext): Promise<void> {
  const { run, budget, ledger } = ctx
  const board: Board = { facts: {}, findings: [], asked: new Set() }
  const system = personalSystem(budget.clarifications, ALL_ROLES)
  const messages: ChatMessage[] = [{ role: 'user', content: `STUDENT (opening message): ${ctx.opening}` }]
  emit(ctx, { kind: 'student', text: ctx.opening })

  const contextSize = () => estimateTokens(system) + messages.reduce((n, m) => n + estimateTokens(m.content), 0)
  const mustFinish = () =>
    ledger.remainingCalls <= 2 || ledger.remainingTokens < contextSize() + budget.finalOutputTokens + 600

  try {
    for (let step = 0; step < budget.modelCalls; step++) {
      if (mustFinish()) {
        messages.push({
          role: 'user',
          content: 'SYSTEM: team budget nearly exhausted. Reply now with action "final" and the full report.',
        })
        emit(ctx, { kind: 'limit', detail: 'forced final answer (budget)' })
      }
      const out = await ledger.json<Record<string, unknown>>(
        'personal',
        `step-${step + 1}`,
        system,
        messages,
        budget.finalOutputTokens,
      )
      messages.push({ role: 'assistant', content: JSON.stringify(out) })
      mergeFacts(board, out.facts)
      if (typeof out.thought === 'string' && out.thought) emit(ctx, { kind: 'thought', agent: 'personal', text: out.thought.slice(0, 600) })
      const action = String(out.action ?? '')
      let observation: string
      if (action === 'final') {
        run.report = normalizeReport(out.report)
        if (Object.keys(board.facts).length && !run.report.profile.length)
          run.report.profile = Object.entries(board.facts).map(([k, v]) => `${k}: ${v}`)
        run.stop = 'final'
        return
      } else if (action === 'ask_student') {
        observation = await toolAsk(ctx, 'personal', String(out.question ?? ''))
      } else if (action === 'delegate') {
        const role = ALL_ROLES.find((r) => r === out.role)
        observation = role
          ? await delegate(ctx, board, 'personal', role, String(out.question ?? ''), 0)
          : `OBSERVATION: unknown specialist "${String(out.role)}". Valid: ${ALL_ROLES.join(', ')}.`
      } else {
        observation = `OBSERVATION: unknown action "${action}". Use ask_student, delegate or final.`
      }
      messages.push({ role: 'user', content: observation })
    }
    run.stop = 'step-limit'
    run.report = emergencyReport(ctx, 'step limit')
  } catch (error) {
    if (!isBudgetStop(error)) throw error
    emit(ctx, { kind: 'limit', detail: (error as Error).message })
    run.stop = (error as Error).message
    run.report = emergencyReport(ctx, (error as Error).message)
  }
}

function mergeFacts(board: Board, raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v == null || v === '') continue
    board.facts[k.slice(0, 60)] = String(v).slice(0, 300)
  }
}

async function delegate(
  ctx: RunContext,
  board: Board,
  from: string,
  role: Role,
  question: string,
  depth: number,
): Promise<string> {
  const { run, budget } = ctx
  const key = `${role}|${question.trim().toLowerCase()}`
  if (board.asked.has(key)) return `OBSERVATION: ${role} already answered this exact question; see earlier findings.`
  if (run.usage.specialistCalls >= budget.specialistCalls) {
    emit(ctx, { kind: 'limit', detail: 'specialist-call limit reached' })
    return 'OBSERVATION: specialist-call limit reached. Do not delegate again; finish with the findings you have.'
  }
  board.asked.add(key)
  run.usage.specialistCalls += 1
  emit(ctx, { kind: 'delegate', from, to: role, question, facts: { ...board.facts }, depth })

  let result: SpecialistResult
  try {
    result = await runSpecialist(ctx, board, role, question)
  } catch (error) {
    if (!(error instanceof MalformedOutput)) throw error
    // one specialist failing to report must not sink the team; Personal sees the gap
    emit(ctx, { kind: 'error', detail: `${role}: ${error.message}` })
    result = { findings: [], missing: [] }
  }
  board.findings.push(...result.findings.map((f) => ({ ...f, by: role })))
  emit(ctx, { kind: 'report', agent: role, findings: result.findings, missing: result.missing })
  let text = formatFindings(ctx, role, result.findings, result.missing)

  const h = result.handoff
  if (h) {
    const target = ALL_ROLES.find((r) => r === h.role)
    const ok = Boolean(target && target !== role && depth + 1 <= MAX_HANDOFF_DEPTH)
    emit(ctx, {
      kind: 'handoff',
      from: role,
      to: String(h.role),
      question: h.question,
      accepted: ok,
      reason: ok ? h.reason : 'rejected: invalid role, self-handoff or depth limit',
    })
    if (ok && target) text += `\n\n(handoff requested by ${role})\n${await delegate(ctx, board, role, target, h.question, depth + 1)}`
  }
  return text
}

interface SpecialistResult {
  findings: Finding[]
  missing: string[]
  handoff?: { role: string; question: string; reason: string }
}

async function runSpecialist(ctx: RunContext, board: Board, role: Role, question: string): Promise<SpecialistResult> {
  const { budget, ledger } = ctx
  const others = ALL_ROLES.filter((r) => r !== role)
  const system = specialistSystem(role, others)
  const units = ROLES[role].units
  const known = Object.keys(ctx.run.retrieved).slice(-30)
  const brief = [
    `TASK from the Personal Agent: ${question}`,
    `SHARED RECORD — confirmed student facts: ${JSON.stringify(board.facts)}`,
    board.findings.length
      ? `Findings already on the record:\n${board.findings
          .slice(-8)
          .map((f) => `- (${f.by}) ${f.claim} [${f.evidence.join(', ')}]`)
          .join('\n')}`
      : 'No findings on the record yet.',
    known.length ? `Evidence ids already collected by the team: ${known.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
  const messages: ChatMessage[] = [{ role: 'user', content: brief }]
  const agent = role
  for (let step = 0; step < budget.specialistSteps; step++) {
    const last = step === budget.specialistSteps - 1 || ledger.remainingCalls <= 3
    if (last) messages.push({ role: 'user', content: 'SYSTEM: reply now with action "report".' })
    const out = await ledger.json<Record<string, unknown>>(agent, `specialist-${step + 1}`, system, messages, budget.stepOutputTokens)
    messages.push({ role: 'assistant', content: JSON.stringify(out) })
    if (typeof out.thought === 'string' && out.thought) emit(ctx, { kind: 'thought', agent, text: out.thought.slice(0, 400) })
    const action = String(out.action ?? '')
    if (action === 'report' || last) return parseReport(out)
    let observation: string
    if (action === 'search') observation = toolSearch(ctx, agent, String(out.query ?? ''), { units })
    else if (action === 'get_course') observation = toolCourse(ctx, agent, String(out.code ?? ''))
    else observation = `OBSERVATION: unknown action "${action}". Use search, get_course or report.`
    messages.push({ role: 'user', content: observation })
  }
  return { findings: [], missing: [] }
}

function parseReport(out: Record<string, unknown>): SpecialistResult {
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).slice(0, 400)).filter(Boolean) : [])
  const findings = (Array.isArray(out.findings) ? out.findings : []).slice(0, 3).map((f) => {
    const x = (f ?? {}) as Record<string, unknown>
    return {
      claim: String(x.claim ?? '').slice(0, 600),
      evidence: list(x.evidence).slice(0, 6),
      conditions: list(x.conditions).slice(0, 5),
      missing: list(x.missing).slice(0, 5),
    }
  })
  const h = out.handoff && typeof out.handoff === 'object' ? (out.handoff as Record<string, unknown>) : undefined
  return {
    findings: findings.filter((f) => f.claim),
    missing: list(out.missing).slice(0, 6),
    handoff:
      h && h.role && h.question
        ? { role: String(h.role), question: String(h.question).slice(0, 400), reason: String(h.reason ?? '').slice(0, 300) }
        : undefined,
  }
}

function formatFindings(ctx: RunContext, role: Role, findings: Finding[], missing: string[]) {
  const lines = [`OBSERVATION from ${ROLES[role].title}:`]
  if (!findings.length) lines.push('- no supported findings')
  for (const f of findings) {
    lines.push(`- ${f.claim}`)
    if (f.conditions.length) lines.push(`  conditions: ${f.conditions.join('; ')}`)
    if (f.missing.length) lines.push(`  missing: ${f.missing.join('; ')}`)
    for (const id of f.evidence) {
      const text = ctx.corpus.evidenceText(id)
      lines.push(text ? `  [${id}] ${text.replace(/\s+/g, ' ').slice(0, 240)}…` : `  [${id}] (id not found in corpus)`)
    }
  }
  if (missing.length) lines.push(`Facts to ask the student: ${missing.join('; ')}`)
  return lines.join('\n')
}
