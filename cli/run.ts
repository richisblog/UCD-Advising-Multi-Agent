// Headless experiment runner (same core as the Harness plugin).
//
//   npm run experiment -- --split dev --repeats 1 --env-file ../path/.env
//   npm run experiment -- --split heldout --repeats 2 --seed 2026 --grade --name main
//
// Options: --split dev|heldout|all  --scenarios ID,ID  --conditions A,B  --repeats N
//          --seed N  --concurrency N  --grade  --judge-model NAME  --model NAME  --name NAME
//          --budget-tokens N --budget-calls N  --results DIR  --env-file FILE

import { execute, newRun, schedule } from '../src/core/experiment.js'
import { grade } from '../src/core/grader.js'
import { PROMPT_VERSION } from '../src/core/prompts.js'
import type { ExperimentMeta } from '../src/core/store.js'
import { defaultBudget, type Condition } from '../src/core/types.js'
import { args, deepseek, loadAll, loadEnv } from './common.js'

const opt = args()
loadEnv(opt['env-file'])
const { corpus, scenarios, store } = loadAll(opt)
const split = opt.split ?? 'dev'
const ids = opt.scenarios
  ? opt.scenarios.split(',')
  : scenarios.filter((s) => split === 'all' || s.split === split).map((s) => s.id)
const conditions = (opt.conditions ?? 'A,B').split(',') as Condition[]
const repeats = Number(opt.repeats ?? 1)
const seed = Number(opt.seed ?? 2026)
const concurrency = Math.max(1, Number(opt.concurrency ?? 2))
const budget = {
  ...defaultBudget,
  ...(opt['budget-tokens'] ? { tokens: Number(opt['budget-tokens']) } : {}),
  ...(opt['budget-calls'] ? { modelCalls: Number(opt['budget-calls']) } : {}),
}
const agent = deepseek(opt.model)
const judge = opt['judge-model'] ? deepseek(opt['judge-model']) : agent

const plan = schedule(ids, repeats, seed).filter((p) => conditions.includes(p.condition))
const id = opt.id ?? `${new Date().toISOString().slice(0, 10)}-${opt.name ?? split}-${Date.now().toString(36).slice(-4)}`
const meta: ExperimentMeta = {
  id,
  name: opt.name ?? split,
  createdAt: Date.now(),
  seed,
  repeats,
  scenarioIds: ids,
  studentMode: 'simulated',
  model: agent.info,
  budget,
  promptVersion: PROMPT_VERSION,
  corpusVersion: corpus.version,
  planned: plan.length,
  status: 'running',
}
await store.saveMeta(meta)
console.log(`experiment ${id}: ${plan.length} runs (${ids.length} scenarios × ${repeats} × ${conditions.join('/')}), model ${agent.info.id}`)

const controller = new AbortController()
process.on('SIGINT', () => {
  console.log('\nstopping…')
  controller.abort()
})

let next = 0
let done = 0
async function worker() {
  while (next < plan.length && !controller.signal.aborted) {
    const p = plan[next++]!
    const scenario = scenarios.find((s) => s.id === p.scenarioId)!
    const run = newRun({ experimentId: id, ...p, model: agent.info, corpus, budget })
    await execute({ run, corpus, model: agent.model, opening: scenario.opening, scenario, signal: controller.signal })
    if (opt.grade && run.status === 'done') {
      try {
        run.score = await grade(run, scenario, corpus, judge.model, judge.info.id, controller.signal)
      } catch (e) {
        console.warn(`  grading failed: ${e}`)
      }
    }
    await store.saveRun(run)
    done++
    const s = run.score ? ` checklist ${run.score.checklistPct.toFixed(0)}% unsupported ${run.score.unsupportedCritical}` : ''
    console.log(
      `[${done}/${plan.length}] ${run.scenarioId} ${run.condition}${run.repeat} ${run.status}${run.error ? ` (${run.error})` : ''} · ${run.usage.tokens} tok · ${run.usage.modelCalls} calls · ${run.usage.clarifications} asks · ${(run.usage.wallMs / 1000).toFixed(0)}s · stop=${run.stop ?? '-'}${s}`,
    )
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))
meta.status = controller.signal.aborted ? 'stopped' : 'done'
await store.saveMeta(meta)
console.log(`saved to ${store.dir(id)}`)
