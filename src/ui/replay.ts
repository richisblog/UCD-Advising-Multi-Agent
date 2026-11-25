import { useEffect, useMemo, useState } from 'react'
import type { EvidenceView } from '../contract.js'
import { normalizeCourse } from '../core/retrieval.js'
import type { InfoNeed, RunRecord, TraceEvent } from '../core/types.js'

// One replay cursor drives every process view (diagram, checklist, timeline,
// story). `snapshotAt` rebuilds the full state of a run at any step from the
// trace alone, so live runs and finished runs render the same way.

export const COURSE_UNIT: Record<string, string> = { ECS: 'ecs', PSC: 'psc', LIN: 'lin', MAT: 'mat', STA: 'mat' }

export function docOf(id: string) {
  return id.startsWith('COURSE:') ? id.slice(7) : id.split('#')[0]!
}
export function unitOfEvidence(id: string, evidence: Record<string, EvidenceView>) {
  if (id.startsWith('COURSE:')) return COURSE_UNIT[id.slice(7).split(' ')[0] ?? ''] ?? 'university'
  const scope = evidence[id]?.scope
  if (scope?.includes('/')) return scope.split('/')[1]!
  const prefix = id.split('-')[0] ?? ''
  return ({ UNI: 'university', LS: 'ls', COE: 'coe', ECS: 'ecs', PSC: 'psc', LIN: 'lin', MAT: 'mat', LEGACY: 'mat' } as Record<string, string>)[prefix] ?? 'university'
}
/** Human-readable name for an evidence id, e.g. "L&S Change of Major". */
export function evidenceTitle(id: string, evidence: Record<string, EvidenceView>) {
  const e = evidence[id]
  if (!e) return docOf(id)
  return e.title.replace(/\s*\((catalog|college site)\)\s*$/i, '')
}

/** Events that represent a visible step (reasoning notes ride along with the next step). */
export function isStep(e: TraceEvent) {
  return e.kind !== 'thought'
}

export interface Snapshot {
  index: number
  event?: TraceEvent
  /** reasoning note just before this step, if any */
  thought?: string
  checklist: InfoNeed[]
  /** ids whose status changed at this exact step */
  changedNeeds: Set<string>
  docs: Map<string, { unit: string; hits: number; firstStep: number; lastStep: number; ids: Set<string> }>
  agents: Record<string, { searches: number; findings: number; asks: number; delegations: number; lastStep: number }>
  factsShared: number
  tokens: number
  calls: number
  elapsedMs: number
}

export function snapshotAt(run: RunRecord, events: TraceEvent[], index: number, evidence: Record<string, EvidenceView>): Snapshot {
  const snap: Snapshot = {
    index,
    checklist: [],
    changedNeeds: new Set(),
    docs: new Map(),
    agents: {},
    factsShared: 0,
    tokens: 0,
    calls: 0,
    elapsedMs: 0,
  }
  const agent = (a: string) => (snap.agents[a] ??= { searches: 0, findings: 0, asks: 0, delegations: 0, lastStep: -1 })
  for (let i = 0; i <= index && i < events.length; i++) {
    const e = events[i]!
    if (e.kind === 'search' || e.kind === 'course') {
      const ids = e.kind === 'search' ? e.results : e.found ? [`COURSE:${normalizeCourse(e.code) ?? e.code.toUpperCase()}`] : []
      for (const id of ids) {
        const key = docOf(id)
        const d = snap.docs.get(key) ?? { unit: unitOfEvidence(id, evidence), hits: 0, firstStep: i, lastStep: i, ids: new Set<string>() }
        d.hits += 1
        d.lastStep = i
        d.ids.add(id)
        snap.docs.set(key, d)
      }
      agent(e.agent).searches += 1
      agent(e.agent).lastStep = i
    } else if (e.kind === 'ask') {
      agent(e.agent).asks += 1
      agent(e.agent).lastStep = i
      snap.factsShared += e.facts.length || (e.reply ? 1 : 0)
    } else if (e.kind === 'report') {
      agent(e.agent).findings += e.findings.length
      agent(e.agent).lastStep = i
    } else if (e.kind === 'delegate') {
      agent(e.from).delegations += 1
      agent(e.from).lastStep = i
      agent(e.to).lastStep = i
    } else if (e.kind === 'handoff') {
      agent(e.from).lastStep = i
      if (e.accepted) agent(e.to).lastStep = i
    } else if (e.kind === 'checklist') {
      snap.checklist = e.items
      snap.changedNeeds = i === index ? new Set(e.changed) : snap.changedNeeds
      agent(e.agent).lastStep = i
    } else if (e.kind === 'thought') agent(e.agent).lastStep = i
  }
  const current = events[index]
  snap.event = current
  const prev = events[index - 1]
  if (prev?.kind === 'thought') snap.thought = prev.text
  if (current) {
    for (const c of run.calls) {
      if (c.at <= current.at) {
        snap.tokens += c.usage.input + c.usage.output
        snap.calls += 1
      }
    }
    snap.elapsedMs = current.at - run.startedAt
  }
  return snap
}

/** Shared play/pause/scrub state. Live runs follow the newest event until the viewer scrubs. */
export function useReplay(total: number, live: boolean) {
  const last = Math.max(0, total - 1)
  const [step, setStep] = useState(last)
  const [follow, setFollow] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  useEffect(() => {
    if (follow) setStep(last)
  }, [last, follow])
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setStep((s) => {
        if (s >= last) {
          setPlaying(false)
          return s
        }
        return s + 1
      })
    }, 1200 / speed)
    return () => clearInterval(timer)
  }, [playing, speed, last])
  return useMemo(
    () => ({
      step: Math.min(step, last),
      last,
      live,
      follow,
      playing,
      speed,
      setSpeed,
      setFollow,
      jump(i: number) {
        setFollow(false)
        setPlaying(false)
        setStep(Math.max(0, Math.min(last, i)))
      },
      toggle() {
        setFollow(false)
        if (step >= last) setStep(0)
        setPlaying((p) => !p)
      },
    }),
    [step, last, live, follow, playing, speed],
  )
}
export type Replay = ReturnType<typeof useReplay>
