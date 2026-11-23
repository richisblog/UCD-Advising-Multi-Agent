import type { Analysis } from './core/analysis.js'
import type { PendingQuestion } from './core/lab.js'
import type { ExperimentMeta } from './core/store.js'
import type { Budget, RunRecord, Scenario } from './core/types.js'

/** Harness exact Fetch routes live under /api; each endpoint is namespaced by the plugin. */
export const channel = '/api'
export const endpoints = {
  state: 'pathfinder-lab/state',
  consult: 'pathfinder-lab/consult',
  answer: 'pathfinder-lab/answer',
  experiment: 'pathfinder-lab/experiment',
  stop: 'pathfinder-lab/stop',
  grade: 'pathfinder-lab/grade',
  analysis: 'pathfinder-lab/analysis',
  exportBlind: 'pathfinder-lab/export-blind',
  exportRuns: 'pathfinder-lab/export-runs',
  importHuman: 'pathfinder-lab/import-human',
  resume: 'pathfinder-lab/resume',
} as const
export type Endpoint = keyof typeof endpoints

export interface LabState {
  model: { provider: string; id: string } | null
  corpus: { version: string; builtAt: string; documents: number; chunks: number; courses: number; byUnit: Record<string, number> }
  scenarios: Scenario[]
  experiments: ExperimentMeta[]
  job: { experimentId: string; progress: number; planned: number } | null
  pending: PendingQuestion[]
  defaults: Budget
  /** runs of the selected experiment (trimmed) */
  runs: RunSummary[]
  /** full records for runIds requested */
  details: RunRecord[]
  /** evidence text for every id retrieved by the detail runs */
  evidence: Record<string, EvidenceView>
  warning?: string
}

export interface EvidenceView {
  title: string
  heading: string
  url: string
  scope: string
  retrievedAt: string
  legacy: boolean
  text: string
}

export interface RunSummary {
  id: string
  scenarioId: string
  condition: 'A' | 'B'
  repeat: number
  order: number
  status: RunRecord['status']
  tokens: number
  modelCalls: number
  clarifications: number
  specialistCalls: number
  wallMs: number
  checklistPct?: number
  unsupportedCritical?: number
  stop?: string
  error?: string
  startedAt: number
}

export function summarize(run: RunRecord): RunSummary {
  return {
    id: run.id,
    scenarioId: run.scenarioId,
    condition: run.condition,
    repeat: run.repeat,
    order: run.order,
    status: run.status,
    tokens: run.usage.tokens,
    modelCalls: run.usage.modelCalls,
    clarifications: run.usage.clarifications,
    specialistCalls: run.usage.specialistCalls,
    wallMs: run.usage.wallMs || Date.now() - run.startedAt,
    checklistPct: run.score?.checklistPct,
    unsupportedCritical: run.score?.unsupportedCritical,
    stop: run.stop,
    error: run.error,
    startedAt: run.startedAt,
  }
}

export interface AnalysisResult {
  analysis: Analysis
  agreement: { a: string; b: string; n: number; agreement: number; kappa: number; weighted: number }[]
  humanCount: number
}
