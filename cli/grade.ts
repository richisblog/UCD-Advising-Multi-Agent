// Grade (or re-grade with --force) every finished run of an experiment.
//   npm run grade -- --id <experimentId> [--force] [--judge-model deepseek-reasoner]

import { grade } from '../src/core/grader.js'
import { args, deepseek, loadAll, loadEnv } from './common.js'

const opt = args()
loadEnv(opt['env-file'])
const { corpus, scenarios, store } = loadAll(opt)
const id = opt.id ?? (await store.listExperiments())[0]?.id
if (!id) throw new Error('No experiment found; pass --id.')
const judge = deepseek(opt['judge-model'])
const signal = new AbortController().signal
let n = 0
for (const run of await store.loadRuns(id)) {
  if (run.status !== 'done' || (run.score && !opt.force)) continue
  const scenario = scenarios.find((s) => s.id === run.scenarioId)
  if (!scenario) continue
  run.score = await grade(run, scenario, corpus, judge.model, judge.info.id, signal)
  await store.saveRun(run)
  n++
  console.log(`${run.id}: ${run.score.checklistPct.toFixed(1)}%  unsupported-critical ${run.score.unsupportedCritical}`)
}
console.log(`graded ${n} runs in ${id}`)
