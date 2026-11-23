import { agreement, analyze, conditionOf, type HumanScore } from './analysis.js'
import { execute, newRun, schedule } from './experiment.js'
import { blindView, grade } from './grader.js'
import type { Model } from './llm.js'
import { PROMPT_VERSION } from './prompts.js'
import type { Corpus } from './retrieval.js'
import type { Student } from './runtime.js'
import type { ExperimentMeta, LabStore } from './store.js'
import { defaultBudget, type Budget, type Condition, type RunRecord, type Scenario } from './types.js'

export interface ModelInfo {
  provider: string
  id: string
}
export interface LabDeps {
  corpus: Corpus
  scenarios: Scenario[]
  store: LabStore
  /** null when Harness has no usable model selection */
  model: () => { model: Model; info: ModelInfo } | null
  log?: (message: string) => void
}

export interface PendingQuestion {
  runId: string
  condition: Condition
  question: string
  askedAt: number
}

/**
 * Orchestrates consultations and experiments for the Host (and the CLI).
 * One experiment at a time; consultations can run A and B side by side.
 */
export class Lab {
  private pending = new Map<string, PendingQuestion & { resolve: (text: string) => void }>()
  private live = new Map<string, RunRecord>()
  private job?: { experimentId: string; controller: AbortController; done: Promise<void>; progress: number; planned: number }
  private consult = new Map<string, AbortController>()
  private dirty = new Set<string>()
  private saving = Promise.resolve()

  constructor(private readonly deps: LabDeps) {}

  get busy() {
    return Boolean(this.job)
  }

  private persist(run: RunRecord) {
    this.live.set(run.id, run)
    this.dirty.add(run.id)
    this.saving = this.saving
      .then(async () => {
        if (!this.dirty.delete(run.id)) return
        await this.deps.store.saveRun(run)
      })
      .catch((e) => this.deps.log?.(`save failed: ${e}`))
  }

  private interactiveStudent(runId: string, condition: Condition): Student {
    return (question, signal) =>
      new Promise((resolve, reject) => {
        const abort = () => {
          this.pending.delete(runId)
          reject(new DOMException('cancelled', 'AbortError'))
        }
        if (signal.aborted) return abort()
        signal.addEventListener('abort', abort, { once: true })
        this.pending.set(runId, {
          runId,
          condition,
          question,
          askedAt: Date.now(),
          resolve: (text) => {
            signal.removeEventListener('abort', abort)
            this.pending.delete(runId)
            resolve({ text, facts: [] })
          },
        })
        const run = this.live.get(runId)
        if (run) this.persist(run)
      })
  }

  /** Researcher/user reply to a pending question. Manual mode may pass fact ids for scoring. */
  answer(runId: string, text: string, facts: string[] = []) {
    const p = this.pending.get(runId)
    if (!p) throw new Error('This run is not waiting for an answer.')
    const run = this.live.get(runId)
    if (run) for (const f of facts) if (!run.disclosed.includes(f)) run.disclosed.push(f)
    p.resolve(text.slice(0, 4000))
  }

  pendingQuestions(): PendingQuestion[] {
    return [...this.pending.values()].map(({ resolve: _r, ...q }) => q)
  }

  // --------------------------------------------------------------- consult

  startConsult(opening: string, conditions: Condition[], budget: Partial<Budget> = {}) {
    const m = this.deps.model()
    if (!m) throw new Error('Choose a DeepSeek model in Harness settings first.')
    if (!opening.trim()) throw new Error('Type a question first.')
    const experimentId = 'consult'
    const ids: string[] = []
    const stamp = Date.now().toString(36)
    conditions.forEach((condition, i) => {
      const run = newRun({
        experimentId,
        scenarioId: `live-${stamp}`,
        condition,
        repeat: 1,
        order: Date.now() % 1_000_000 + i,
        blindId: `${stamp}${i}`,
        model: m.info,
        corpus: this.deps.corpus,
        budget: { ...defaultBudget, ...budget },
      })
      ids.push(run.id)
      const controller = new AbortController()
      this.consult.set(run.id, controller)
      this.persist(run)
      void execute({
        run,
        corpus: this.deps.corpus,
        model: m.model,
        opening,
        student: this.interactiveStudent(run.id, condition),
        signal: controller.signal,
        onUpdate: (r) => this.persist(r),
      }).finally(() => this.consult.delete(run.id))
    })
    return ids
  }

  // ------------------------------------------------------------ experiment

  async startExperiment(opts: {
    name: string
    scenarioIds: string[]
    repeats: number
    seed: number
    studentMode: 'simulated' | 'manual'
    budget?: Partial<Budget>
    autoGrade: boolean
  }) {
    if (this.job) throw new Error('An experiment is already running.')
    const m = this.deps.model()
    if (!m) throw new Error('Choose a DeepSeek model in Harness settings first.')
    const scenarios = opts.scenarioIds.map((id) => {
      const s = this.deps.scenarios.find((x) => x.id === id)
      if (!s) throw new Error(`Unknown scenario ${id}`)
      return s
    })
    if (!scenarios.length) throw new Error('Pick at least one scenario.')
    const budget = { ...defaultBudget, ...opts.budget }
    const id = `${new Date().toISOString().slice(0, 10)}-${(opts.name || 'exp').replace(/[^a-z0-9-]+/gi, '-').slice(0, 30)}-${Date.now().toString(36).slice(-4)}`
    const plan = schedule(opts.scenarioIds, opts.repeats, opts.seed)
    const meta: ExperimentMeta = {
      id,
      name: opts.name || id,
      createdAt: Date.now(),
      seed: opts.seed,
      repeats: opts.repeats,
      scenarioIds: opts.scenarioIds,
      studentMode: opts.studentMode,
      model: m.info,
      budget,
      promptVersion: PROMPT_VERSION,
      corpusVersion: this.deps.corpus.version,
      planned: plan.length,
      status: 'running',
    }
    await this.deps.store.saveMeta(meta)
    this.launch(meta, plan, opts.studentMode, opts.autoGrade, new Set())
    return id
  }

  /** Re-run every planned run of an experiment that is missing or did not finish (same seed → same schedule and blind ids). */
  async resumeExperiment(experimentId: string, autoGrade = true) {
    if (this.job) throw new Error('An experiment is already running.')
    const meta = (await this.deps.store.listExperiments()).find((e) => e.id === experimentId)
    if (!meta) throw new Error('Experiment not found.')
    const plan = schedule(meta.scenarioIds, meta.repeats, meta.seed)
    const done = new Set((await this.runs(experimentId)).filter((r) => r.status === 'done').map((r) => `${r.scenarioId}|${r.condition}|${r.repeat}`))
    const todo = plan.filter((p) => !done.has(`${p.scenarioId}|${p.condition}|${p.repeat}`))
    if (!todo.length) throw new Error('Every planned run already finished.')
    meta.status = 'running'
    meta.error = undefined
    await this.deps.store.saveMeta(meta)
    this.launch(meta, todo, meta.studentMode, autoGrade, done)
    return todo.length
  }

  private launch(meta: ExperimentMeta, plan: ReturnType<typeof schedule>, studentMode: 'simulated' | 'manual', autoGrade: boolean, _done: Set<string>) {
    const m = this.deps.model()
    if (!m) throw new Error('Choose a DeepSeek model in Harness settings first.')
    const id = meta.id
    const budget = { ...defaultBudget, ...(meta.budget as Partial<Budget>) }
    const controller = new AbortController()
    const job = { experimentId: id, controller, progress: 0, planned: plan.length, done: Promise.resolve() }
    const transient = (e?: string) => /TRANSPORT|RATE_LIMIT|OVERLOAD|TIMEOUT|ABORTED|network|fetch failed|HTTP 5\d\d|HTTP 429/i.test(e ?? '')
    job.done = (async () => {
      let consecutiveNetwork = 0
      for (const p of plan) {
        if (controller.signal.aborted) break
        const scenario = this.deps.scenarios.find((s) => s.id === p.scenarioId)
        if (!scenario) continue
        let run = newRun({ experimentId: id, ...p, model: m.info, corpus: this.deps.corpus, budget })
        for (let attempt = 0; attempt < 3; attempt++) {
          run = newRun({ experimentId: id, ...p, model: m.info, corpus: this.deps.corpus, budget })
          this.persist(run)
          await execute({
            run,
            corpus: this.deps.corpus,
            model: m.model,
            opening: scenario.opening,
            scenario,
            student: studentMode === 'manual' ? this.interactiveStudent(run.id, run.condition) : undefined,
            signal: controller.signal,
            onUpdate: (r) => this.persist(r),
          })
          if (run.status !== 'failed' || !transient(run.error) || controller.signal.aborted) break
          this.deps.log?.(`run ${run.id} hit a transient provider error (${run.error}); retrying`)
          await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
        }
        if (run.status === 'failed' && /authoriz|credential|HTTP 401|HTTP 403/i.test(run.error ?? '')) {
          // a provider auth failure fails every later run the same way: stop instead of filling the log
          this.persist(run)
          meta.error = run.error
          controller.abort()
          break
        }
        consecutiveNetwork = run.status === 'failed' && transient(run.error) ? consecutiveNetwork + 1 : 0
        if (consecutiveNetwork >= 2) {
          this.persist(run)
          meta.error = `Paused after repeated network failures (${run.error}). Use "Resume" to continue.`
          controller.abort()
          break
        }
        if (autoGrade && run.status === 'done' && !controller.signal.aborted) {
          try {
            run.score = await grade(run, scenario, this.deps.corpus, m.model, m.info.id, controller.signal)
          } catch (e) {
            this.deps.log?.(`grading ${run.id} failed: ${e}`)
          }
        }
        this.persist(run)
        job.progress += 1
      }
      meta.status = controller.signal.aborted ? 'stopped' : 'done'
      await this.deps.store.saveMeta(meta)
    })()
      .catch((e) => this.deps.log?.(`experiment ${id} failed: ${e}`))
      .finally(() => {
        this.job = undefined
      })
    this.job = job
  }

  stop(runId?: string) {
    if (runId && this.consult.has(runId)) return this.consult.get(runId)!.abort()
    this.job?.controller.abort()
    for (const c of this.consult.values()) c.abort()
  }

  jobStatus() {
    return this.job ? { experimentId: this.job.experimentId, progress: this.job.progress, planned: this.job.planned } : null
  }

  // ---------------------------------------------------------------- results

  async runs(experimentId: string) {
    const stored = await this.deps.store.loadRuns(experimentId)
    return stored.map((r) => this.live.get(r.id) ?? r)
  }

  async gradeAll(experimentId: string, force = false) {
    if (this.job) throw new Error('Wait for the running experiment to finish.')
    const m = this.deps.model()
    if (!m) throw new Error('Choose a DeepSeek model in Harness settings first.')
    const controller = new AbortController()
    let n = 0
    for (const run of await this.runs(experimentId)) {
      if (run.status !== 'done' || (run.score && !force)) continue
      const scenario = this.deps.scenarios.find((s) => s.id === run.scenarioId)
      if (!scenario) continue
      run.score = await grade(run, scenario, this.deps.corpus, m.model, m.info.id, controller.signal)
      await this.deps.store.saveRun(run)
      this.live.set(run.id, run)
      n++
    }
    return n
  }

  async analysis(experimentId: string) {
    const runs = await this.runs(experimentId)
    const human = await this.deps.store.loadHuman(experimentId)
    return { analysis: analyze(runs, this.deps.scenarios, experimentId), agreement: agreement(human, runs), humanCount: human.length }
  }

  /** Blind package: case + anonymous summaries + checklist; no condition, trace or agent names. */
  async exportBlind(experimentId: string) {
    const runs = (await this.runs(experimentId)).filter((r) => r.report && r.status === 'done')
    const shuffled = [...runs].sort((a, b) => a.blindId.localeCompare(b.blindId))
    return {
      experimentId,
      instructions:
        'Score each checklist item 0 / 0.5 / 1 for each summary without trying to infer which system produced it. Return [{"blindId","rater","items":[{"id","score"}]}].',
      cases: this.deps.scenarios
        .filter((s) => runs.some((r) => r.scenarioId === s.id))
        .map((s) => ({ id: s.id, title: s.title, opening: s.opening, facts: s.facts, checklist: s.checklist, reference: s.reference })),
      summaries: shuffled.map((r) => ({ blindId: r.blindId, scenarioId: r.scenarioId, summary: blindView(r.report!) })),
    }
  }

  async importHuman(experimentId: string, scores: HumanScore[]) {
    const runs = await this.runs(experimentId)
    const known = scores.filter((s) => conditionOf(runs, s.blindId))
    const existing = await this.deps.store.loadHuman(experimentId)
    const key = (s: HumanScore) => `${s.rater}|${s.blindId}`
    const merged = new Map(existing.map((s) => [key(s), s]))
    for (const s of known) merged.set(key(s), s)
    await this.deps.store.saveHuman(experimentId, [...merged.values()])
    return known.length
  }
}
