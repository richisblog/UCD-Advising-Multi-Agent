import type { Budget, ModelCallLog, RunRecord, Usage } from './types.js'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}
export interface ModelRequest {
  system: string
  messages: ChatMessage[]
  maxTokens: number
  temperature?: number
  signal: AbortSignal
}
export interface ModelResponse {
  text: string
  usage?: Usage
  error?: string
}
/** Provider-neutral model call. The Host adapts Harness `ctx.llm`; the CLI adapts the DeepSeek API. */
export type Model = (request: ModelRequest) => Promise<ModelResponse>

export class MalformedOutput extends Error {}

export class BudgetExceeded extends Error {
  constructor(readonly resource: string) {
    super(`budget exhausted: ${resource}`)
  }
}

/** Rough token estimate used to reserve budget before a call (≈3.6 chars/token, CJK ≈1 char/token). */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 3.6)
}

/**
 * Single ledger per run. Every model call of a condition — planner, specialist,
 * repair — goes through `call`, so the matched budget is enforced in one place.
 */
export class Ledger {
  constructor(
    private readonly run: RunRecord,
    private readonly budget: Budget,
    private readonly model: Model,
    private readonly signal: AbortSignal,
  ) {}

  /** actual/estimated input tokens of the last call with real usage (estimates drift with JSON and CJK) */
  private ratio = 1
  get inputRatio() {
    return this.ratio
  }

  get remainingTokens() {
    return this.budget.tokens - this.run.usage.tokens
  }
  get remainingCalls() {
    return this.budget.modelCalls - this.run.usage.modelCalls
  }

  canAfford(system: string, messages: ChatMessage[], maxTokens: number) {
    const need = estimateTokens(system) + messages.reduce((n, m) => n + estimateTokens(m.content), 0) + maxTokens
    return this.remainingCalls > 0 && this.remainingTokens >= need
  }

  useTool() {
    if (this.run.usage.toolCalls >= this.budget.toolCalls) throw new BudgetExceeded('toolCalls')
    this.run.usage.toolCalls += 1
  }

  async call(agent: string, purpose: string, system: string, messages: ChatMessage[], maxTokens: number) {
    if (this.signal.aborted) throw new DOMException('cancelled', 'AbortError')
    if (this.remainingCalls <= 0) throw new BudgetExceeded('modelCalls')
    const inputEstimate = estimateTokens(system) + messages.reduce((n, m) => n + estimateTokens(m.content), 0)
    const cap = Math.min(maxTokens, this.remainingTokens - inputEstimate)
    if (cap < 200) throw new BudgetExceeded('tokens')
    const started = Date.now()
    this.run.usage.modelCalls += 1
    let response: ModelResponse
    try {
      response = await this.model({ system, messages, maxTokens: cap, temperature: 0.2, signal: this.signal })
    } catch (error) {
      if (this.signal.aborted) throw error
      response = { text: '', error: error instanceof Error ? error.message : String(error) }
    }
    if (response.usage && inputEstimate > 0) this.ratio = Math.max(1, response.usage.input / inputEstimate)
    const estimated = !response.usage
    const usage = response.usage ?? { input: inputEstimate, output: estimateTokens(response.text) }
    const ms = Date.now() - started
    const log: ModelCallLog = { at: started, agent, purpose, ms, usage, estimated, error: response.error }
    this.run.calls.push(log)
    this.run.usage.input += usage.input
    this.run.usage.output += usage.output
    this.run.usage.tokens += usage.input + usage.output
    this.run.usage.modelMs += ms
    if (response.error) throw new Error(response.error)
    return response.text
  }

  /** Call and parse a JSON object; one targeted repair attempt on malformed output. */
  async json<T = Record<string, unknown>>(
    agent: string,
    purpose: string,
    system: string,
    messages: ChatMessage[],
    maxTokens: number,
  ): Promise<T> {
    const text = await this.call(agent, purpose, system, messages, maxTokens)
    const parsed = parseJson<T>(text)
    if (parsed !== undefined) return parsed
    const repair: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: text.slice(0, 4000) },
      {
        role: 'user',
        content:
          'Your last reply was not one valid JSON object (it may have been cut off). Reply again with ONLY one complete JSON object, no prose and no code fence, and keep it short: at most 3 findings/options, each under 40 words.',
      },
    ]
    const again = await this.call(agent, `${purpose}:repair`, system, repair, maxTokens)
    const second = parseJson<T>(again)
    if (second === undefined) throw new MalformedOutput(`${agent} returned malformed JSON twice`)
    return second
  }
}

export function parseJson<T>(text: string): T | undefined {
  const cleaned = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/i, '').trim()
  const tryParse = (s: string) => {
    try {
      const v = JSON.parse(s)
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as T) : undefined
    } catch {
      return undefined
    }
  }
  const direct = tryParse(cleaned)
  if (direct) return direct
  // first balanced {...}
  const start = cleaned.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return tryParse(cleaned.slice(start, i + 1))
  }
  return undefined
}
