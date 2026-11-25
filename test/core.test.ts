import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { analyze, kappa, signFlipP } from '../src/core/analysis.js'
import { execute, newRun, schedule } from '../src/core/experiment.js'
import { grade, isValidCitation } from '../src/core/grader.js'
import type { Model, ModelRequest } from '../src/core/llm.js'
import { parseJson } from '../src/core/llm.js'
import { normalizeCourse } from '../src/core/retrieval.js'
import { keywordStudent } from '../src/core/student.js'
import { loadCorpusFile, loadScenarioFile } from '../src/core/store.js'
import { defaultBudget, type Condition, type RunRecord } from '../src/core/types.js'

const ROOT = join(import.meta.dirname, '..')
const corpus = loadCorpusFile(join(ROOT, 'corpus', 'corpus.json'))
const scenarios = loadScenarioFile(join(ROOT, 'experiment', 'scenarios.json'))
const dev1 = scenarios.find((s) => s.id === 'DEV-01')!

/** Scripted model: returns queued JSON per agent; records every request. */
function scripted(script: Record<string, unknown[]>): Model & { calls: ModelRequest[] } {
  const queues = Object.fromEntries(Object.entries(script).map(([k, v]) => [k, [...v]]))
  const calls: ModelRequest[] = []
  const fn = (async (req: ModelRequest) => {
    calls.push(req)
    const who = req.system.startsWith('You are the Personal Agent')
      ? 'personal'
      : req.system.includes('University Policy Agent on')
        ? 'university'
        : req.system.includes('Department Agent · Computer Science on')
          ? 'dept-ecs'
          : req.system.includes('blind evaluator')
            ? 'judge'
            : 'advisor'
    const next = queues[who]?.shift() ?? { action: 'final', report: { reply: 'fallback' } }
    return { text: typeof next === 'string' ? next : JSON.stringify(next), usage: { input: 1000, output: 200 } }
  }) as Model & { calls: ModelRequest[] }
  fn.calls = calls
  return fn
}

function makeRun(condition: Condition, budget = defaultBudget): RunRecord {
  return newRun({
    experimentId: 'test',
    scenarioId: dev1.id,
    condition,
    repeat: 1,
    order: 1,
    blindId: 'abc123',
    model: { provider: 'test', id: 'scripted' },
    corpus,
    budget,
  })
}

test('corpus covers all four majors and both colleges', () => {
  const units = new Set([...corpus.documents.values()].map((d) => d.unit))
  for (const u of ['university', 'ls', 'coe', 'ecs', 'psc', 'lin', 'mat']) assert.ok(units.has(u as never), u)
  assert.ok(corpus.course('ECS 032A'))
  assert.equal(normalizeCourse('mat 21a'), 'MAT 21A')
})

test('scoped search never leaks other units', () => {
  const hits = corpus.search('change of major GPA requirement', { units: ['psc'] }, 6)
  assert.ok(hits.length > 0)
  for (const h of hits) assert.equal(h.doc.unit, 'psc')
  const ap = corpus.search('AP Calculus AB score credit MAT 021A', undefined, 4)
  assert.equal(ap[0]?.doc.id, 'UNI-AP')
  const zh = corpus.search('转专业 心理', { units: ['psc'] })
  assert.ok(zh.length > 0)
})

test('scenarios reference existing documents and facts', () => {
  assert.equal(scenarios.filter((s) => s.split === 'heldout').length, 20)
  for (const s of scenarios)
    for (const item of s.checklist) {
      for (const d of item.docs ?? []) assert.ok(d === 'COURSES' || corpus.documents.has(d), `${s.id} ${d}`)
      for (const f of item.facts ?? []) assert.ok(s.facts.some((x) => x.id === f), `${s.id} ${f}`)
    }
})

test('Condition A: asks, searches, finishes; citations validated against retrieval', async () => {
  const model = scripted({
    advisor: [
      { action: 'ask_student', question: 'What was your AP calculus exam score?' },
      { action: 'search', query: 'AP Calculus AB score 3 units MAT 021A', unit: 'university' },
      {
        action: 'final',
        report: {
          reply: 'ok',
          options: [{ title: 'Try ECS 32A', why: 'x', steps: ['enroll'], evidence: ['UNI-AP#2'] }],
          claims: [
            { text: 'AP Calc AB 3 gives 4 units', evidence: ['UNI-AP#2'], critical: true },
            { text: 'made up', evidence: ['LS-CHANGE#99'], critical: true },
          ],
        },
      },
    ],
  })
  const run = makeRun('A')
  await execute({ run, corpus, model, opening: dev1.opening, student: keywordStudent(dev1), signal: new AbortController().signal })
  assert.equal(run.status, 'done')
  assert.equal(run.stop, 'final')
  assert.equal(run.usage.clarifications, 1)
  assert.ok(run.disclosed.includes('calc'))
  assert.equal(run.usage.modelCalls, 3)
  const apChunk = corpus.search('AP Calculus AB score 3 units MAT 021A', { units: ['university'] }, 4)[0]!.id
  run.report!.claims[0]!.evidence = [apChunk]
  assert.ok(isValidCitation(run, corpus, apChunk))
  assert.ok(!isValidCitation(run, corpus, 'LS-CHANGE#99'))
})

test('Condition B: delegation, scoped specialist search, handoff and shared budget', async () => {
  const model = scripted({
    personal: [
      { action: 'delegate', role: 'dept-ecs', question: 'What are the CS change-of-major requirements?', facts: { college: 'L&S' } },
      { action: 'final', facts: {}, report: { reply: 'done', options: [], claims: [] } },
    ],
    'dept-ecs': [
      { action: 'search', query: 'change of major GPA ECS 020 MAT 021A' },
      {
        action: 'report',
        findings: [{ claim: 'Needs 3.0 GPA', evidence: ['ECS-CHANGE#1'], conditions: [], missing: ['AP credit'] }],
        handoff: { role: 'university', question: 'Does AP Calc AB 3 give MAT 21A credit?', reason: 'prereq' },
      },
    ],
    university: [
      { action: 'search', query: 'AP Calculus AB' },
      { action: 'report', findings: [{ claim: 'AB 3 = units only', evidence: ['UNI-AP#1'] }] },
    ],
  })
  const run = makeRun('B')
  await execute({ run, corpus, model, opening: dev1.opening, student: keywordStudent(dev1), signal: new AbortController().signal })
  assert.equal(run.status, 'done')
  assert.equal(run.usage.specialistCalls, 2)
  const searches = run.trace.filter((e) => e.kind === 'search')
  assert.equal(searches.length, 2)
  for (const e of searches) if (e.kind === 'search' && e.agent === 'dept-ecs') assert.ok(e.results.every((id) => corpus.documents.get(corpus.chunks.get(id)!.doc)!.unit === 'ecs'))
  assert.ok(run.trace.some((e) => e.kind === 'handoff' && e.accepted))
  // all calls (personal + 2 specialists) charged to one ledger
  assert.equal(run.usage.modelCalls, model.calls.length)
  assert.equal(run.usage.tokens, model.calls.length * 1200)
})

test('budget exhaustion yields a conservative report, never a crash', async () => {
  const model = scripted({ advisor: Array.from({ length: 10 }, () => ({ action: 'search', query: 'units' })) })
  const run = makeRun('A', { ...defaultBudget, modelCalls: 4 })
  await execute({ run, corpus, model, opening: 'help', student: keywordStudent(dev1), signal: new AbortController().signal })
  assert.equal(run.status, 'done')
  assert.ok(run.usage.modelCalls <= 4)
  assert.ok(run.report)
})

test('malformed JSON gets exactly one repair call', async () => {
  const model = scripted({ advisor: ['not json at all', { action: 'final', report: { reply: 'fixed' } }] })
  const run = makeRun('A')
  await execute({ run, corpus, model, opening: 'hi', student: keywordStudent(dev1), signal: new AbortController().signal })
  assert.equal(run.report?.reply, 'fixed')
  assert.ok(run.calls.some((c) => c.purpose.endsWith(':repair')))
  assert.deepEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 })
})

test('grader: auto items, empty-caution rule, uncited claims', async () => {
  const run = makeRun('A')
  run.status = 'done'
  run.disclosed = ['calc']
  run.retrieved = { 'UNI-AP#2': ['advisor'] }
  run.report = {
    reply: 'r',
    profile: [],
    options: [{ title: 'x', why: '', steps: [], evidence: [] }],
    claims: [{ text: 'AP gives units', evidence: ['UNI-AP#2'], critical: true }, { text: 'no cite', evidence: [], critical: true }],
    uncertain: [],
    advisor_questions: [],
    referral: { needed: true, office: 'L&S', reason: '' },
  }
  const judge = scripted({
    judge: [
      {
        items: dev1.checklist.map((i) => ({ id: i.id, score: 1 })),
        claims: [{ index: 0, verdict: 'supported' }],
      },
    ],
  })
  const score = await grade(run, dev1, corpus, judge, 'scripted', new AbortController().signal)
  const byId = Object.fromEntries(score.items.map((i) => [i.id, i]))
  assert.equal(byId.c1!.score, 1) // calc disclosed
  assert.equal(byId.c4!.score, 1) // UNI-AP validly cited in a claim
  assert.equal(byId.c6!.method, 'rule') // no evidenced option → empty-caution rule
  assert.equal(score.unsupportedCritical, 1)
  assert.equal(score.claims[0]!.verdict, 'supported')
})

test('schedule interleaves conditions and stats behave', () => {
  const plan = schedule(['X', 'Y', 'Z'], 2, 1)
  assert.equal(plan.length, 12)
  assert.equal(new Set(plan.map((p) => p.blindId)).size, 12)
  for (const s of ['X', 'Y', 'Z']) for (const r of [1, 2]) assert.equal(plan.filter((p) => p.scenarioId === s && p.repeat === r).length, 2)
  assert.ok(signFlipP([5, 6, 7, 8, 9, 10]) < 0.05)
  assert.ok(signFlipP([1, -1, 2, -2]) > 0.5)
  assert.equal(kappa([0, 1, 1, 0.5], [0, 1, 1, 0.5]).kappa, 1)
  const fake = (c: Condition, s: string, pct: number): RunRecord => ({
    ...makeRun(c),
    scenarioId: s,
    status: 'done',
    score: { checklistPct: pct, items: [], claims: [], unsupportedCritical: 0, invalidCitations: 0, validCitations: 1, criticalFactsElicited: 1, criticalFactsTotal: 2, judgeModel: '', judgeTokens: 0, scoredAt: 0 },
  })
  const a = analyze([fake('A', 'DEV-01', 50), fake('B', 'DEV-01', 70), fake('A', 'DEV-02', 40), fake('B', 'DEV-02', 45)], scenarios)
  assert.equal(a.paired[0]!.n, 2)
  assert.equal(a.paired[0]!.diff, 12.5)
})

test('Lab consult: pending question is answered by the user, then the run finishes', async () => {
  const { Lab } = await import('../src/core/lab.js')
  const { LabStore } = await import('../src/core/store.js')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const store = new LabStore(await mkdtemp(join(tmpdir(), 'pfl-')))
  const model = scripted({
    advisor: [
      { action: 'ask_student', question: 'Which college are you in?' },
      { action: 'final', report: { reply: 'Thanks', options: [], claims: [] } },
    ],
  })
  const lab = new Lab({ corpus, scenarios, store, model: () => ({ model, info: { provider: 't', id: 'scripted' } }) })
  const [runId] = lab.startConsult('I want to try CS', ['A'])
  for (let i = 0; i < 50 && !lab.pendingQuestions().length; i++) await new Promise((r) => setTimeout(r, 5))
  assert.equal(lab.pendingQuestions()[0]?.question, 'Which college are you in?')
  lab.answer(runId!, 'Letters & Science')
  for (let i = 0; i < 50; i++) {
    const [run] = (await lab.runs('consult')).filter((r) => r.id === runId)
    if (run?.status === 'done') {
      assert.equal(run.report?.reply, 'Thanks')
      assert.ok(run.trace.some((e) => e.kind === 'ask' && e.reply === 'Letters & Science'))
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail('consult run did not finish')
})

test('checklist: grounded updates only, redundant actions counted, stop hint when resolved', async () => {
  const model = scripted({
    advisor: [
      {
        action: 'search',
        query: 'AP Calculus AB score credit MAT 021A',
        target: 'q2',
        checklist: [
          { question: 'What AP calculus score does the student have?', kind: 'student' },
          { question: 'What credit does that score give?', kind: 'policy' },
        ],
      },
      {
        action: 'ask_student',
        question: 'What was your AP calculus exam score?',
        target: 'q1',
        // policy answered without evidence -> rejected; student answered with an invented quote -> rejected
        checklist_update: [
          { id: 'q2', status: 'answered', evidence: ['NOT-RETRIEVED#1'] },
          { id: 'q1', status: 'answered', facts: ['I got a 5'] },
        ],
      },
      {
        action: 'search',
        query: 'AP calculus',
        target: 'q1',
        checklist_update: [
          { id: 'q1', status: 'answered', facts: ['got a 3'] },
          { id: 'q2', status: 'answered', evidence: ['__AP__'] },
        ],
      },
      { action: 'final', report: { reply: 'done' } },
    ],
  })
  const run = makeRun('A')
  // resolve the placeholder to a chunk the first search really returns
  const apId = corpus.search('AP Calculus AB score credit MAT 021A', undefined, 4)[0]!.id
  const step3 = (model as unknown as { calls: unknown[] }) && apId
  const original = model
  const patched: typeof model = Object.assign(
    async (req: Parameters<typeof model>[0]) => {
      const res = await original(req)
      return { ...res, text: res.text.replace('__AP__', step3) }
    },
    { calls: original.calls },
  )
  await execute({ run, corpus, model: patched, opening: dev1.opening, student: keywordStudent(dev1), signal: new AbortController().signal })
  assert.equal(run.status, 'done')
  const events = run.trace.filter((e) => e.kind === 'checklist')
  assert.ok(events.length >= 2)
  const rejected = events.flatMap((e) => (e.kind === 'checklist' ? e.rejected.map((r) => r.id) : []))
  assert.deepEqual(rejected.sort(), ['q1', 'q2'])
  assert.equal(run.checklist!.find((i) => i.id === 'q1')!.status, 'answered')
  assert.equal(run.checklist!.find((i) => i.id === 'q2')!.status, 'answered')
  assert.equal(run.usage.redundantActions, 1) // the 3rd search targeted q1 after it was answered
  const lastObservation = original.calls.at(-1)!.messages.filter((m) => m.role === 'user').at(-1)!.content
  assert.match(lastObservation, /All needs are resolved/)
})

test('Condition B keeps enough calls for the final answer', async () => {
  const model = scripted({
    personal: [
      { action: 'delegate', role: 'dept-ecs', question: 'first question' },
      { action: 'delegate', role: 'dept-ecs', question: 'second question' },
      { action: 'final', report: { reply: 'done' } },
    ],
    'dept-ecs': Array.from({ length: 30 }, () => ({ action: 'search', query: 'change of major' })),
  })
  const run = makeRun('B', { ...defaultBudget, modelCalls: 9 })
  await execute({ run, corpus, model, opening: dev1.opening, student: keywordStudent(dev1), signal: new AbortController().signal })
  assert.equal(run.status, 'done')
  assert.equal(run.stop, 'final')
  assert.equal(run.usage.specialistCalls, 1) // the second delegation was refused to protect the final answer
  assert.ok(run.trace.some((e) => e.kind === 'limit' && /no budget left/.test(e.detail)))
})
