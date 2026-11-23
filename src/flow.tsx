import { useEffect, useMemo, useRef, useState } from 'react'
import type { EvidenceView } from './contract.js'
import type { RunRecord, TraceEvent } from './core/types.js'

// Animated, replayable picture of one run: the student, the agents, the
// institutional evidence lanes, and every question, delegation, handoff,
// retrieval and report as it happens. Built for live demos.

type T = (en: string, zh: string) => string

const W = 780
const H = 470
const LANES = [
  { unit: 'university', x: 70, en: 'University', zh: '校级', level: 'u' },
  { unit: 'ls', x: 180, en: 'Letters & Sci.', zh: '文理学院', level: 'c' },
  { unit: 'coe', x: 290, en: 'Engineering', zh: '工程学院', level: 'c' },
  { unit: 'ecs', x: 410, en: 'Computer Sci.', zh: '计算机系', level: 'd' },
  { unit: 'psc', x: 520, en: 'Psychology', zh: '心理学系', level: 'd' },
  { unit: 'lin', x: 630, en: 'Linguistics', zh: '语言学系', level: 'd' },
  { unit: 'mat', x: 730, en: 'Mathematics', zh: '数学系', level: 'd' },
] as const
const ROLE_UNIT: Record<string, string> = {
  university: 'university',
  'college-ls': 'ls',
  'college-coe': 'coe',
  'dept-ecs': 'ecs',
  'dept-psc': 'psc',
  'dept-lin': 'lin',
  'dept-mat': 'mat',
}
const COURSE_UNIT: Record<string, string> = { ECS: 'ecs', PSC: 'psc', LIN: 'lin', MAT: 'mat', STA: 'mat' }
const Y = { student: 42, lead: 132, spec: 250, lane: 330 }

function laneX(unit: string) {
  return LANES.find((l) => l.unit === unit)?.x ?? 70
}
function unitOfEvidence(id: string, evidence: Record<string, EvidenceView>) {
  if (id.startsWith('COURSE:')) return COURSE_UNIT[id.slice(7).split(' ')[0] ?? ''] ?? 'university'
  const scope = evidence[id]?.scope
  if (scope?.includes('/')) return scope.split('/')[1]!
  const prefix = id.split('-')[0]
  return { UNI: 'university', LS: 'ls', COE: 'coe', ECS: 'ecs', PSC: 'psc', LIN: 'lin', MAT: 'mat', LEGACY: 'mat' }[prefix ?? ''] ?? 'university'
}
function docOf(id: string) {
  return id.startsWith('COURSE:') ? id.slice(7) : id.split('#')[0]!
}

interface Pt {
  x: number
  y: number
}
interface Arrow {
  from: Pt
  to: Pt
  kind: 'ask' | 'reply' | 'delegate' | 'handoff' | 'report' | 'search' | 'final'
  label?: string
}

export function FlowView({ run, evidence, t }: { run: RunRecord; evidence: Record<string, EvidenceView>; t: T }) {
  const multi = run.condition === 'B'
  const events = run.trace
  const live = run.status === 'running'
  const [step, setStep] = useState(events.length - 1)
  const [follow, setFollow] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const last = events.length - 1
  const box = useRef<HTMLDivElement>(null)
  const present = () => {
    const el = box.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen?.()
  }

  // live runs follow the newest event unless the viewer scrubs back
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
    }, 1100 / speed)
    return () => clearInterval(timer)
  }, [playing, speed, last])

  const pos = useMemo(() => {
    const p: Record<string, Pt> = { student: { x: W / 2, y: Y.student } }
    if (multi) {
      p.personal = { x: W / 2, y: Y.lead }
      for (const [role, unit] of Object.entries(ROLE_UNIT)) p[role] = { x: laneX(unit), y: Y.spec }
    } else p.advisor = { x: W / 2, y: Y.lead }
    return p
  }, [multi])
  const lead = multi ? 'personal' : 'advisor'

  // Accumulate state up to the current step.
  const view = useMemo(() => {
    const docs = new Map<string, { unit: string; hits: number; lastStep: number }>()
    const agentStats: Record<string, { searches: number; findings: number; asks: number; active: number }> = {}
    const stat = (a: string) => (agentStats[a] ??= { searches: 0, findings: 0, asks: 0, active: -1 })
    let facts = 0
    for (let i = 0; i <= step && i < events.length; i++) {
      const e = events[i]!
      if (e.kind === 'search' || e.kind === 'course') {
        const ids = e.kind === 'search' ? e.results : e.found ? [`COURSE:${e.code.toUpperCase()}`] : []
        for (const id of ids) {
          const key = docOf(id)
          const d = docs.get(key) ?? { unit: unitOfEvidence(id, evidence), hits: 0, lastStep: i }
          d.hits += 1
          d.lastStep = i
          docs.set(key, d)
        }
        stat(e.agent).searches += 1
        stat(e.agent).active = i
      } else if (e.kind === 'ask') {
        stat(e.agent).asks += 1
        stat(e.agent).active = i
        facts += e.facts.length
      } else if (e.kind === 'report') {
        stat(e.agent).findings += e.findings.length
        stat(e.agent).active = i
      } else if (e.kind === 'delegate') {
        stat(e.from).active = i
        stat(e.to).active = i
      } else if (e.kind === 'handoff') {
        stat(e.from).active = i
        if (e.accepted) stat(e.to).active = i
      } else if (e.kind === 'thought') stat(e.agent).active = i
    }
    return { docs, agentStats, facts }
  }, [events, step, evidence])

  const current: TraceEvent | undefined = events[step]
  const arrows: Arrow[] = []
  const hotDocs = new Set<string>()
  if (current) {
    const at = (a: string) => pos[a] ?? pos[lead]!
    switch (current.kind) {
      case 'student':
        arrows.push({ from: pos.student!, to: at(lead), kind: 'ask', label: t('opening', '开场') })
        break
      case 'ask':
        arrows.push({ from: at(current.agent), to: pos.student!, kind: 'ask', label: '?' })
        arrows.push({ from: pos.student!, to: at(current.agent), kind: 'reply' })
        break
      case 'delegate':
        arrows.push({ from: at(current.from), to: at(current.to), kind: 'delegate' })
        break
      case 'handoff':
        arrows.push({ from: at(current.from), to: at(current.to), kind: 'handoff' })
        break
      case 'report':
        arrows.push({ from: at(current.agent), to: at(lead), kind: 'report' })
        break
      case 'search':
      case 'course': {
        const ids = current.kind === 'search' ? current.results : [`COURSE:${current.code.toUpperCase()}`]
        for (const id of ids) {
          hotDocs.add(docOf(id))
          arrows.push({ from: at(current.agent), to: { x: laneX(unitOfEvidence(id, evidence)), y: Y.lane + 8 }, kind: 'search' })
        }
        break
      }
    }
  }
  const finished = !live && step >= last && run.report
  if (finished) arrows.push({ from: pos[lead]!, to: pos.student!, kind: 'final', label: t('summary', '总结') })

  // documents stacked under their lane
  const byLane = new Map<string, string[]>()
  for (const [doc, d] of view.docs) byLane.set(d.unit, [...(byLane.get(d.unit) ?? []), doc])

  const node = (id: string, label: string, sub?: string, kind = '') => {
    const p = pos[id]
    if (!p) return null
    const s = view.agentStats[id]
    const isActive = s && s.active === step
    const used = Boolean(s)
    return (
      <g key={id} className={`fl-node ${kind} ${isActive ? 'active' : ''} ${used ? 'used' : 'idle'}`} transform={`translate(${p.x},${p.y})`}>
        <rect x={-52} y={-20} width={104} height={40} rx={12} />
        <text y={-3} className="fl-name">
          {label}
        </text>
        <text y={12} className="fl-sub">
          {sub ?? (s ? `🔎${s.searches} · ✓${s.findings}${s.asks ? ` · ❓${s.asks}` : ''}` : t('idle', '待命'))}
        </text>
      </g>
    )
  }

  const line = (a: Arrow, i: number) => {
    const dx = a.to.x - a.from.x
    const dy = a.to.y - a.from.y
    const len = Math.hypot(dx, dy) || 1
    const ox = (dx / len) * 22
    const oy = (dy / len) * 22
    const bend = a.kind === 'reply' ? 26 : a.kind === 'handoff' ? -40 : 0
    const x1 = a.from.x + ox
    const y1 = a.from.y + oy
    const x2 = a.to.x - ox
    const y2 = a.to.y - oy
    const mx = (x1 + x2) / 2 + (bend * -dy) / len
    const my = (y1 + y2) / 2 + (bend * dx) / len
    const d = `M${x1},${y1} Q${mx},${my} ${x2},${y2}`
    return (
      <g key={`${step}-${i}`} className={`fl-arrow k-${a.kind}`}>
        <path d={d} markerEnd={`url(#fl-head-${a.kind})`} />
        <circle r={4.5}>
          <animateMotion dur={`${1 / speed}s`} repeatCount="indefinite" path={d} />
        </circle>
        {a.label && (
          <text x={mx} y={my - 6} className="fl-label">
            {a.label}
          </text>
        )}
      </g>
    )
  }

  const caption = current ? describe(current, t) : t('Waiting for the first event…', '等待第一个事件……')
  const kinds = ['ask', 'reply', 'delegate', 'handoff', 'report', 'search', 'final'] as const

  return (
    <div className="fl" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Agent interaction diagram', '智能体交互示意图')}>
        <defs>
          {kinds.map((k) => (
            <marker key={k} id={`fl-head-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className={`fl-head k-${k}`} />
            </marker>
          ))}
        </defs>
        {/* institutional tiers */}
        <rect x={10} y={Y.lane - 18} width={W - 20} height={H - Y.lane + 10} rx={14} className="fl-tier" />
        <text x={18} y={Y.lane - 24} className="fl-tiername">
          {t('Evidence by responsibility (official pages + catalog)', '按职责划分的证据（官方页面与课程库）')}
        </text>
        {LANES.map((l) => (
          <g key={l.unit}>
            <text x={l.x} y={Y.lane} className={`fl-lane lv-${l.level}`}>
              {t(l.en, l.zh)}
            </text>
            {(byLane.get(l.unit) ?? []).slice(-7).map((doc, i) => (
              <g key={doc} transform={`translate(${l.x},${Y.lane + 20 + i * 18})`} className={`fl-doc ${hotDocs.has(doc) ? 'hot' : ''}`}>
                <rect x={-50} y={-9} width={100} height={15} rx={4} />
                <text y={2}>{doc.length > 16 ? `${doc.slice(0, 15)}…` : doc}</text>
              </g>
            ))}
          </g>
        ))}
        {multi && (
          <>
            <text x={18} y={Y.spec - 34} className="fl-tiername">
              {t('Specialists (each can only read its own lane)', '专家（只能读自己那一列的文档）')}
            </text>
            {Object.entries(ROLE_UNIT).map(([role, unit]) => (
              <line key={role} x1={laneX(unit)} y1={Y.spec + 20} x2={laneX(unit)} y2={Y.lane - 18} className="fl-scope" />
            ))}
          </>
        )}
        {arrows.map(line)}
        {node('student', t('Student', '学生'), `${t('facts shared', '已透露事实')} ${view.facts}`, 'stu')}
        {multi
          ? node('personal', t('Personal Agent', '个人顾问'), undefined, 'lead')
          : node('advisor', t('Single Advisor', '单 Agent 顾问'), undefined, 'lead')}
        {multi &&
          Object.entries(ROLE_UNIT).map(([role, unit]) => {
            const l = LANES.find((x) => x.unit === unit)!
            return node(role, t(l.en, l.zh))
          })}
      </svg>
      <div className={`fl-caption k-${current?.kind ?? 'none'}`}>
        <b>
          {step + 1}/{events.length}
        </b>{' '}
        {caption}
      </div>
      <div className="fl-controls">
        <button type="button" onClick={() => { setFollow(false); setPlaying(false); setStep(0) }} title={t('Start', '回到开头')}>
          ⏮
        </button>
        <button type="button" onClick={() => { setFollow(false); setPlaying(false); setStep((s) => Math.max(0, s - 1)) }} title={t('Back', '上一步')}>
          ◀
        </button>
        <button
          type="button"
          className="fl-play"
          onClick={() => {
            setFollow(false)
            if (step >= last) setStep(0)
            setPlaying((p) => !p)
          }}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button type="button" onClick={() => { setFollow(false); setPlaying(false); setStep((s) => Math.min(last, s + 1)) }} title={t('Next', '下一步')}>
          ▶|
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(0, last)}
          value={Math.max(0, step)}
          onChange={(e) => {
            setFollow(false)
            setPlaying(false)
            setStep(Number(e.target.value))
          }}
        />
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          <option value={0.5}>0.5×</option>
          <option value={1}>1×</option>
          <option value={2}>2×</option>
          <option value={4}>4×</option>
        </select>
        <button type="button" onClick={present} title={t('Full-screen presentation', '全屏演示')}>
          ⛶ {t('Present', '演示')}
        </button>
        <label>
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> {live ? t('Follow live', '实时跟随') : t('Show end', '显示结尾')}
        </label>
      </div>
      <ul className="fl-legend">
        <li className="k-ask">{t('question to student', '追问学生')}</li>
        <li className="k-delegate">{t('delegation', '委派任务')}</li>
        <li className="k-handoff">{t('specialist handoff', '专家互相交接')}</li>
        <li className="k-report">{t('findings returned', '回传结论')}</li>
        <li className="k-search">{t('evidence retrieval', '检索证据')}</li>
      </ul>
    </div>
  )
}

function describe(e: TraceEvent, t: T): string {
  const name = (a: string) =>
    t(
      a,
      {
        advisor: '单 Agent 顾问',
        personal: '个人顾问',
        university: '校级政策',
        'college-ls': '文理学院',
        'college-coe': '工程学院',
        'dept-ecs': '计算机系',
        'dept-psc': '心理学系',
        'dept-lin': '语言学系',
        'dept-mat': '数学系',
      }[a] ?? a,
    )
  switch (e.kind) {
    case 'student':
      return `${t('Student', '学生')}: “${e.text}”`
    case 'ask':
      return `${name(e.agent)} ❓ ${e.question}  →  ${t('Student', '学生')}: ${e.reply}`
    case 'search':
      return `${name(e.agent)} 🔎 “${e.query}” [${e.scope}] → ${e.results.join(', ') || t('nothing', '无结果')}${e.repeated ? t(' (repeat)', '（重复检索）') : ''}`
    case 'course':
      return `${name(e.agent)} 📘 ${e.code}${e.found ? '' : t(' (not found)', '（未找到）')}`
    case 'delegate':
      return `${name(e.from)} → ${name(e.to)}: ${e.question}`
    case 'handoff':
      return `${name(e.from)} ⇢ ${name(e.to)}${e.accepted ? '' : t(' (rejected)', '（被拒）')}: ${e.question}`
    case 'report':
      return `${name(e.agent)} ✓ ${e.findings.map((f) => `${f.claim} [${f.evidence.join(', ')}]`).join(' · ') || t('no findings', '没有结论')}`
    case 'thought':
      return `${name(e.agent)} 💭 ${e.text}`
    case 'limit':
      return `⚠ ${e.detail}`
    case 'error':
      return `⚠ ${e.detail}`
  }
}
