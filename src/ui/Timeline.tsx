import type { RunRecord, TraceEvent } from '../core/types.js'
import { ROLE, roleShort, type T } from './i18n.js'
import type { Replay } from './replay.js'

// Swimlane timeline of the whole run: one row per participant, one mark per
// step, and the checklist progress as a filled band underneath. Click to jump.

const ROW = 22
const LEFT = 84
const STEP = 16

const MARK: Record<string, { cls: string; glyph: string; en: string; zh: string }> = {
  student: { cls: 'k-ask', glyph: '●', en: 'student message', zh: '学生发言' },
  ask: { cls: 'k-ask', glyph: '?', en: 'question to student', zh: '追问学生' },
  search: { cls: 'k-search', glyph: 'S', en: 'document search', zh: '检索文件' },
  course: { cls: 'k-search', glyph: 'C', en: 'course lookup', zh: '查课程' },
  delegate: { cls: 'k-delegate', glyph: '→', en: 'delegation', zh: '委派' },
  handoff: { cls: 'k-handoff', glyph: '⇢', en: 'handoff', zh: '交接' },
  report: { cls: 'k-report', glyph: 'R', en: 'findings', zh: '回传结论' },
  checklist: { cls: 'k-plan', glyph: '✓', en: 'checklist update', zh: '更新清单' },
  limit: { cls: 'k-limit', glyph: '!', en: 'budget limit', zh: '预算限制' },
  error: { cls: 'k-limit', glyph: '!', en: 'error', zh: '错误' },
}

function actorOf(e: TraceEvent): string {
  switch (e.kind) {
    case 'student':
      return 'student'
    case 'delegate':
    case 'handoff':
      return e.from
    case 'limit':
    case 'error':
      return '_system'
    default:
      return (e as { agent?: string }).agent ?? '_system'
  }
}

export function Timeline({ run, events, replay, t }: { run: RunRecord; events: TraceEvent[]; replay: Replay; t: T }) {
  const lead = run.condition === 'B' ? 'personal' : 'advisor'
  const order = ['student', lead, ...Object.keys(ROLE).filter((r) => r !== 'student' && r !== 'advisor' && r !== 'personal')]
  const present = new Set(events.map(actorOf))
  for (const e of events) if (e.kind === 'delegate' || e.kind === 'handoff') present.add(e.to)
  const rows = order.filter((r) => r === 'student' || r === lead || present.has(r))
  const width = Math.max(560, LEFT + events.length * STEP + 24)
  const bandTop = rows.length * ROW + 10
  const height = bandTop + 34
  const x = (i: number) => LEFT + i * STEP + STEP / 2
  const y = (r: string) => rows.indexOf(r) * ROW + ROW / 2 + 4

  // checklist progress after each step
  let resolved = 0
  let total = 0
  const progress = events.map((e) => {
    if (e.kind === 'checklist') {
      total = e.items.length
      resolved = e.items.filter((i) => i.status === 'answered' || i.status === 'blocked').length
    }
    return total ? resolved / total : 0
  })
  const area =
    progress.length > 0
      ? `M${x(0)},${bandTop + 24} ` + progress.map((p, i) => `L${x(i)},${bandTop + 24 - p * 20}`).join(' ') + ` L${x(progress.length - 1)},${bandTop + 24} Z`
      : ''

  return (
    <section className="pl-card pl-timeline">
      <header className="pl-row">
        <h4>{t('Timeline', '时间线')}</h4>
        <span className="pl-muted">{t('Each mark is one step — click to jump there.', '每个标记是一步，点击可跳转。')}</span>
      </header>
      <div className="pl-tl-scroll">
        <svg width={width} height={height} className="pl-tl">
          {rows.map((r, i) => (
            <g key={r}>
              <rect x={0} y={i * ROW + 4} width={width} height={ROW} className={i % 2 ? 'pl-tl-row odd' : 'pl-tl-row'} />
              <text x={8} y={y(r) + 4} className="pl-tl-name" style={{ fill: ROLE[r]?.color }}>
                {roleShort(t, r)}
              </text>
            </g>
          ))}
          <text x={8} y={bandTop + 18} className="pl-tl-name">
            {t('Checklist', '清单')}
          </text>
          {area && <path d={area} className="pl-tl-band" />}
          {/* connectors for delegations, handoffs, reports */}
          {events.map((e, i) =>
            e.kind === 'delegate' || e.kind === 'handoff' ? (
              <line key={`c${i}`} x1={x(i)} y1={y(e.from)} x2={x(i)} y2={y(e.to)} className={`pl-tl-link ${e.kind === 'handoff' ? 'k-handoff' : 'k-delegate'}`} />
            ) : e.kind === 'report' && rows.includes(lead) ? (
              <line key={`c${i}`} x1={x(i)} y1={y(e.agent)} x2={x(i)} y2={y(lead)} className="pl-tl-link k-report" />
            ) : e.kind === 'ask' ? (
              <line key={`c${i}`} x1={x(i)} y1={y(e.agent)} x2={x(i)} y2={y('student')} className="pl-tl-link k-ask" />
            ) : null,
          )}
          {events.map((e, i) => {
            if (e.kind === 'thought') return null
            const m = MARK[e.kind]!
            const actor = actorOf(e)
            const row = rows.includes(actor) ? actor : lead
            return (
              <g key={i} className={`pl-tl-mark ${m.cls} ${i === replay.step ? 'on' : ''}`} transform={`translate(${x(i)},${y(row)})`} onClick={() => replay.jump(i)}>
                <title>{`${i + 1}. ${t(m.en, m.zh)}`}</title>
                <circle r={7} />
                <text y={3.5}>{m.glyph}</text>
              </g>
            )
          })}
          <line x1={x(replay.step)} x2={x(replay.step)} y1={0} y2={height} className="pl-tl-cursor" />
        </svg>
      </div>
    </section>
  )
}
