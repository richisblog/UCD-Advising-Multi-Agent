import type { EvidenceView } from '../contract.js'
import type { InfoNeed, TraceEvent } from '../core/types.js'
import { NEED_EN, NEED_ZH, type T } from './i18n.js'
import { evidenceTitle } from './replay.js'

// Live information checklist: what the agent decided it must know, and which
// needs are already backed by evidence or by the student's own words.

export function ProgressRing({ done, total, size = 64, label }: { done: number; total: number; size?: number; label?: string }) {
  const r = size / 2 - 6
  const c = 2 * Math.PI * r
  const pct = total ? done / total : 0
  return (
    <svg className="pl-ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-label={label}>
      <circle cx={size / 2} cy={size / 2} r={r} className="pl-ring-bg" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="pl-ring-fg"
        strokeDasharray={`${c * pct} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle">
        {total ? `${done}/${total}` : '—'}
      </text>
    </svg>
  )
}

export function ChecklistBoard({
  items,
  changed,
  event,
  evidence,
  t,
  enabled,
}: {
  items: InfoNeed[]
  changed: Set<string>
  event?: TraceEvent
  evidence: Record<string, EvidenceView>
  t: T
  enabled: boolean
}) {
  const done = items.filter((i) => i.status === 'answered' || i.status === 'blocked').length
  const rejected = event?.kind === 'checklist' ? event.rejected : []
  return (
    <section className="pl-card pl-check">
      <header className="pl-card-head">
        <ProgressRing done={done} total={items.length} label={t('needs resolved', '已解决的信息需求')} />
        <div>
          <h4>{t('Information checklist', '信息清单')}</h4>
          <p className="pl-muted">
            {!enabled
              ? t('Checklist is off for this run.', '本次运行未开启信息清单。')
              : !items.length
                ? t('The agent writes its checklist on the first turn.', 'Agent 会在第一轮列出需要弄清的信息。')
                : done === items.length
                  ? t('Everything needed is known — time to answer.', '所需信息已齐，可以作答。')
                  : t(`${items.length - done} still open — research targets these only.`, `还有 ${items.length - done} 项待查，只针对这些继续查询。`)}
          </p>
        </div>
      </header>
      <ol className="pl-needs">
        {items.map((n) => (
          <li key={n.id} className={`pl-need s-${n.status} ${changed.has(n.id) ? 'changed' : ''}`}>
            <span className="pl-need-status">{t(NEED_EN[n.status]!, NEED_ZH[n.status]!)}</span>
            <div className="pl-need-body">
              <p>
                <span className="pl-need-kind" title={n.kind === 'student' ? t('Only the student can answer', '只有学生能回答') : t('Verify in official documents', '需要查官方文件')}>
                  {n.kind === 'student' ? '👤' : '📄'}
                </span>{' '}
                {n.question}
              </p>
              {n.facts.length > 0 && <p className="pl-quote">“{n.facts.join('” · “')}”</p>}
              {n.evidence.length > 0 && (
                <p className="pl-need-ev">
                  {[...new Map(n.evidence.map((id) => [evidenceTitle(id, evidence), id])).entries()].slice(0, 4).map(([title, id]) => (
                    <span key={id} className="pl-doc-chip" title={n.evidence.filter((x) => evidenceTitle(x, evidence) === title).join(', ')}>
                      {title}
                    </span>
                  ))}
                </p>
              )}
              {n.note && <p className="pl-note">{n.note}</p>}
            </div>
          </li>
        ))}
      </ol>
      {rejected.length > 0 && (
        <p className="pl-warn">
          {t('Controller rejected: ', '控制器驳回：')}
          {rejected.map((r) => `${r.id} (${r.reason})`).join('; ')}
        </p>
      )}
    </section>
  )
}
