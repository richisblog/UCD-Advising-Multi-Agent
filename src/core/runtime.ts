import { BudgetExceeded, Ledger, MalformedOutput, type Model } from './llm.js'
import { Corpus, formatCourse, formatHit, type Scope } from './retrieval.js'
import type { Budget, FinalReport, RunRecord, TraceEvent, Unit } from './types.js'

/** What the agent hears back when it asks the student a question. */
export interface StudentReply {
  text: string
  facts: string[]
}
/** Simulated student, a researcher answering by hand, or the live user in consult mode. */
export type Student = (question: string, signal: AbortSignal) => Promise<StudentReply>

export interface RunContext {
  run: RunRecord
  corpus: Corpus
  budget: Budget
  ledger: Ledger
  student: Student
  opening: string
  signal: AbortSignal
  /** called after each trace event so the UI can follow progress */
  onUpdate?: (run: RunRecord) => void
}

export function makeContext(
  run: RunRecord,
  corpus: Corpus,
  model: Model,
  student: Student,
  opening: string,
  signal: AbortSignal,
  onUpdate?: (run: RunRecord) => void,
): RunContext {
  return {
    run,
    corpus,
    budget: run.budget,
    ledger: new Ledger(run, run.budget, model, signal),
    student,
    opening,
    signal,
    onUpdate,
  }
}

type EventInput = TraceEvent extends infer E ? (E extends TraceEvent ? Omit<E, 'at'> : never) : never

export function emit(ctx: RunContext, event: EventInput) {
  ctx.run.trace.push({ at: Date.now(), ...event } as TraceEvent)
  ctx.onUpdate?.(ctx.run)
}

function remember(ctx: RunContext, id: string, agent: string) {
  const seen = (ctx.run.retrieved[id] ??= [])
  if (!seen.includes(agent)) seen.push(agent)
}

const searchMemo = new WeakMap<RunRecord, Map<string, string[]>>()

/** Search under a scope, log it and return the observation text. */
const TOOL_LIMIT =
  'OBSERVATION: tool-call limit reached. Do not search again; finish with the evidence you already have and list what is unverified.'

function takeTool(ctx: RunContext) {
  try {
    ctx.ledger.useTool()
    return true
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error
    emit(ctx, { kind: 'limit', detail: 'tool-call limit reached' })
    return false
  }
}

export function toolSearch(ctx: RunContext, agent: string, query: string, scope: Scope): string {
  if (!takeTool(ctx)) return TOOL_LIMIT
  const key = `${(scope.units ?? []).join(',')}|${(scope.levels ?? []).join(',')}|${query.trim().toLowerCase()}`
  let memo = searchMemo.get(ctx.run)
  if (!memo) searchMemo.set(ctx.run, (memo = new Map()))
  const hits = ctx.corpus.search(query, scope, 4)
  const ids = hits.map((h) => h.id)
  const already = ids.length > 0 && ids.every((id) => ctx.run.retrieved[id])
  const repeated = memo.has(key) || already
  if (repeated) ctx.run.usage.repeatedRetrievals += 1
  memo.set(key, ids)
  for (const id of ids) remember(ctx, id, agent)
  emit(ctx, {
    kind: 'search',
    agent,
    query,
    scope: scopeLabel(scope),
    results: ids,
    repeated,
  })
  if (!hits.length) return `OBSERVATION search "${query}" (${scopeLabel(scope)}): no matching documents. Try different keywords.`
  return `OBSERVATION search "${query}" (${scopeLabel(scope)}):\n\n${hits.map((h) => formatHit(h)).join('\n\n')}`
}

export function toolCourse(ctx: RunContext, agent: string, code: string): string {
  if (!takeTool(ctx)) return TOOL_LIMIT
  const course = ctx.corpus.course(code)
  const id = course ? `COURSE:${course.code}` : ''
  const repeated = Boolean(id && ctx.run.retrieved[id])
  if (repeated) ctx.run.usage.repeatedRetrievals += 1
  if (id) remember(ctx, id, agent)
  emit(ctx, { kind: 'course', agent, code, found: Boolean(course), repeated })
  if (!course) return `OBSERVATION get_course "${code}": no catalog record found in the local course data.`
  return `OBSERVATION [${id}] (local CourseScope catalog record)\n${formatCourse(course)}`
}

export async function toolAsk(ctx: RunContext, agent: string, question: string): Promise<string> {
  if (ctx.run.usage.clarifications >= ctx.budget.clarifications) {
    emit(ctx, { kind: 'limit', detail: 'clarification limit reached' })
    return 'OBSERVATION: clarification limit reached. Do not ask the student again; finish with what you know and list the gaps.'
  }
  ctx.run.usage.clarifications += 1
  const reply = await ctx.student(question, ctx.signal)
  for (const f of reply.facts) if (!ctx.run.disclosed.includes(f)) ctx.run.disclosed.push(f)
  emit(ctx, { kind: 'ask', agent, question, reply: reply.text, facts: reply.facts })
  return `STUDENT: ${reply.text}`
}

export function scopeLabel(scope: Scope) {
  const u = scope.units?.length ? scope.units.join('+') : 'all units'
  const l = scope.levels?.length ? ` @${scope.levels.join('+')}` : ''
  return `${u}${l}`
}

const UNITS: Unit[] = ['university', 'ls', 'coe', 'ecs', 'psc', 'lin', 'mat']
export function parseUnit(v: unknown): Unit | undefined {
  return UNITS.find((u) => u === String(v ?? '').trim().toLowerCase())
}

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : v == null ? '' : String(v).slice(0, max))
const strs = (v: unknown, n = 12) => (Array.isArray(v) ? v.map((x) => str(x, 600)).filter(Boolean).slice(0, n) : [])

/** Normalise whatever the model produced into a FinalReport. */
export function normalizeReport(raw: unknown, fallbackReply = ''): FinalReport {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const opts = Array.isArray(r.options) ? r.options : []
  const claims = Array.isArray(r.claims) ? r.claims : []
  const ref = (r.referral && typeof r.referral === 'object' ? r.referral : {}) as Record<string, unknown>
  return {
    reply: str(r.reply, 6000) || fallbackReply,
    profile: strs(r.profile),
    options: opts.slice(0, 4).map((o) => {
      const x = (o ?? {}) as Record<string, unknown>
      return { title: str(x.title, 200), why: str(x.why, 800), steps: strs(x.steps, 8), evidence: strs(x.evidence, 10) }
    }),
    claims: claims.slice(0, 14).map((c) => {
      const x = (c ?? {}) as Record<string, unknown>
      return { text: str(x.text, 600), evidence: strs(x.evidence, 8), critical: x.critical !== false }
    }),
    uncertain: strs(r.uncertain),
    advisor_questions: strs(r.advisor_questions),
    referral: { needed: Boolean(ref.needed), office: str(ref.office, 200), reason: str(ref.reason, 600) },
  }
}

/** Fallback when the budget ends before a final answer: keep what was found, flag the gap. */
export function emergencyReport(ctx: RunContext, reason: string): FinalReport {
  return {
    reply: `I ran out of research budget before finishing (${reason}). Please bring the open questions below to an advisor.`,
    profile: [],
    options: [],
    claims: [],
    uncertain: [`Research stopped early: ${reason}`],
    advisor_questions: [],
    referral: { needed: true, office: 'college advising office', reason: 'incomplete automated research' },
  }
}

/** Budget exhaustion or unrecoverable malformed output: end with a conservative report instead of failing the run. */
export function isBudgetStop(error: unknown) {
  return error instanceof BudgetExceeded || error instanceof MalformedOutput
}
