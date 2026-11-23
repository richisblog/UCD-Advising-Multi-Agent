// Shared data model for both advising conditions, the simulated student,
// the grader and the analysis. Nothing here depends on Harness, so the same
// code runs inside the plugin Host and in the headless CLI runner.

export type Level = 'university' | 'college' | 'department'
export type Unit = 'university' | 'ls' | 'coe' | 'ecs' | 'psc' | 'lin' | 'mat'

export interface CorpusDocument {
  id: string
  title: string
  level: Level
  unit: Unit
  url: string
  source: 'official-page' | 'legacy-db' | 'calendar-db'
  retrievedAt: string
  sha256: string
  note?: string
}
export interface Chunk {
  id: string
  doc: string
  heading: string
  text: string
}
export interface Course {
  code: string
  dept: string
  number: string
  title: string
  units: string
  description: string
  prerequisites: string
  activities: string
  creditLimitations: string
  gradeMode: string
  ge: string
  reviews: { rating: number; difficulty: number; count: number } | null
  updatedAt: string | null
}
export interface CorpusData {
  version: string
  builtAt: string
  documents: CorpusDocument[]
  chunks: Chunk[]
  courses: Course[]
}

// ---------------------------------------------------------------- scenarios

export type Category =
  | 'unclear-interests'
  | 'uncertain-preparation'
  | 'workload-tradeoff'
  | 'overlapping-requirements'
  | 'procedural-risk'

export interface HiddenFact {
  id: string
  /** short description used only by the student simulator to match questions */
  topic: string
  /** what the student says when asked (first person) */
  answer: string
  /** decision-critical facts are the ones a good advisor should elicit */
  critical?: boolean
}

export type ChecklistType = 'elicit' | 'cite' | 'next_step' | 'referral' | 'caution' | 'avoid'
export interface ChecklistItem {
  id: string
  type: ChecklistType
  text: string
  weight: number
  /** elicit: auto-scored from fact disclosure */
  facts?: string[]
  /** cite: auto-scored when any valid citation comes from one of these documents */
  docs?: string[]
}

export interface Scenario {
  id: string
  split: 'dev' | 'heldout'
  category: Category
  secondary?: Category[]
  title: string
  /** Chinese display title */
  titleZh?: string
  year: string
  majors: string[]
  /** the incomplete first message */
  opening: string
  facts: HiddenFact[]
  checklist: ChecklistItem[]
  /** free-text note for human scorers: what a strong answer looks like */
  reference: string
}

// --------------------------------------------------------------- budgets

export interface Budget {
  /** total input+output tokens across every model call of the condition */
  tokens: number
  /** every model call, including specialist and repair calls */
  modelCalls: number
  /** search + course lookups */
  toolCalls: number
  clarifications: number
  /** Condition B only */
  specialistCalls: number
  /** max steps a single specialist may take for one delegated question */
  specialistSteps: number
  stepOutputTokens: number
  finalOutputTokens: number
  requestMs: number
}

export const defaultBudget: Budget = {
  tokens: 70_000,
  modelCalls: 18,
  toolCalls: 14,
  clarifications: 5,
  specialistCalls: 6,
  specialistSteps: 3,
  stepOutputTokens: 1500,
  finalOutputTokens: 2200,
  requestMs: 120_000,
}

// --------------------------------------------------------------- run record

export type Condition = 'A' | 'B'

export interface Usage {
  input: number
  output: number
}
export interface ModelCallLog {
  at: number
  agent: string
  purpose: string
  ms: number
  usage: Usage
  estimated: boolean
  error?: string
}

export type TraceEvent =
  | { at: number; kind: 'student'; text: string }
  | { at: number; kind: 'ask'; agent: string; question: string; reply: string; facts: string[] }
  | {
      at: number
      kind: 'search'
      agent: string
      query: string
      scope: string
      results: string[]
      repeated: boolean
    }
  | { at: number; kind: 'course'; agent: string; code: string; found: boolean; repeated: boolean }
  | {
      at: number
      kind: 'delegate'
      from: string
      to: string
      question: string
      facts: Record<string, string>
      depth: number
    }
  | { at: number; kind: 'report'; agent: string; findings: Finding[]; missing: string[] }
  | { at: number; kind: 'handoff'; from: string; to: string; question: string; accepted: boolean; reason: string }
  | { at: number; kind: 'thought'; agent: string; text: string }
  | { at: number; kind: 'limit'; detail: string }
  | { at: number; kind: 'error'; detail: string }

export interface Finding {
  claim: string
  evidence: string[]
  conditions: string[]
  missing: string[]
  by?: string
}

export interface ReportOption {
  title: string
  why: string
  steps: string[]
  evidence: string[]
}
export interface ReportClaim {
  text: string
  evidence: string[]
  critical: boolean
}
export interface FinalReport {
  reply: string
  profile: string[]
  options: ReportOption[]
  claims: ReportClaim[]
  uncertain: string[]
  advisor_questions: string[]
  referral: { needed: boolean; office: string; reason: string }
}

export interface RunRecord {
  id: string
  experimentId: string
  scenarioId: string
  condition: Condition
  repeat: number
  order: number
  blindId: string
  model: { provider: string; id: string }
  promptVersion: string
  corpusVersion: string
  budget: Budget
  startedAt: number
  endedAt?: number
  status: 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
  trace: TraceEvent[]
  calls: ModelCallLog[]
  /** every evidence id retrieved in the run, with the agent that saw it */
  retrieved: Record<string, string[]>
  disclosed: string[]
  report?: FinalReport
  stop?: string
  usage: {
    tokens: number
    input: number
    output: number
    modelCalls: number
    toolCalls: number
    clarifications: number
    specialistCalls: number
    repeatedRetrievals: number
    modelMs: number
    wallMs: number
    simulatorTokens: number
  }
  score?: RunScore
}

export interface ItemScore {
  id: string
  type: ChecklistType
  weight: number
  score: number
  method: 'auto' | 'judge' | 'rule'
  why: string
}
export interface ClaimVerdict {
  text: string
  critical: boolean
  verdict: 'supported' | 'partial' | 'unsupported' | 'contradicted' | 'uncited'
  why: string
}
export interface RunScore {
  checklistPct: number
  items: ItemScore[]
  claims: ClaimVerdict[]
  unsupportedCritical: number
  invalidCitations: number
  validCitations: number
  criticalFactsElicited: number
  criticalFactsTotal: number
  judgeModel: string
  judgeTokens: number
  scoredAt: number
}
