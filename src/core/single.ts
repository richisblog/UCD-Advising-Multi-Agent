import { estimateTokens, type ChatMessage } from './llm.js'
import { processChecklist } from './checklist.js'
import { PROMPT_VERSION, singleSystem } from './prompts.js'
import {
  emergencyReport,
  emit,
  isBudgetStop,
  normalizeReport,
  parseUnit,
  toolAsk,
  toolCourse,
  toolSearch,
  type RunContext,
} from './runtime.js'
import type { Level } from './types.js'

const FORCE_FINAL =
  'SYSTEM: research is closed — the budget is nearly used. Do not search, ask or delegate. Reply ONLY with {"action": "final", "report": {...}} now, using what you already know and listing the gaps.'

export const SINGLE_VERSION = `${PROMPT_VERSION}/A`

const LEVELS: Level[] = ['university', 'college', 'department']

/**
 * Condition A — one ReAct-style agent with every responsibility and the whole
 * evidence collection. Same tools, budget and report schema as Condition B.
 */
export async function runSingle(ctx: RunContext): Promise<void> {
  const { run, budget, ledger } = ctx
  const system = singleSystem(budget.clarifications, budget.checklist)
  const messages: ChatMessage[] = [{ role: 'user', content: `STUDENT (opening message): ${ctx.opening}` }]
  emit(ctx, { kind: 'student', text: ctx.opening })

  const contextSize = () => (estimateTokens(system) + messages.reduce((n, m) => n + estimateTokens(m.content), 0)) * ledger.inputRatio
  // keep room for the final answer plus one retry if the model does not comply at once
  const mustFinish = () =>
    ledger.remainingCalls <= 3 || ledger.remainingTokens < 2 * (contextSize() + budget.finalOutputTokens) + 800
  let forced = false

  try {
    for (let step = 0; step < budget.modelCalls; step++) {
      if (!forced && mustFinish()) {
        forced = true
        messages.push({ role: 'user', content: FORCE_FINAL })
        emit(ctx, { kind: 'limit', detail: 'forced final answer (budget)' })
      }
      const out = await ledger.json<Record<string, unknown>>(
        'advisor',
        `step-${step + 1}`,
        system,
        messages,
        budget.finalOutputTokens,
      )
      messages.push({ role: 'assistant', content: JSON.stringify(out) })
      if (typeof out.thought === 'string' && out.thought) emit(ctx, { kind: 'thought', agent: 'advisor', text: out.thought.slice(0, 600) })
      const action = String(out.action ?? '')
      const checklist = processChecklist(ctx, 'advisor', out, action, step + 1, forced || mustFinish())
      let observation: string
      if (forced && action !== 'final') {
        // research is closed: never execute another action, insist on the answer
        if (out.report) {
          run.report = normalizeReport(out.report)
          run.stop = 'forced-final'
          return
        }
        messages.push({ role: 'user', content: FORCE_FINAL })
        continue
      }
      if (action === 'final') {
        run.report = normalizeReport(out.report)
        run.stop = 'final'
        return
      } else if (action === 'ask_student') {
        observation = await toolAsk(ctx, 'advisor', String(out.question ?? ''))
      } else if (action === 'search') {
        const unit = parseUnit(out.unit)
        const level = LEVELS.find((l) => l === out.level)
        observation = toolSearch(ctx, 'advisor', String(out.query ?? ''), {
          units: unit ? [unit] : undefined,
          levels: level ? [level] : undefined,
        })
      } else if (action === 'get_course') {
        observation = toolCourse(ctx, 'advisor', String(out.code ?? ''))
      } else {
        observation = `OBSERVATION: unknown action "${action}". Use ask_student, search, get_course or final.`
      }
      messages.push({ role: 'user', content: checklist ? `${observation}\n\n${checklist}` : observation })
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
