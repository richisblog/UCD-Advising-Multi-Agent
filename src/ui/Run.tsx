import { useState } from 'react'
import type { Endpoint, EvidenceView, LabState } from '../contract.js'
import type { RunRecord, Scenario } from '../core/types.js'
import { fmt, kTok, lbl, METHOD_ZH, secs, STATUS_ZH, TYPE_ZH, VERDICT_ZH, type T } from './i18n.js'
import { Process } from './Process.js'
import { evidenceTitle } from './replay.js'

export type Request = <R = unknown>(endpoint: Endpoint, payload?: unknown) => Promise<R>

// One run: what the student sees (summary), how it got there (process), and
// how it scored. Used by Consult (live) and Experiment (replay).

function Cite({ ids, evidence, t }: { ids: string[]; evidence: Record<string, EvidenceView>; t: T }) {
  const [open, setOpen] = useState<string>()
  if (!ids.length) return <span className="pl-tag warn">{t('no source', '无来源')}</span>
  const ev = open ? evidence[open] : undefined
  return (
    <span className="pl-cite">
      {ids.map((id) => (
        <button key={id} type="button" className={`pl-doc-chip ${evidence[id] ? '' : 'missing'} ${open === id ? 'on' : ''}`} title={evidence[id] ? id : t('Not retrieved in this run', '本次未检索到')} onClick={() => setOpen(open === id ? undefined : id)}>
          {evidence[id] ? evidenceTitle(id, evidence) : id}
        </button>
      ))}
      {ev && (
        <blockquote className="pl-excerpt">
          <small>
            {ev.heading} · {ev.scope} · {ev.retrievedAt}
            {ev.legacy && ` · ${t('legacy record', '旧记录')}`}
          </small>
          <span>{ev.text.length > 600 ? `${ev.text.slice(0, 600)}…` : ev.text}</span>
          {ev.url && (
            <a href={ev.url} target="_blank" rel="noreferrer">
              {t('Open official page ↗', '打开官方页面 ↗')}
            </a>
          )}
        </blockquote>
      )}
    </span>
  )
}

export function Summary({ run, evidence, t }: { run: RunRecord; evidence: Record<string, EvidenceView>; t: T }) {
  const r = run.report
  if (!r) return null
  return (
    <div className="pl-summary">
      <section className="pl-letter">
        <h4>{t('Reply to the student', '给学生的回复')}</h4>
        <p>{r.reply}</p>
      </section>
      {r.profile.length > 0 && (
        <section>
          <h4>{t('What we know about you', '已确认的情况')}</h4>
          <ul className="pl-chips">
            {r.profile.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </section>
      )}
      {r.options.length > 0 && (
        <section>
          <h4>{t('Paths you could take', '可选路径')}</h4>
          <div className="pl-options">
            {r.options.map((o, i) => (
              <article key={i} className="pl-option">
                <span className="pl-option-no">{String.fromCharCode(65 + i)}</span>
                <h5>{o.title}</h5>
                {o.why && <p className="pl-muted">{o.why}</p>}
                {o.steps.length > 0 && (
                  <ol>
                    {o.steps.map((s, j) => (
                      <li key={j}>{s}</li>
                    ))}
                  </ol>
                )}
                <Cite ids={o.evidence} evidence={evidence} t={t} />
              </article>
            ))}
          </div>
        </section>
      )}
      {r.claims.length > 0 && (
        <section>
          <h4>{t('Rules this advice relies on', '建议所依据的规则')}</h4>
          <ul className="pl-claims">
            {r.claims.map((c, i) => {
              const v = run.score?.claims[i]?.verdict
              return (
                <li key={i} className={v ? `v-${v}` : ''}>
                  <p>
                    {c.critical && <span className="pl-tag">{t('key', '关键')}</span>}
                    {v && <span className={`pl-tag v-${v}`}>{lbl(t, VERDICT_ZH, v)}</span>} {c.text}
                  </p>
                  <Cite ids={c.evidence} evidence={evidence} t={t} />
                </li>
              )
            })}
          </ul>
        </section>
      )}
      <div className="pl-two">
        {r.uncertain.length > 0 && (
          <section className="pl-callout warn">
            <h4>{t('Still to confirm', '仍需确认')}</h4>
            <ul>
              {r.uncertain.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </section>
        )}
        {r.advisor_questions.length > 0 && (
          <section className="pl-callout">
            <h4>{t('Bring these to your advisor', '带去问顾问的问题')}</h4>
            <ul className="pl-checks">
              {r.advisor_questions.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {r.referral.needed && (
        <p className="pl-referral">
          ➜ <b>{r.referral.office}</b>
          {r.referral.reason && ` — ${r.referral.reason}`}
        </p>
      )}
      <p className="pl-disclaimer">{t('Preparation support only — not an official eligibility decision.', '仅用于准备面谈，不是官方资格认定。')}</p>
    </div>
  )
}

function Score({ run, scenario, t }: { run: RunRecord; scenario?: Scenario; t: T }) {
  const s = run.score!
  return (
    <div className="pl-score">
      <div className="pl-kpis">
        <div className="pl-kpi">
          <b>{fmt(s.checklistPct, 0)}%</b>
          <span>{t('checklist satisfied', '清单满足率')}</span>
        </div>
        <div className="pl-kpi">
          <b>{s.unsupportedCritical}</b>
          <span>{t('unsupported key claims', '无依据关键论断')}</span>
        </div>
        <div className="pl-kpi">
          <b>
            {s.validCitations}
            <small>/{s.validCitations + s.invalidCitations}</small>
          </b>
          <span>{t('valid citations', '有效引用')}</span>
        </div>
        <div className="pl-kpi">
          <b>
            {s.criticalFactsElicited}
            <small>/{s.criticalFactsTotal}</small>
          </b>
          <span>{t('key facts asked', '关键事实已问到')}</span>
        </div>
      </div>
      <ul className="pl-score-items">
        {s.items.map((i) => (
          <li key={i.id}>
            <span className={`pl-score-bar s${i.score >= 1 ? 1 : i.score > 0 ? 5 : 0}`} style={{ width: `${Math.max(6, i.score * 100)}%` }} />
            <div>
              <p>
                <b>{i.id}</b> <span className="pl-tag">{lbl(t, TYPE_ZH, i.type)}</span> <span className="pl-tag">×{i.weight}</span>{' '}
                {scenario?.checklist.find((c) => c.id === i.id)?.text}
              </p>
              <p className="pl-muted">
                {i.score} · {lbl(t, METHOD_ZH, i.method)} — {i.why}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function RunCard({ run, state, request, refresh, t, scenario }: { run: RunRecord; state: LabState; request: Request; refresh: () => void; t: T; scenario?: Scenario }) {
  const [answer, setAnswer] = useState('')
  const [facts, setFacts] = useState<string[]>([])
  const [tab, setTab] = useState<'process' | 'summary' | 'score'>('process')
  const pending = state.pending.find((p) => p.runId === run.id)
  const send = async () => {
    if (!answer.trim()) return
    await request('answer', { runId: run.id, text: answer, facts })
    setAnswer('')
    setFacts([])
    refresh()
  }
  return (
    <article className={`pl-run c-${run.condition}`}>
      <header className="pl-run-head">
        <span className={`pl-badge c-${run.condition}`}>{run.condition === 'A' ? t('A · Single agent', 'A · 单 Agent') : t('B · Multi-agent team', 'B · 多 Agent 团队')}</span>
        <span className={`pl-status s-${run.status}`}>{lbl(t, STATUS_ZH, run.status)}</span>
        <span className="pl-muted">
          {secs(run.usage.wallMs || Date.now() - run.startedAt)} · {kTok(run.usage.tokens)} tokens · {run.usage.modelCalls} {t('calls', '次调用')}
        </span>
        {run.status === 'running' && (
          <button type="button" className="pl-btn ghost" onClick={() => request('stop', { runId: run.id }).then(refresh)}>
            {t('Stop', '停止')}
          </button>
        )}
      </header>
      {run.error && <p className="pl-warn">{run.error}</p>}
      {pending && (
        <div className="pl-pending">
          <p className="pl-bubble agent">{pending.question}</p>
          {scenario && (
            <div className="pl-facts">
              <small>{t('Researcher view: hidden facts (tick what you disclose)', '研究员视图：隐藏事实（勾选你透露的）')}</small>
              {scenario.facts.map((f) => (
                <label key={f.id} title={f.answer}>
                  <input
                    type="checkbox"
                    checked={facts.includes(f.id)}
                    onChange={(e) => {
                      setFacts((x) => (e.target.checked ? [...x, f.id] : x.filter((y) => y !== f.id)))
                      if (e.target.checked) setAnswer((a) => (a ? `${a} ${f.answer}` : f.answer))
                    }}
                  />
                  {f.topic}
                </label>
              ))}
            </div>
          )}
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} placeholder={t('Your answer…', '你的回答……')} />
          <button type="button" className="pl-btn primary" onClick={send} disabled={!answer.trim()}>
            {t('Reply', '回复')}
          </button>
        </div>
      )}
      <nav className="pl-subtabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'process'} className={tab === 'process' ? 'on' : ''} onClick={() => setTab('process')}>
          {t('How it worked', '查询过程')}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'summary'} className={tab === 'summary' ? 'on' : ''} onClick={() => setTab('summary')} disabled={!run.report}>
          {t('Advice', '建议总结')}
        </button>
        {run.score && (
          <button type="button" role="tab" aria-selected={tab === 'score'} className={tab === 'score' ? 'on' : ''} onClick={() => setTab('score')}>
            {t('Score', '评分')} {fmt(run.score.checklistPct, 0)}%
          </button>
        )}
      </nav>
      {tab === 'process' && <Process run={run} evidence={state.evidence} t={t} />}
      {tab === 'summary' && <Summary run={run} evidence={state.evidence} t={t} />}
      {tab === 'score' && run.score && <Score run={run} scenario={scenario} t={t} />}
    </article>
  )
}

/** Side-by-side cost/coverage comparison for an A+B consult. */
export function CompareStrip({ runs, t }: { runs: RunRecord[]; t: T }) {
  const a = runs.find((r) => r.condition === 'A')
  const b = runs.find((r) => r.condition === 'B')
  if (!a || !b) return null
  const resolved = (r: RunRecord) => (r.checklist?.length ? r.checklist.filter((i) => i.status === 'answered' || i.status === 'blocked').length / r.checklist.length : NaN)
  const rows: { label: string; a: number; b: number; show: (x: number) => string; lowerBetter?: boolean }[] = [
    { label: t('Checklist resolved', '信息清单完成'), a: resolved(a), b: resolved(b), show: (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—') },
    { label: t('Documents read', '查阅文件'), a: Object.keys(a.retrieved).length, b: Object.keys(b.retrieved).length, show: String },
    { label: t('Questions to student', '追问次数'), a: a.usage.clarifications, b: b.usage.clarifications, show: String },
    { label: 'Tokens', a: a.usage.tokens, b: b.usage.tokens, show: kTok, lowerBetter: true },
    { label: t('Model calls', '模型调用'), a: a.usage.modelCalls, b: b.usage.modelCalls, show: String, lowerBetter: true },
    { label: t('Time', '用时'), a: a.usage.wallMs || Date.now() - a.startedAt, b: b.usage.wallMs || Date.now() - b.startedAt, show: secs, lowerBetter: true },
  ]
  return (
    <section className="pl-card pl-compare">
      <h4>{t('A vs B at a glance', 'A 与 B 一览')}</h4>
      {rows.map((r) => {
        const max = Math.max(r.a || 0, r.b || 0, 1e-9)
        return (
          <div key={r.label} className="pl-compare-row">
            <span>{r.label}</span>
            <div className="pl-compare-bars">
              <i className="c-A" style={{ width: `${(100 * (r.a || 0)) / max}%` }}>
                {r.show(r.a)}
              </i>
              <i className="c-B" style={{ width: `${(100 * (r.b || 0)) / max}%` }}>
                {r.show(r.b)}
              </i>
            </div>
          </div>
        )
      })}
    </section>
  )
}
