import { rng } from './experiment.js'
import type { Category, Condition, RunRecord, Scenario } from './types.js'

// Paired analysis of Condition B − Condition A. Repeats are averaged within
// each scenario first, so the unit of analysis is the scenario (n = #cases).

export const METRICS = [
  { key: 'checklistPct', label: 'Checklist satisfied (%)', labelZh: '清单满足率 (%)', better: 'higher', primary: true },
  { key: 'unsupportedCritical', label: 'Unsupported critical claims', labelZh: '无依据关键论断', better: 'lower' },
  { key: 'criticalElicitedPct', label: 'Critical facts elicited (%)', labelZh: '关键事实获取率 (%)', better: 'higher' },
  { key: 'invalidCitations', label: 'Invalid citations', labelZh: '无效引用', better: 'lower' },
  { key: 'validCitations', label: 'Valid citations', labelZh: '有效引用', better: 'higher' },
  { key: 'repeatedRetrievals', label: 'Repeated retrievals', labelZh: '重复检索', better: 'lower' },
  { key: 'clarifications', label: 'Clarification turns', labelZh: '追问次数', better: 'neutral' },
  { key: 'tokens', label: 'Tokens (in+out)', labelZh: 'Tokens（输入+输出）', better: 'lower' },
  { key: 'modelCalls', label: 'Model calls', labelZh: '模型调用', better: 'lower' },
  { key: 'toolCalls', label: 'Tool calls', labelZh: '工具调用', better: 'lower' },
  { key: 'modelSec', label: 'Model time (s)', labelZh: '模型耗时 (秒)', better: 'lower' },
  { key: 'wallSec', label: 'Elapsed time (s)', labelZh: '总耗时 (秒)', better: 'lower' },
] as const
export type MetricKey = (typeof METRICS)[number]['key']

export function metricsOf(run: RunRecord): Record<MetricKey, number> | null {
  const s = run.score
  if (!s || run.status !== 'done') return null
  return {
    checklistPct: s.checklistPct,
    unsupportedCritical: s.unsupportedCritical,
    criticalElicitedPct: s.criticalFactsTotal ? (100 * s.criticalFactsElicited) / s.criticalFactsTotal : 100,
    invalidCitations: s.invalidCitations,
    validCitations: s.validCitations,
    repeatedRetrievals: run.usage.repeatedRetrievals,
    clarifications: run.usage.clarifications,
    tokens: run.usage.tokens,
    modelCalls: run.usage.modelCalls,
    toolCalls: run.usage.toolCalls,
    modelSec: run.usage.modelMs / 1000,
    wallSec: run.usage.wallMs / 1000,
  }
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
const sd = (xs: number[]) => {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

/** Exact sign-flip permutation test (n ≤ 18) or 20k Monte Carlo flips, two-sided. */
export function signFlipP(diffs: number[], seed = 7): number {
  const n = diffs.length
  if (!n) return NaN
  const obs = Math.abs(diffs.reduce((a, b) => a + b, 0))
  let extreme = 0
  let total = 0
  if (n <= 18) {
    for (let mask = 0; mask < 1 << n; mask++) {
      let s = 0
      for (let i = 0; i < n; i++) s += mask & (1 << i) ? -diffs[i]! : diffs[i]!
      if (Math.abs(s) >= obs - 1e-9) extreme++
      total++
    }
  } else {
    const r = rng(seed)
    for (total = 0; total < 20000; total++) {
      let s = 0
      for (const d of diffs) s += r() < 0.5 ? -d : d
      if (Math.abs(s) >= obs - 1e-9) extreme++
    }
  }
  return extreme / total
}

export function bootstrapCI(diffs: number[], seed = 11, reps = 10000): [number, number] {
  if (diffs.length < 2) return [NaN, NaN]
  const r = rng(seed)
  const means: number[] = []
  for (let k = 0; k < reps; k++) {
    let s = 0
    for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(r() * diffs.length)]!
    means.push(s / diffs.length)
  }
  means.sort((a, b) => a - b)
  return [means[Math.floor(0.025 * reps)]!, means[Math.floor(0.975 * reps)]!]
}

export interface PairedRow {
  key: MetricKey
  label: string
  labelZh: string
  better: string
  n: number
  meanA: number
  meanB: number
  diff: number
  ci: [number, number]
  p: number
  dz: number
  wins: number
  ties: number
  losses: number
}

export interface Analysis {
  experimentId: string
  runs: { total: number; done: number; scored: number; failed: number }
  scenarios: string[]
  perScenario: {
    scenarioId: string
    category: Category
    A: Record<MetricKey, number> | null
    B: Record<MetricKey, number> | null
    spreadA: number
    spreadB: number
  }[]
  paired: PairedRow[]
  byCategory: { category: Category; n: number; A: number; B: number; diff: number }[]
  consistency: { A: number; B: number }
  handoffs: { total: number; accepted: number; perRun: number }
}

export function analyze(runs: RunRecord[], scenarios: Scenario[], experimentId = runs[0]?.experimentId ?? ''): Analysis {
  const byId = new Map(scenarios.map((s) => [s.id, s]))
  const cell = new Map<string, Record<MetricKey, number>[]>()
  for (const run of runs) {
    const m = metricsOf(run)
    if (!m) continue
    const k = `${run.scenarioId}|${run.condition}`
    if (!cell.has(k)) cell.set(k, [])
    cell.get(k)!.push(m)
  }
  const avg = (list: Record<MetricKey, number>[] | undefined) => {
    if (!list?.length) return null
    const out = {} as Record<MetricKey, number>
    for (const { key } of METRICS) out[key] = mean(list.map((m) => m[key]))
    return out
  }
  const spread = (list: Record<MetricKey, number>[] | undefined) =>
    list && list.length > 1 ? Math.max(...list.map((m) => m.checklistPct)) - Math.min(...list.map((m) => m.checklistPct)) : NaN
  const ids = [...new Set(runs.map((r) => r.scenarioId))].sort()
  const perScenario = ids.map((id) => ({
    scenarioId: id,
    category: byId.get(id)?.category ?? ('unclear-interests' as Category),
    A: avg(cell.get(`${id}|A`)),
    B: avg(cell.get(`${id}|B`)),
    spreadA: spread(cell.get(`${id}|A`)),
    spreadB: spread(cell.get(`${id}|B`)),
  }))
  const complete = perScenario.filter((s) => s.A && s.B)
  const paired: PairedRow[] = METRICS.map(({ key, label, labelZh, better }) => {
    const a = complete.map((s) => s.A![key])
    const b = complete.map((s) => s.B![key])
    const d = b.map((x, i) => x - a[i]!)
    const sign = better === 'lower' ? -1 : 1
    return {
      key,
      label,
      labelZh,
      better,
      n: d.length,
      meanA: mean(a),
      meanB: mean(b),
      diff: mean(d),
      ci: bootstrapCI(d),
      p: signFlipP(d),
      dz: mean(d) / sd(d),
      wins: d.filter((x) => sign * x > 1e-9).length,
      ties: d.filter((x) => Math.abs(x) <= 1e-9).length,
      losses: d.filter((x) => sign * x < -1e-9).length,
    }
  })
  const cats = [...new Set(complete.map((s) => s.category))]
  const byCategory = cats.map((category) => {
    const rows = complete.filter((s) => s.category === category)
    const A = mean(rows.map((s) => s.A!.checklistPct))
    const B = mean(rows.map((s) => s.B!.checklistPct))
    return { category, n: rows.length, A, B, diff: B - A }
  })
  const handoffEvents = runs.filter((r) => r.condition === 'B').flatMap((r) => r.trace.filter((e) => e.kind === 'handoff'))
  const bRuns = runs.filter((r) => r.condition === 'B' && r.status === 'done').length
  return {
    experimentId,
    runs: {
      total: runs.length,
      done: runs.filter((r) => r.status === 'done').length,
      scored: runs.filter((r) => r.score).length,
      failed: runs.filter((r) => r.status === 'failed').length,
    },
    scenarios: ids,
    perScenario,
    paired,
    byCategory,
    consistency: {
      A: mean(perScenario.map((s) => s.spreadA).filter((x) => !Number.isNaN(x))),
      B: mean(perScenario.map((s) => s.spreadB).filter((x) => !Number.isNaN(x))),
    },
    handoffs: {
      total: handoffEvents.length,
      accepted: handoffEvents.filter((e) => e.kind === 'handoff' && e.accepted).length,
      perRun: bRuns ? handoffEvents.length / bRuns : 0,
    },
  }
}

// ------------------------------------------------------------- human scoring

export interface HumanScore {
  blindId: string
  rater: string
  items: { id: string; score: number }[]
}

/** Cohen's kappa over item scores (categories 0 / 0.5 / 1) and linear-weighted kappa. */
export function kappa(a: number[], b: number[]) {
  const cats = [0, 0.5, 1]
  const n = a.length
  if (!n) return { n, agreement: NaN, kappa: NaN, weighted: NaN }
  const idx = (x: number) => cats.indexOf(x <= 0.25 ? 0 : x >= 0.75 ? 1 : 0.5)
  const m = cats.map(() => cats.map(() => 0))
  for (let i = 0; i < n; i++) m[idx(a[i]!)]![idx(b[i]!)]! += 1
  const row = m.map((r) => r.reduce((x, y) => x + y, 0))
  const col = cats.map((_, j) => m.reduce((x, r) => x + r[j]!, 0))
  let po = 0
  let pe = 0
  let wo = 0
  let we = 0
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const w = 1 - Math.abs(i - j) / 2
      const o = m[i]![j]! / n
      const e = (row[i]! * col[j]!) / (n * n)
      if (i === j) {
        po += o
        pe += e
      }
      wo += w * o
      we += w * e
    }
  return { n, agreement: po, kappa: (po - pe) / (1 - pe || 1), weighted: (wo - we) / (1 - we || 1) }
}

/** Agreement between two raters, and between each rater and the automatic judge. */
export function agreement(human: HumanScore[], runs: RunRecord[]) {
  const raters = [...new Set(human.map((h) => h.rater))]
  const lookup = (rater: string) => {
    const map = new Map<string, number>()
    for (const h of human.filter((x) => x.rater === rater)) for (const it of h.items) map.set(`${h.blindId}|${it.id}`, it.score)
    return map
  }
  const judge = new Map<string, number>()
  for (const r of runs) for (const it of r.score?.items ?? []) if (it.method !== 'auto') judge.set(`${r.blindId}|${it.id}`, it.score)
  const pair = (x: Map<string, number>, y: Map<string, number>) => {
    const keys = [...x.keys()].filter((k) => y.has(k))
    return kappa(keys.map((k) => x.get(k)!), keys.map((k) => y.get(k)!))
  }
  const out: { a: string; b: string; n: number; agreement: number; kappa: number; weighted: number }[] = []
  for (let i = 0; i < raters.length; i++) {
    for (let j = i + 1; j < raters.length; j++) out.push({ a: raters[i]!, b: raters[j]!, ...pair(lookup(raters[i]!), lookup(raters[j]!)) })
    out.push({ a: raters[i]!, b: 'judge', ...pair(lookup(raters[i]!), judge) })
  }
  return out
}

export function conditionOf(runs: RunRecord[], blindId: string): Condition | undefined {
  return runs.find((r) => r.blindId === blindId)?.condition
}
