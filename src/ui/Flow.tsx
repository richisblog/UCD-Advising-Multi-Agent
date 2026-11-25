import type { EvidenceView } from '../contract.js'
import type { RunRecord } from '../core/types.js'
import { normalizeCourse } from '../core/retrieval.js'
import { roleShort, type T } from './i18n.js'
import { docOf, evidenceTitle, unitOfEvidence, type Snapshot } from './replay.js'

// The agent diagram: student on top, the lead agent, the specialists (B), and
// one evidence column per institutional unit. Arrows animate the current step.

const W = 800
export const LANES = [
  { unit: 'university', x: 72, en: 'University', zh: '校级', tier: 'u' },
  { unit: 'ls', x: 182, en: 'Letters & Sci.', zh: '文理学院', tier: 'c' },
  { unit: 'coe', x: 292, en: 'Engineering', zh: '工程学院', tier: 'c' },
  { unit: 'ecs', x: 418, en: 'Computer Sci.', zh: '计算机系', tier: 'd' },
  { unit: 'psc', x: 528, en: 'Psychology', zh: '心理学系', tier: 'd' },
  { unit: 'lin', x: 638, en: 'Linguistics', zh: '语言学系', tier: 'd' },
  { unit: 'mat', x: 744, en: 'Mathematics', zh: '数学系', tier: 'd' },
] as const
export const ROLE_UNIT: Record<string, string> = {
  university: 'university',
  'college-ls': 'ls',
  'college-coe': 'coe',
  'dept-ecs': 'ecs',
  'dept-psc': 'psc',
  'dept-lin': 'lin',
  'dept-mat': 'mat',
}
const Y_MULTI = { student: 44, lead: 138, spec: 254, lane: 336 }
const Y_SINGLE = { student: 44, lead: 138, spec: 0, lane: 232 }
const laneX = (unit: string) => LANES.find((l) => l.unit === unit)?.x ?? 72

interface Pt {
  x: number
  y: number
}
type Kind = 'ask' | 'reply' | 'delegate' | 'handoff' | 'report' | 'search' | 'final' | 'plan'
interface Arrow {
  from: Pt
  to: Pt
  kind: Kind
  label?: string
}
const KINDS: Kind[] = ['ask', 'reply', 'delegate', 'handoff', 'report', 'search', 'final', 'plan']

export function Flow({ run, snap, evidence, t, final }: { run: RunRecord; snap: Snapshot; evidence: Record<string, EvidenceView>; t: T; final: boolean }) {
  const multi = run.condition === 'B'
  const Y = multi ? Y_MULTI : Y_SINGLE
  const laneDocs = Math.min(6, Math.max(2, ...[...snap.docs.values()].reduce((m, d) => m.set(d.unit, (m.get(d.unit) ?? 0) + 1), new Map<string, number>()).values()))
  const H = Y.lane + 34 + laneDocs * 24
  const lead = multi ? 'personal' : 'advisor'
  const pos: Record<string, Pt> = { student: { x: W / 2, y: Y.student }, [lead]: { x: W / 2, y: Y.lead } }
  if (multi) for (const [role, unit] of Object.entries(ROLE_UNIT)) pos[role] = { x: laneX(unit), y: Y.spec }
  const at = (a: string) => pos[a] ?? pos[lead]!

  const e = snap.event
  const arrows: Arrow[] = []
  const hot = new Set<string>()
  if (e) {
    if (e.kind === 'student') arrows.push({ from: pos.student!, to: at(lead), kind: 'ask', label: t('question', '提问') })
    else if (e.kind === 'ask') {
      arrows.push({ from: at(e.agent), to: pos.student!, kind: 'ask', label: '?' })
      arrows.push({ from: pos.student!, to: at(e.agent), kind: 'reply' })
    } else if (e.kind === 'delegate') arrows.push({ from: at(e.from), to: at(e.to), kind: 'delegate', label: t('task', '任务') })
    else if (e.kind === 'handoff') arrows.push({ from: at(e.from), to: at(e.to), kind: 'handoff', label: t('handoff', '交接') })
    else if (e.kind === 'report') arrows.push({ from: at(e.agent), to: at(lead), kind: 'report', label: `✓${e.findings.length}` })
    else if (e.kind === 'search' || e.kind === 'course') {
      const ids = e.kind === 'search' ? e.results : [`COURSE:${normalizeCourse(e.code) ?? e.code}`]
      const seen = new Set<string>()
      for (const id of ids) {
        hot.add(docOf(id))
        const unit = unitOfEvidence(id, evidence)
        if (seen.has(unit)) continue
        seen.add(unit)
        arrows.push({ from: at(e.agent), to: { x: laneX(unit), y: Y.lane + 6 }, kind: 'search' })
      }
    }
  }
  if (final && run.report) arrows.push({ from: pos[lead]!, to: pos.student!, kind: 'final', label: t('summary', '总结') })

  const byLane = new Map<string, [string, Snapshot['docs'] extends Map<string, infer V> ? V : never][]>()
  for (const [doc, d] of snap.docs) byLane.set(d.unit, [...(byLane.get(d.unit) ?? []), [doc, d]])

  const node = (id: string, label: string, sub: string, cls: string) => {
    const p = pos[id]
    if (!p) return null
    const s = snap.agents[id]
    const active = (s && s.lastStep === snap.index) || (id === 'student' && (e?.kind === 'student' || e?.kind === 'ask'))
    return (
      <g key={id} className={`fl-node ${cls} ${active ? 'active' : ''} ${s || id === 'student' ? 'used' : 'idle'}`} transform={`translate(${p.x},${p.y})`}>
        <rect x={-54} y={-22} width={108} height={44} rx={13} />
        <text y={-4} className="fl-name">
          {label}
        </text>
        <text y={12} className="fl-sub">
          {sub}
        </text>
      </g>
    )
  }
  const stats = (id: string) => {
    const s = snap.agents[id]
    if (!s) return t('idle', '待命')
    const parts = [s.searches && `🔎${s.searches}`, s.findings && `✓${s.findings}`, s.asks && `❓${s.asks}`, s.delegations && `→${s.delegations}`].filter(Boolean)
    return parts.join(' · ') || t('thinking', '思考')
  }

  const line = (a: Arrow, i: number) => {
    const dx = a.to.x - a.from.x
    const dy = a.to.y - a.from.y
    const len = Math.hypot(dx, dy) || 1
    const pad = 24
    const x1 = a.from.x + (dx / len) * pad
    const y1 = a.from.y + (dy / len) * pad
    const x2 = a.to.x - (dx / len) * pad
    const y2 = a.to.y - (dy / len) * pad
    const bend = a.kind === 'reply' ? 28 : a.kind === 'handoff' ? -44 : 0
    const mx = (x1 + x2) / 2 + (bend * -dy) / len
    const my = (y1 + y2) / 2 + (bend * dx) / len
    const d = `M${x1},${y1} Q${mx},${my} ${x2},${y2}`
    return (
      <g key={`${snap.index}-${i}`} className={`fl-arrow k-${a.kind}`}>
        <path d={d} markerEnd={`url(#fl-head-${a.kind})`} />
        <circle r={5}>
          <animateMotion dur="1s" repeatCount="indefinite" path={d} />
        </circle>
        {a.label && (
          <g transform={`translate(${mx},${my - 4})`}>
            <rect x={-22} y={-11} width={44} height={16} rx={8} className="fl-pill" />
            <text y={1} className="fl-label">
              {a.label}
            </text>
          </g>
        )}
      </g>
    )
  }

  return (
    <svg className="fl-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('How the agents gathered information', '智能体查询资料的过程图')}>
      <defs>
        {KINDS.map((k) => (
          <marker key={k} id={`fl-head-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className={`fl-head k-${k}`} />
          </marker>
        ))}
      </defs>
      <rect x={8} y={Y.lane - 22} width={W - 16} height={H - Y.lane + 14} rx={16} className="fl-tier" />
      <text x={20} y={Y.lane - 30} className="fl-caption-svg">
        {t('Official evidence, one column per responsible office', '官方证据：每一列是一个负责部门')}
      </text>
      {LANES.map((l) => {
        const docs = byLane.get(l.unit) ?? []
        return (
          <g key={l.unit}>
            <text x={l.x} y={Y.lane - 2} className={`fl-lane tier-${l.tier}`}>
              {t(l.en, l.zh)}
            </text>
            {docs.slice(-6).map(([doc, d], i) => {
              const title = evidenceTitle([...d.ids][0]!, evidence)
              return (
                <g key={doc} transform={`translate(${l.x},${Y.lane + 20 + i * 24})`} className={`fl-doc ${hot.has(doc) ? 'hot' : ''} ${d.firstStep === snap.index ? 'new' : ''}`}>
                  <title>{`${title} (${doc}) · ${d.hits}×`}</title>
                  <rect x={-52} y={-10} width={104} height={20} rx={6} />
                  <text y={4}>{title.length > 17 ? `${title.slice(0, 16)}…` : title}</text>
                  {d.hits > 1 && (
                    <text x={46} y={-6} className="fl-hits">
                      ×{d.hits}
                    </text>
                  )}
                </g>
              )
            })}
            {docs.length > 6 && (
              <text x={l.x} y={Y.lane + 20 + 6 * 24} className="fl-more">
                +{docs.length - 6}
              </text>
            )}
          </g>
        )
      })}
      {multi && (
        <>
          <text x={20} y={Y.spec - 36} className="fl-caption-svg">
            {t('Specialists — each can only read its own column', '专家：每位只能读自己那一列')}
          </text>
          {Object.entries(ROLE_UNIT).map(([role, unit]) => (
            <line key={role} x1={laneX(unit)} y1={Y.spec + 22} x2={laneX(unit)} y2={Y.lane - 22} className="fl-scope" />
          ))}
        </>
      )}
      {arrows.map(line)}
      {node('student', t('Student', '学生'), `${t('shared', '已透露')} ${snap.factsShared}`, 'stu')}
      {node(lead, multi ? t('Personal Agent', '个人顾问') : t('Single Advisor', '单 Agent 顾问'), stats(lead), 'lead')}
      {multi && Object.keys(ROLE_UNIT).map((role) => node(role, roleShort(t, role), stats(role), 'spec'))}
    </svg>
  )
}
