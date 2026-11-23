import { parseJson, type Model } from './llm.js'
import { SIMULATOR_SYSTEM } from './prompts.js'
import type { Student } from './runtime.js'
import type { RunRecord, Scenario } from './types.js'

/**
 * Scripted student: a temperature-0 matcher decides WHICH hidden facts the
 * question asks for; the reply is the scenario's fixed wording for those
 * facts. The model never writes student text, so both conditions hear
 * identical answers to equivalent questions. Simulator tokens are logged but
 * are not charged to the advising budget.
 */
export function simulatedStudent(scenario: Scenario, model: Model, run: RunRecord): Student {
  const sheet = scenario.facts.map((f) => `- ${f.id}: ${f.topic}`).join('\n')
  return async (question, signal) => {
    let ids: string[] = []
    try {
      const res = await model({
        system: SIMULATOR_SYSTEM,
        messages: [
          {
            role: 'user',
            content: `Student's opening message: ${scenario.opening}\n\nHidden fact sheet (id: topic):\n${sheet}\n\nAssistant's question: ${question}`,
          },
        ],
        maxTokens: 120,
        temperature: 0,
        signal,
      })
      if (res.usage) run.usage.simulatorTokens += res.usage.input + res.usage.output
      const parsed = parseJson<{ facts?: unknown }>(res.text)
      if (Array.isArray(parsed?.facts)) ids = parsed.facts.map(String)
    } catch (error) {
      if (signal.aborted) throw error
    }
    const facts = scenario.facts.filter((f) => ids.includes(f.id)).slice(0, 3)
    if (!facts.length) return { text: "Hmm, I'm not sure — I don't really know how to answer that.", facts: [] }
    return { text: facts.map((f) => f.answer).join(' '), facts: facts.map((f) => f.id) }
  }
}

/** Deterministic keyword matcher used in tests and when no simulator model is available. */
export function keywordStudent(scenario: Scenario): Student {
  return async (question) => {
    const q = question.toLowerCase()
    const facts = scenario.facts
      .filter((f) =>
        f.topic
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 3)
          .some((w) => q.includes(w)),
      )
      .slice(0, 3)
    if (!facts.length) return { text: "I'm not sure.", facts: [] }
    return { text: facts.map((f) => f.answer).join(' '), facts: facts.map((f) => f.id) }
  }
}
