// Paired analysis + markdown report for one experiment.
//   npm run analyze -- --id <experimentId> [--human scores.json] [--blind]
// --blind also writes blind-review.json for human scorers.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agreement, analyze, conditionOf, type HumanScore } from '../src/core/analysis.js'
import { blindView } from '../src/core/grader.js'
import { args, loadAll } from './common.js'
import { readFileSync } from 'node:fs'

const opt = args()
const { scenarios, store } = loadAll(opt)
const id = opt.id ?? (await store.listExperiments())[0]?.id
if (!id) throw new Error('No experiment found; pass --id.')
const runs = await store.loadRuns(id)
let human = await store.loadHuman(id)
if (opt.human) {
  const incoming = JSON.parse(readFileSync(opt.human, 'utf8')) as HumanScore[]
  human = [...human.filter((h) => !incoming.some((x) => x.rater === h.rater && x.blindId === h.blindId)), ...incoming].filter((h) =>
    conditionOf(runs, h.blindId),
  )
  await store.saveHuman(id, human)
}
const a = analyze(runs, scenarios, id)
const agree = agreement(human, runs)
const dir = store.dir(id)
await writeFile(join(dir, 'analysis.json'), JSON.stringify({ analysis: a, agreement: agree }, null, 1))

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—')
const pf = (p: number) => (!Number.isFinite(p) ? '—' : p < 0.001 ? '<0.001' : p.toFixed(3))
const lines: string[] = []
lines.push(`# Pathfinder Advising Lab — ${id}`, '')
lines.push(
  `Runs: ${a.runs.total} total, ${a.runs.done} done, ${a.runs.scored} scored, ${a.runs.failed} failed. Paired scenarios: ${a.paired[0]?.n ?? 0}. Repeats averaged within scenario; B − A differences; 95% bootstrap CI; two-sided sign-flip permutation p.`,
  '',
)
lines.push('| Metric | A single | B multi | B − A | 95% CI | p | dz | B better / tie / worse |', '|---|---:|---:|---:|---|---:|---:|---|')
for (const r of a.paired)
  lines.push(
    `| ${r.label} | ${f(r.meanA)} | ${f(r.meanB)} | ${f(r.diff)} | [${f(r.ci[0])}, ${f(r.ci[1])}] | ${pf(r.p)} | ${f(r.dz, 2)} | ${r.better === 'neutral' ? '—' : `${r.wins} / ${r.ties} / ${r.losses}`} |`,
  )
lines.push('', '## By category (checklist %)', '', '| Category | n | A | B | B − A |', '|---|---:|---:|---:|---:|')
for (const c of a.byCategory) lines.push(`| ${c.category} | ${c.n} | ${f(c.A)} | ${f(c.B)} | ${f(c.diff)} |`)
lines.push('', '## Per scenario', '', '| Scenario | Category | A checklist | B checklist | A tokens | B tokens | A unsupported | B unsupported |', '|---|---|---:|---:|---:|---:|---:|---:|')
for (const s of a.perScenario)
  lines.push(
    `| ${s.scenarioId} | ${s.category} | ${f(s.A?.checklistPct ?? NaN)} | ${f(s.B?.checklistPct ?? NaN)} | ${f(s.A?.tokens ?? NaN, 0)} | ${f(s.B?.tokens ?? NaN, 0)} | ${f(s.A?.unsupportedCritical ?? NaN)} | ${f(s.B?.unsupportedCritical ?? NaN)} |`,
  )
lines.push(
  '',
  `Run-to-run spread of checklist % (mean |rep max − min|): A ${f(a.consistency.A)}, B ${f(a.consistency.B)}.`,
  `Handoffs in B: ${a.handoffs.total} (${a.handoffs.accepted} accepted), ${f(a.handoffs.perRun, 2)} per run.`,
)
if (agree.length) {
  lines.push('', '## Scorer agreement', '', '| Pair | n items | % agree | κ | weighted κ |', '|---|---:|---:|---:|---:|')
  for (const g of agree) lines.push(`| ${g.a} vs ${g.b} | ${g.n} | ${f(100 * g.agreement)} | ${f(g.kappa, 2)} | ${f(g.weighted, 2)} |`)
}
await writeFile(join(dir, 'report.md'), lines.join('\n') + '\n')
console.log(lines.join('\n'))

if (opt.blind) {
  const done = runs.filter((r) => r.report && r.status === 'done').sort((x, y) => x.blindId.localeCompare(y.blindId))
  await writeFile(
    join(dir, 'blind-review.json'),
    JSON.stringify(
      {
        experimentId: id,
        instructions: 'Score every checklist item 0 / 0.5 / 1 per summary. Return [{"blindId","rater","items":[{"id","score"}]}].',
        cases: scenarios.filter((s) => done.some((r) => r.scenarioId === s.id)),
        summaries: done.map((r) => ({ blindId: r.blindId, scenarioId: r.scenarioId, summary: blindView(r.report!) })),
      },
      null,
      1,
    ),
  )
  console.log(`\nblind review package: ${join(dir, 'blind-review.json')}`)
}
