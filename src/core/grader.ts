import { parseJson, type Model } from './llm.js'
import { JUDGE_SYSTEM } from './prompts.js'
import type { Corpus } from './retrieval.js'
import type { ClaimVerdict, FinalReport, ItemScore, RunRecord, RunScore, Scenario } from './types.js'

/** Every evidence id the final report cites (options + claims). */
export function citedIds(report: FinalReport): string[] {
  return [...new Set([...report.options.flatMap((o) => o.evidence), ...report.claims.flatMap((c) => c.evidence)])]
}

/** A citation is valid when the id exists AND was actually retrieved during this run. */
export function isValidCitation(run: RunRecord, corpus: Corpus, id: string) {
  return Boolean(run.retrieved[id] && corpus.evidenceText(id))
}

/** Text shown to blind scorers and the judge: no condition, no trace, no agent names. */
export function blindView(report: FinalReport) {
  return {
    reply: report.reply,
    profile: report.profile,
    options: report.options,
    claims: report.claims.map((c, index) => ({ index, ...c })),
    uncertain: report.uncertain,
    advisor_questions: report.advisor_questions,
    referral: report.referral,
  }
}

export async function grade(
  run: RunRecord,
  scenario: Scenario,
  corpus: Corpus,
  judge: Model,
  judgeName: string,
  signal: AbortSignal,
): Promise<RunScore> {
  const report = run.report
  const items: ItemScore[] = []
  const cited = report ? citedIds(report) : []
  const valid = cited.filter((id) => isValidCitation(run, corpus, id))
  const validDocs = new Set(valid.map((id) => corpus.docOf(id)))
  const retrievedDocs = new Set(Object.keys(run.retrieved).map((id) => corpus.docOf(id)))
  const evidencedOption = report?.options.some((o) => o.evidence.some((id) => valid.includes(id))) ?? false

  const judged = scenario.checklist.filter((i) => !['elicit', 'cite'].includes(i.type))
  for (const item of scenario.checklist) {
    if (item.type === 'elicit') {
      const facts = item.facts ?? []
      const got = facts.filter((f) => run.disclosed.includes(f)).length
      items.push({
        id: item.id,
        type: item.type,
        weight: item.weight,
        score: facts.length ? got / facts.length : 0,
        method: 'auto',
        why: `${got}/${facts.length} facts disclosed`,
      })
    } else if (item.type === 'cite') {
      const docs = item.docs ?? []
      const hit = docs.some((d) => validDocs.has(d))
      const seen = docs.some((d) => retrievedDocs.has(d))
      items.push({
        id: item.id,
        type: item.type,
        weight: item.weight,
        score: hit ? 1 : seen ? 0.5 : 0,
        method: 'auto',
        why: hit ? 'cited' : seen ? 'retrieved but not cited' : 'never retrieved',
      })
    }
  }

  // Claims without a valid citation are "uncited" by rule; the rest go to the judge.
  const claims: ClaimVerdict[] = (report?.claims ?? []).map((c) => ({
    text: c.text,
    critical: c.critical,
    verdict: c.evidence.some((id) => valid.includes(id)) ? 'unsupported' : 'uncited',
    why: c.evidence.some((id) => valid.includes(id)) ? 'pending' : 'no valid citation',
  }))

  let judgeTokens = 0
  if (report && (judged.length || claims.some((c) => c.verdict !== 'uncited'))) {
    const evidence = valid
      .slice(0, 18)
      .map((id) => `[${id}] ${(corpus.evidenceText(id) ?? '').slice(0, 800)}`)
      .join('\n\n')
    const hidden = scenario.facts.map((f) => `- ${f.topic}: ${f.answer}`).join('\n')
    const input = [
      `CASE ${scenario.id}: ${scenario.title}`,
      `Opening message: ${scenario.opening}`,
      `Hidden student profile (the assistant only knows what it asked about):\n${hidden}`,
      `Reference notes for scorers: ${scenario.reference}`,
      `CHECKLIST to score:\n${judged.map((i) => `- ${i.id} [${i.type}] ${i.text}`).join('\n')}`,
      `CLAIMS to judge (critical ones only; by index): ${JSON.stringify(
        claims.map((c, i) => ({ i, c })).filter(({ c }) => c.critical && c.verdict !== 'uncited').map(({ i }) => i),
      )}`,
      `ASSISTANT SUMMARY:\n${JSON.stringify(blindView(report), null, 1)}`,
      `CITED EVIDENCE TEXT:\n${evidence || '(none valid)'}`,
    ].join('\n\n')
    const res = await judge({
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: input }],
      maxTokens: 1800,
      temperature: 0,
      signal,
    })
    if (res.error) throw new Error(`judge: ${res.error}`)
    judgeTokens = (res.usage?.input ?? 0) + (res.usage?.output ?? 0)
    const out = parseJson<{ items?: { id: string; score: number; why?: string }[]; claims?: { index: number; verdict: string; why?: string }[] }>(res.text) ?? {}
    for (const item of judged) {
      const j = out.items?.find((x) => x.id === item.id)
      let score = j ? Math.max(0, Math.min(1, Number(j.score) || 0)) : 0
      let why = j?.why ?? 'judge gave no score'
      let method: ItemScore['method'] = 'judge'
      if (item.type === 'next_step' && !evidencedOption) {
        score = 0
        why = 'no option backed by a valid citation (empty-caution rule)'
        method = 'rule'
      }
      items.push({ id: item.id, type: item.type, weight: item.weight, score, method, why })
    }
    for (const v of out.claims ?? []) {
      const c = claims[v.index]
      if (!c || c.verdict === 'uncited') continue
      const verdict = ['supported', 'partial', 'unsupported', 'contradicted'].includes(v.verdict) ? v.verdict : 'unsupported'
      c.verdict = verdict as ClaimVerdict['verdict']
      c.why = v.why ?? ''
    }
  } else {
    for (const item of judged)
      items.push({ id: item.id, type: item.type, weight: item.weight, score: 0, method: 'rule', why: 'no report' })
  }
  for (const c of claims) if (c.why === 'pending') c.why = c.critical ? 'judge gave no verdict' : 'non-critical, not judged'

  // keep checklist order
  items.sort((a, b) => scenario.checklist.findIndex((i) => i.id === a.id) - scenario.checklist.findIndex((i) => i.id === b.id))
  const total = items.reduce((n, i) => n + i.weight, 0)
  const got = items.reduce((n, i) => n + i.weight * i.score, 0)
  const critical = scenario.facts.filter((f) => f.critical)
  return {
    checklistPct: total ? (100 * got) / total : 0,
    items,
    claims,
    unsupportedCritical: claims.filter((c) => c.critical && ['unsupported', 'contradicted', 'uncited'].includes(c.verdict)).length,
    invalidCitations: cited.length - valid.length,
    validCitations: valid.length,
    criticalFactsElicited: critical.filter((f) => run.disclosed.includes(f.id)).length,
    criticalFactsTotal: critical.length,
    judgeModel: judgeName,
    judgeTokens,
    scoredAt: Date.now(),
  }
}
