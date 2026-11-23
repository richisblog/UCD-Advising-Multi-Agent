import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Model } from '../src/core/llm.js'
import { LabStore, loadCorpusFile, loadScenarioFile } from '../src/core/store.js'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function args(argv = process.argv.slice(2)) {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[a.slice(2)] = next
      i++
    } else out[a.slice(2)] = 'true'
  }
  return out
}

/** Minimal .env reader (KEY=VALUE lines). Values never get printed. */
export function loadEnv(file?: string) {
  const candidates = [file, join(ROOT, '.env')].filter(Boolean) as string[]
  for (const f of candidates) {
    if (!existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
    }
  }
}

export function deepseek(modelName?: string): { model: Model; info: { provider: string; id: string } } {
  const key = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY
  if (!key) throw new Error('Set DEEPSEEK_API_KEY (or LLM_API_KEY), or pass --env-file.')
  const base = (process.env.DEEPSEEK_BASE_URL || process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '')
  const id = modelName || process.env.DEEPSEEK_MODEL || process.env.LLM_MODEL || 'deepseek-chat'
  const model: Model = async ({ system, messages, maxTokens, temperature, signal }) => {
    let last = ''
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: id,
            messages: [{ role: 'system', content: system }, ...messages],
            max_tokens: Math.max(64, Math.min(8000, maxTokens)),
            temperature: temperature ?? 0.2,
            stream: false,
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        })
        if (res.status === 429 || res.status >= 500) {
          last = `HTTP ${res.status}`
          await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
          continue
        }
        if (!res.ok) return { text: '', error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        return {
          text: body.choices?.[0]?.message?.content ?? '',
          usage: body.usage ? { input: body.usage.prompt_tokens ?? 0, output: body.usage.completion_tokens ?? 0 } : undefined,
        }
      } catch (error) {
        if (signal.aborted) throw error
        last = error instanceof Error ? error.message : String(error)
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
      }
    }
    return { text: '', error: `request failed after retries (${last})` }
  }
  return { model, info: { provider: 'deepseek-api', id } }
}

export function loadAll(opts: Record<string, string>) {
  const corpus = loadCorpusFile(opts.corpus || join(ROOT, 'corpus', 'corpus.json'))
  const scenarios = loadScenarioFile(opts.scenarios || join(ROOT, 'experiment', 'scenarios.json'))
  const store = new LabStore(opts.results || join(ROOT, 'results'))
  return { corpus, scenarios, store }
}
