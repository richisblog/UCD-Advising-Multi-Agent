import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Corpus } from './retrieval.js'
import type { CorpusData, RunRecord, Scenario } from './types.js'
import type { HumanScore } from './analysis.js'

export interface ExperimentMeta {
  id: string
  name: string
  createdAt: number
  seed: number
  repeats: number
  scenarioIds: string[]
  studentMode: 'simulated' | 'manual'
  model: { provider: string; id: string }
  budget: unknown
  promptVersion: string
  corpusVersion: string
  planned: number
  status: 'running' | 'done' | 'stopped'
  error?: string
}

export function loadCorpusFile(file: string) {
  return new Corpus(JSON.parse(readFileSync(file, 'utf8')) as CorpusData)
}
export function loadScenarioFile(file: string) {
  return JSON.parse(readFileSync(file, 'utf8')) as Scenario[]
}

async function writeAtomic(file: string, value: unknown) {
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 })
  await rename(`${file}.tmp`, file)
}

/** Files under <root>/experiments/<id>/{meta.json, runs/*.json, human.json}. */
export class LabStore {
  constructor(readonly root: string) {}

  dir(id: string) {
    return join(this.root, 'experiments', id)
  }

  async saveMeta(meta: ExperimentMeta) {
    await mkdir(join(this.dir(meta.id), 'runs'), { recursive: true, mode: 0o700 })
    await writeAtomic(join(this.dir(meta.id), 'meta.json'), meta)
  }

  async saveRun(run: RunRecord) {
    const dir = join(this.dir(run.experimentId), 'runs')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeAtomic(join(dir, `${run.id}.json`), run)
  }

  async listExperiments(): Promise<ExperimentMeta[]> {
    const base = join(this.root, 'experiments')
    await mkdir(base, { recursive: true, mode: 0o700 })
    const out: ExperimentMeta[] = []
    for (const name of await readdir(base)) {
      try {
        out.push(JSON.parse(await readFile(join(base, name, 'meta.json'), 'utf8')))
      } catch {
        /* skip unreadable */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  async loadRuns(id: string): Promise<RunRecord[]> {
    const dir = join(this.dir(id), 'runs')
    let names: string[] = []
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    const runs: RunRecord[] = []
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        const run = JSON.parse(await readFile(join(dir, name), 'utf8')) as RunRecord
        if (run.status === 'running') run.status = 'failed' // host restarted mid-run; never replayed
        runs.push(run)
      } catch {
        /* skip */
      }
    }
    return runs.sort((a, b) => a.order - b.order)
  }

  async saveHuman(id: string, scores: HumanScore[]) {
    await mkdir(this.dir(id), { recursive: true, mode: 0o700 })
    await writeAtomic(join(this.dir(id), 'human.json'), scores)
  }
  async loadHuman(id: string): Promise<HumanScore[]> {
    try {
      return JSON.parse(await readFile(join(this.dir(id), 'human.json'), 'utf8'))
    } catch {
      return []
    }
  }
}
