import type { RunContext } from './runtime.js'
import type { InfoNeed, NeedStatus, TraceEvent } from './types.js'

/**
 * Information checklist ("what do I still need to know?").
 *
 * The lead agent (A: advisor, B: personal) decomposes the request into a few
 * information needs on its first turn, then reports status changes each turn.
 * The controller — not the model — decides what counts as resolved:
 *   - a policy need is "answered" only with evidence ids retrieved in this run;
 *   - a student need is "answered" only with a quote that appears in the
 *     student's own words (opening message or replies).
 * Unsupported upgrades are downgraded to "partial" and reported back. When
 * every need is answered or blocked, the controller asks for the final answer,
 * and actions aimed at an already-answered need are counted as redundant.
 */

export const MAX_NEEDS = 7
const STATUSES: NeedStatus[] = ['open', 'partial', 'answered', 'blocked']

const norm = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’.,;:!?()（），。；：！？]+/g, ' ').trim()

export interface ChecklistInput {
  checklist?: unknown
  checklist_update?: unknown
  target?: unknown
}

export function hasChecklist(ctx: RunContext) {
  return Boolean(ctx.run.checklist?.length)
}

export function resolvedCount(items: InfoNeed[]) {
  return items.filter((i) => i.status === 'answered' || i.status === 'blocked').length
}

export function allResolved(items: InfoNeed[] | undefined) {
  return Boolean(items?.length) && resolvedCount(items!) === items!.length
}

/** Everything the student has said so far, for grounding student-fact quotes. */
function studentWords(ctx: RunContext) {
  return norm(
    [ctx.opening, ...ctx.run.trace.flatMap((e) => (e.kind === 'ask' ? [e.reply] : []))].join(' \n '),
  )
}

function snapshot(ctx: RunContext, agent: string, changed: string[], rejected: { id: string; reason: string }[], created = false) {
  const items = (ctx.run.checklist ?? []).map((i) => ({ ...i, evidence: [...i.evidence], facts: [...i.facts] }))
  const event: Omit<Extract<TraceEvent, { kind: 'checklist' }>, 'at'> = { kind: 'checklist', agent, items, changed, rejected, created }
  ctx.run.trace.push({ at: Date.now(), ...event })
  ctx.onUpdate?.(ctx.run)
}

/** Create the checklist from the lead agent's first-turn proposal. */
function create(ctx: RunContext, agent: string, raw: unknown, step: number) {
  if (!Array.isArray(raw)) return false
  const items: InfoNeed[] = []
  for (const r of raw.slice(0, MAX_NEEDS)) {
    const x = (r ?? {}) as Record<string, unknown>
    const question = String(x.question ?? x.text ?? '').trim().slice(0, 220)
    if (!question) continue
    items.push({
      id: `q${items.length + 1}`,
      question,
      kind: x.kind === 'student' ? 'student' : 'policy',
      status: 'open',
      evidence: [],
      facts: [],
      note: '',
      openedAt: step,
    })
  }
  if (!items.length) return false
  ctx.run.checklist = items
  snapshot(ctx, agent, items.map((i) => i.id), [], true)
  return true
}

/** Apply the lead agent's status updates, enforcing grounding. */
function update(ctx: RunContext, agent: string, raw: unknown, step: number) {
  const items = ctx.run.checklist
  if (!items || !Array.isArray(raw)) return
  const changed: string[] = []
  const rejected: { id: string; reason: string }[] = []
  const said = studentWords(ctx)
  for (const r of raw.slice(0, MAX_NEEDS * 2)) {
    const x = (r ?? {}) as Record<string, unknown>
    const item = items.find((i) => i.id === String(x.id ?? ''))
    if (!item) continue
    let status = STATUSES.find((s) => s === x.status) ?? item.status
    const evidence = (Array.isArray(x.evidence) ? x.evidence : []).map(String).slice(0, 8)
    const facts = (Array.isArray(x.facts) ? x.facts : []).map((f) => String(f).slice(0, 200)).slice(0, 4)
    const validEvidence = evidence.filter((id) => ctx.run.retrieved[id])
    const groundedFacts = facts.filter((f) => norm(f).length >= 2 && said.includes(norm(f)))
    if (status === 'answered') {
      if (item.kind === 'policy' && !validEvidence.length && !item.evidence.length) {
        status = 'partial'
        rejected.push({ id: item.id, reason: 'no retrieved evidence cited' })
      }
      if (item.kind === 'student' && !groundedFacts.length && !item.facts.length) {
        status = 'partial'
        rejected.push({ id: item.id, reason: "quote not found in the student's words" })
      }
    }
    const before = JSON.stringify([item.status, item.evidence, item.facts])
    item.status = status
    item.evidence = [...new Set([...item.evidence, ...validEvidence])]
    item.facts = [...new Set([...item.facts, ...groundedFacts])]
    if (x.note) item.note = String(x.note).slice(0, 240)
    if ((status === 'answered' || status === 'blocked') && item.resolvedAt === undefined) item.resolvedAt = step
    if (status !== 'answered' && status !== 'blocked') item.resolvedAt = undefined
    if (JSON.stringify([item.status, item.evidence, item.facts]) !== before) changed.push(item.id)
  }
  ctx.run.usage.checklistUpdates += 1
  if (changed.length || rejected.length) snapshot(ctx, agent, changed, rejected)
  return rejected
}

/**
 * Process the checklist fields of one lead-agent turn. Returns a line to add
 * to the next observation (status board, warnings, stop hint).
 */
export function processChecklist(ctx: RunContext, agent: string, out: ChecklistInput, action: string, step: number, closing = false): string {
  if (!ctx.budget.checklist) return ''
  const notes: string[] = []
  if (!hasChecklist(ctx)) {
    if (!create(ctx, agent, out.checklist, step)) {
      return 'CHECKLIST: missing. In your next reply include "checklist": [{"question": "...", "kind": "student|policy"}] (3-6 needs).'
    }
  }
  const rejected = update(ctx, agent, out.checklist_update, step) ?? []
  for (const r of rejected) notes.push(`update to ${r.id} rejected (${r.reason}) — kept as partial`)
  const target = ctx.run.checklist!.find((i) => i.id === String(out.target ?? ''))
  const researching = action === 'search' || action === 'get_course' || action === 'delegate' || action === 'ask_student'
  if (researching && target && (target.status === 'answered' || target.status === 'blocked')) {
    ctx.run.usage.redundantActions += 1
    notes.push(`${target.id} is already ${target.status}; spend the remaining budget on open needs`)
  }
  return board(ctx, notes, closing)
}

/** Compact status board shown to the lead agent after every action. */
export function board(ctx: RunContext, notes: string[] = [], closing = false) {
  const items = ctx.run.checklist
  if (!items?.length) return ''
  const mark = { open: '○', partial: '◐', answered: '✓', blocked: '✕' } as const
  const lines = items.map(
    (i) =>
      `${mark[i.status]} ${i.id} [${i.kind}] ${i.question.length > 90 ? `${i.question.slice(0, 89)}…` : i.question}${i.evidence.length ? ` {${i.evidence.slice(0, 3).join(', ')}}` : ''}${i.facts.length ? ` “${i.facts[0]!.slice(0, 60)}”` : ''}`,
  )
  const done = resolvedCount(items)
  const tail = closing
    ? 'Budget nearly used: answer now with what is resolved; list open needs as gaps.'
    : allResolved(items)
      ? 'All needs are resolved. Do not search or ask again: reply with action "final" now.'
      : `Next: work on an open/partial need and set "target" to its id.`
  return [`CHECKLIST ${done}/${items.length} resolved`, ...lines, ...notes.map((n) => `! ${n}`), tail].join('\n')
}

export const CHECKLIST_RULES = `Information checklist (required)
- First turn: besides your action, include "checklist": 3-6 information needs that decide the answer, each {"question": "...", "kind": "student" (a fact only the student can give) | "policy" (a rule to verify in documents)}.
- Every later turn: include "target": the need id your action works on, and "checklist_update": [{"id": "q2", "status": "open|partial|answered|blocked", "evidence": ["ids for policy needs"], "facts": ["exact short quote of the student's words for student needs"], "note": "what you learned"}].
- "answered" needs proof: policy → evidence ids you received; student → a quote of the student's own words. "blocked" = cannot be resolved here (say who can resolve it).
- Stop researching once every need is answered or blocked; never research a need that is already answered.`
