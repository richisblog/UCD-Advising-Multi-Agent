import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-client-connection'
import { createAssistantMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import s from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { channel, endpoints, summarize, type Endpoint, type LabState } from './contract.js'
import { schemas } from './schemas.js'
import { Lab } from './core/lab.js'
import type { Model } from './core/llm.js'
import { LabStore, loadCorpusFile, loadScenarioFile } from './core/store.js'
import { defaultBudget } from './core/types.js'

export const name = 'pathfinder-lab'
export const inject = ['connection', 'llm', 'agentDefaultModel']

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))

export interface Config {
  corpusFile?: string
  scenarioFile?: string
  reasoningEffort?: string
}
export const Config = s.object({
  corpusFile: s.string().default('').description('Override path of corpus.json (default: bundled corpus).'),
  scenarioFile: s.string().default('').description('Override path of scenarios.json (default: bundled scenarios).'),
  reasoningEffort: s
    .string()
    .default('off')
    .description('Reasoning effort for every lab call (both conditions share it). Off keeps JSON steps inside their caps.'),
})

export function dataRoot() {
  return join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'pathfinder-lab')
}

/** Adapt Harness `ctx.llm` to the provider-neutral Model used by the lab core. */
function harnessModel(
  ctx: Context,
  selection: ReturnType<Context['agentDefaultModel']['currentSelection']>,
  reasoningEffort: string,
): Model {
  const effort = /^deepseek/i.test(selection.model) ? reasoningEffort || 'off' : undefined
  const once: Model = async ({ system, messages, maxTokens, temperature, signal }) => {
    let text = ''
    let usage: { input: number; output: number } | undefined
    let error: string | undefined
    const request: GenerateOptions = {
      ...selection,
      reasoningEffort: effort as GenerateOptions['reasoningEffort'],
      system,
      maxTokens,
      temperature: temperature ?? 0.2,
      // Harness requires prior assistant turns to be identified model messages with their provider source.
      messages: messages.map((m) =>
        m.role === 'assistant'
          ? createAssistantMessage({
              content: [{ type: 'text', text: m.content }],
              source: { provider: selection.provider, model: selection.model },
            })
          : { role: 'user' as const, content: [{ type: 'text' as const, text: m.content }] },
      ) as GenerateOptions['messages'],
      signal: AbortSignal.any([signal, AbortSignal.timeout(defaultBudget.requestMs)]),
    }
    try {
      for await (const chunk of ctx.llm.stream(request)) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'usage') {
          const { inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0, totalTokens } = chunk.usage
          usage = {
            input: totalTokens === undefined ? inputTokens + cacheReadTokens + cacheWriteTokens : totalTokens - outputTokens,
            output: outputTokens,
          }
        }
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          const code = chunk.reason.failure.code
          error =
            code === 'AUTH' || code === 'MISSING_CREDENTIAL'
              ? 'DeepSeek authorization failed. Sign in or update the provider in Harness settings.'
              : `Model request failed (${code}${'message' in chunk.reason.failure && chunk.reason.failure.message ? `: ${String(chunk.reason.failure.message).slice(0, 160)}` : ''}).`
        }
      }
    } catch (failure) {
      if (signal.aborted) throw failure
      error = failure instanceof Error ? failure.message : 'Model request failed.'
    }
    return { text, usage, error }
  }
  // Transient provider failures (dropped connection, rate limit, overload, request timeout) are retried here
  // with backoff, so one network blip does not end a whole run. Failed attempts bill no output.
  return async (req) => {
    let last = await once(req)
    for (let attempt = 1; attempt <= 3 && last.error && !req.signal.aborted; attempt++) {
      if (!/TRANSPORT|RATE_LIMIT|OVERLOAD|TIMEOUT|ABORTED|UNAVAILABLE|network|fetch failed/i.test(last.error)) break
      await new Promise((r) => setTimeout(r, 2000 * 3 ** (attempt - 1)))
      if (req.signal.aborted) break
      last = await once(req)
    }
    return last
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const corpus = loadCorpusFile(config.corpusFile || join(PACKAGE_ROOT, 'corpus', 'corpus.json'))
  const scenarios = loadScenarioFile(config.scenarioFile || join(PACKAGE_ROOT, 'experiment', 'scenarios.json'))
  const store = new LabStore(dataRoot())
  const byUnit: Record<string, number> = {}
  for (const c of corpus.chunks.values()) {
    const u = corpus.documents.get(c.doc)?.unit ?? '?'
    byUnit[u] = (byUnit[u] ?? 0) + 1
  }

  const selection = () => {
    const current = ctx.agentDefaultModel.currentSelection()
    if (!current.provider || !ctx.llm.listProviders().some(({ id }) => id === current.provider)) return null
    return current
  }
  const lab = new Lab({
    corpus,
    scenarios,
    store,
    model: () => {
      const sel = selection()
      return sel
        ? { model: harnessModel(ctx, sel, config.reasoningEffort ?? 'off'), info: { provider: sel.provider, id: sel.model } }
        : null
    },
    log: (m) => ctx.logger?.warn?.(m),
  })

  async function state(experimentId?: string, runIds: string[] = []): Promise<LabState> {
    const sel = selection()
    const experiments = await store.listExperiments()
    const target = experimentId ?? experiments[0]?.id
    const runs = target ? await lab.runs(target) : []
    const consult = runIds.length ? await lab.runs('consult') : []
    const details = [...runs, ...consult].filter((r) => runIds.includes(r.id))
    const evidence: LabState['evidence'] = {}
    for (const id of details.flatMap((r) => Object.keys(r.retrieved)).slice(0, 160)) {
      if (id.startsWith('COURSE:')) {
        const c = corpus.course(id.slice(7))
        if (c)
          evidence[id] = {
            title: `${c.code} ${c.title}`,
            heading: 'Course record (local CourseScope catalog data)',
            url: '',
            scope: 'course',
            retrievedAt: c.updatedAt ?? '',
            legacy: false,
            text: corpus.evidenceText(id) ?? '',
          }
        continue
      }
      const chunk = corpus.chunks.get(id)
      const doc = chunk && corpus.documents.get(chunk.doc)
      if (chunk && doc)
        evidence[id] = {
          title: doc.title,
          heading: chunk.heading,
          url: doc.url.startsWith('http') ? doc.url : '',
          scope: `${doc.level}/${doc.unit}`,
          retrievedAt: doc.retrievedAt,
          legacy: doc.source === 'legacy-db',
          text: chunk.text,
        }
    }
    return {
      model: sel ? { provider: sel.provider, id: sel.model } : null,
      corpus: {
        version: corpus.version,
        builtAt: corpus.builtAt,
        documents: corpus.documents.size,
        chunks: corpus.chunks.size,
        courses: corpus.courses.size,
        byUnit,
      },
      scenarios,
      experiments,
      job: lab.jobStatus(),
      pending: lab.pendingQuestions(),
      defaults: defaultBudget,
      runs: runs.map(summarize),
      details,
      evidence,
    }
  }

  async function dispatch(endpoint: Endpoint, payload: unknown): Promise<unknown> {
    switch (endpoint) {
      case 'state': {
        const p = schemas.state.parse(payload)
        return state(p.experimentId, p.runIds)
      }
      case 'consult': {
        const p = schemas.consult.parse(payload)
        const ids = lab.startConsult(p.opening, p.conditions, p.budget)
        return { runIds: ids, state: await state(undefined, ids) }
      }
      case 'answer': {
        const p = schemas.answer.parse(payload)
        lab.answer(p.runId, p.text, p.facts)
        return { ok: true }
      }
      case 'experiment': {
        const p = schemas.experiment.parse(payload)
        const id = await lab.startExperiment(p)
        return { experimentId: id }
      }
      case 'stop': {
        lab.stop(schemas.stop.parse(payload).runId)
        return { ok: true }
      }
      case 'grade': {
        const p = schemas.grade.parse(payload)
        return { graded: await lab.gradeAll(p.experimentId, p.force) }
      }
      case 'analysis':
        return lab.analysis(schemas.analysis.parse(payload).experimentId)
      case 'exportBlind':
        return lab.exportBlind(schemas.exportBlind.parse(payload).experimentId)
      case 'exportRuns':
        return { runs: await lab.runs(schemas.exportRuns.parse(payload).experimentId) }
      case 'resume': {
        const p = schemas.resume.parse(payload)
        return { queued: await lab.resumeExperiment(p.experimentId, p.autoGrade ?? true) }
      }
      case 'importHuman': {
        const p = schemas.importHuman.parse(payload)
        return { imported: await lab.importHuman(p.experimentId, p.scores) }
      }
    }
  }

  const envelope = z.object({ type: z.literal('client-request'), rpcId: z.string().min(1).max(100), payload: z.unknown() })
  for (const [key, path] of Object.entries(endpoints) as [Endpoint, string][]) {
    ctx.effect(() =>
      ctx.connection.fetch.register({
        path: `${channel}/${path}`,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          let body: z.infer<typeof envelope>
          try {
            body = envelope.parse(await request.json())
          } catch {
            return new Response('Invalid lab request.', { status: 400 })
          }
          let result: unknown
          try {
            result = { ok: true, value: await dispatch(key, body.payload) }
          } catch (error) {
            result = {
              ok: false,
              error: {
                code: 'pathfinder-lab/request-failed',
                message:
                  error instanceof z.ZodError
                    ? error.issues.map(({ path: p, message }) => `${p.join('.')}: ${message}`).join(' ')
                    : error instanceof Error
                      ? error.message
                      : 'Request failed.',
                details: {},
              },
            }
          }
          return Response.json({ type: 'server-response', rpcId: body.rpcId, result })
        },
      }),
    )
  }

  ctx.effect(() => () => lab.stop())
}
