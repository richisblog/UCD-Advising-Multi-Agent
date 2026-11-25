import type { Model } from './llm.js'
import { runMulti, MULTI_VERSION } from './multi.js'
import type { Corpus } from './retrieval.js'
import { makeContext, type Student } from './runtime.js'
import { runSingle, SINGLE_VERSION } from './single.js'
import { simulatedStudent } from './student.js'
import type { Budget, Condition, RunRecord, Scenario } from './types.js'

export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface PlannedRun {
  scenarioId: string
  condition: Condition
  repeat: number
  order: number
  blindId: string
}

/**
 * Interleaved randomized schedule: scenarios × repeats, each pair (A,B) in a
 * random order, pairs shuffled — so time-of-day/provider drift hits both
 * conditions evenly.
 */
export function schedule(scenarioIds: string[], repeats: number, seed: number): PlannedRun[] {
  const rand = rng(seed)
  const pairs: { scenarioId: string; repeat: number; first: Condition }[] = []
  for (const scenarioId of scenarioIds)
    for (let r = 1; r <= repeats; r++) pairs.push({ scenarioId, repeat: r, first: rand() < 0.5 ? 'A' : 'B' })
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[pairs[i], pairs[j]] = [pairs[j]!, pairs[i]!]
  }
  const out: PlannedRun[] = []
  const used = new Set<string>()
  const blind = () => {
    let id: string
    do id = Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0')
    while (used.has(id))
    used.add(id)
    return id
  }
  for (const p of pairs) {
    const second: Condition = p.first === 'A' ? 'B' : 'A'
    for (const condition of [p.first, second])
      out.push({ scenarioId: p.scenarioId, repeat: p.repeat, condition, order: out.length + 1, blindId: blind() })
  }
  return out
}

export function newRun(opts: {
  experimentId: string
  scenarioId: string
  condition: Condition
  repeat: number
  order: number
  blindId: string
  model: { provider: string; id: string }
  corpus: Corpus
  budget: Budget
}): RunRecord {
  return {
    id: `${opts.experimentId}-${String(opts.order).padStart(3, '0')}-${opts.scenarioId}-${opts.condition}${opts.repeat}`,
    experimentId: opts.experimentId,
    scenarioId: opts.scenarioId,
    condition: opts.condition,
    repeat: opts.repeat,
    order: opts.order,
    blindId: opts.blindId,
    model: opts.model,
    promptVersion: opts.condition === 'A' ? SINGLE_VERSION : MULTI_VERSION,
    corpusVersion: opts.corpus.version,
    budget: structuredClone(opts.budget),
    startedAt: Date.now(),
    status: 'running',
    trace: [],
    calls: [],
    retrieved: {},
    disclosed: [],
    usage: {
      tokens: 0,
      input: 0,
      output: 0,
      modelCalls: 0,
      toolCalls: 0,
      clarifications: 0,
      specialistCalls: 0,
      repeatedRetrievals: 0,
      modelMs: 0,
      wallMs: 0,
      simulatorTokens: 0,
      redundantActions: 0,
      checklistUpdates: 0,
    },
  }
}

/** Execute one condition on one opening. `student` defaults to the scripted simulator. */
export async function execute(opts: {
  run: RunRecord
  corpus: Corpus
  model: Model
  opening: string
  student?: Student
  scenario?: Scenario
  simulator?: Model
  signal: AbortSignal
  onUpdate?: (run: RunRecord) => void
}): Promise<RunRecord> {
  const { run } = opts
  const student =
    opts.student ??
    (opts.scenario ? simulatedStudent(opts.scenario, opts.simulator ?? opts.model, run) : undefined)
  if (!student) throw new Error('A student source is required.')
  const ctx = makeContext(run, opts.corpus, opts.model, student, opts.opening, opts.signal, opts.onUpdate)
  try {
    if (run.condition === 'A') await runSingle(ctx)
    else await runMulti(ctx)
    run.status = 'done'
  } catch (error) {
    if (opts.signal.aborted) {
      run.status = 'cancelled'
      run.error = 'cancelled'
    } else {
      run.status = 'failed'
      run.error = error instanceof Error ? error.message : String(error)
    }
  } finally {
    run.endedAt = Date.now()
    run.usage.wallMs = run.endedAt - run.startedAt
    opts.onUpdate?.(run)
  }
  return run
}
