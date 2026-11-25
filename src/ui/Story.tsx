import { useEffect, useRef, useState } from 'react'
import type { EvidenceView } from '../contract.js'
import type { TraceEvent } from '../core/types.js'
import { NEED_EN, NEED_ZH, ROLE, roleName, type T } from './i18n.js'
import { evidenceTitle, type Replay } from './replay.js'

// The run told as a story: one plain-language card per step, documents named
// by title (not id), with excerpts on demand. Follows the replay cursor.

const ICON: Record<string, string> = {
  student: '💬',
  ask: '❓',
  search: '🔎',
  course: '📘',
  delegate: '📨',
  handoff: '🔀',
  report: '✅',
  checklist: '☑️',
  limit: '⚠️',
  error: '⚠️',
}

const LIMIT_ZH: [RegExp, string][] = [
  [/forced final/i, '预算将尽：停止查询，直接给出最终回答'],
  [/clarification limit/i, '追问次数已用完'],
  [/tool-call limit/i, '检索次数已用完'],
  [/specialist-call limit/i, '专家调用次数已用完'],
  [/no budget left for another specialist/i, '剩余预算不足以再委派专家，保留给最终回答'],
  [/budget exhausted: tokens/i, 'token 预算用完'],
  [/budget exhausted: modelCalls/i, '模型调用次数用完'],
]
const limitZh = (d: string) => LIMIT_ZH.find(([re]) => re.test(d))?.[1] ?? d

/** One-line headline for a step (also used as the big caption). */
export function headline(e: TraceEvent | undefined, t: T): string {
  if (!e) return t('Waiting for the first step…', '等待第一步……')
  const who = (a: string) => roleName(t, a)
  switch (e.kind) {
    case 'student':
      return t('The student asks for help', '学生提出问题')
    case 'ask':
      return t(`${who(e.agent)} asks the student a follow-up question`, `${who(e.agent)} 追问学生`)
    case 'search':
      return e.results.length
        ? t(`${who(e.agent)} searches official documents and finds ${e.results.length} relevant passages`, `${who(e.agent)} 检索官方文件，找到 ${e.results.length} 段相关内容`)
        : t(`${who(e.agent)} searches but finds nothing relevant`, `${who(e.agent)} 检索后没有找到相关内容`)
    case 'course':
      return t(`${who(e.agent)} looks up course ${e.code}`, `${who(e.agent)} 查询课程 ${e.code}`)
    case 'delegate':
      return t(`${who(e.from)} hands a task to ${who(e.to)}`, `${who(e.from)} 把任务交给 ${who(e.to)}`)
    case 'handoff':
      return e.accepted
        ? t(`${who(e.from)} asks ${who(e.to)} for help`, `${who(e.from)} 请 ${who(e.to)} 协助`)
        : t(`${who(e.from)}'s handoff to ${who(e.to)} was refused`, `${who(e.from)} 交给 ${who(e.to)} 的请求被拒绝`)
    case 'report':
      return t(`${who(e.agent)} reports ${e.findings.length} finding(s)`, `${who(e.agent)} 回传 ${e.findings.length} 条结论`)
    case 'checklist': {
      const done = e.items.filter((i) => i.status === 'answered' || i.status === 'blocked').length
      return e.created
        ? t(`${who(e.agent)} lists ${e.items.length} things it must find out`, `${who(e.agent)} 列出 ${e.items.length} 项需要弄清的信息`)
        : t(`Checklist updated — ${done}/${e.items.length} resolved`, `信息清单更新：已解决 ${done}/${e.items.length}`)
    }
    case 'limit':
      return t(`Budget rule: ${e.detail}`, `预算规则：${limitZh(e.detail)}`)
    case 'error':
      return t(`Problem: ${e.detail}`, `出现问题：${e.detail}`)
    case 'thought':
      return e.text
  }
}

function Docs({ ids, evidence, t }: { ids: string[]; evidence: Record<string, EvidenceView>; t: T }) {
  const [open, setOpen] = useState<string>()
  if (!ids.length) return null
  const ev = open ? evidence[open] : undefined
  return (
    <div className="pl-docs">
      {ids.map((id) => (
        <button key={id} type="button" className={`pl-doc-chip ${open === id ? 'on' : ''} ${evidence[id] ? '' : 'missing'}`} onClick={(e) => { e.stopPropagation(); setOpen(open === id ? undefined : id) }} title={id}>
          {evidenceTitle(id, evidence)}
          {evidence[id]?.heading && evidence[id]!.heading !== '(page)' && <small> · {evidence[id]!.heading.split(' > ').at(-1)}</small>}
        </button>
      ))}
      {ev && (
        <blockquote className="pl-excerpt">
          <small>
            {ev.scope} · {t('retrieved', '抓取于')} {ev.retrievedAt}
            {ev.legacy && ` · ${t('legacy record — verify', '旧记录，需核实')}`}
          </small>
          <span>{ev.text.length > 700 ? `${ev.text.slice(0, 700)}…` : ev.text}</span>
          {ev.url && (
            <a href={ev.url} target="_blank" rel="noreferrer">
              {t('Open official page ↗', '打开官方页面 ↗')}
            </a>
          )}
        </blockquote>
      )}
    </div>
  )
}

function Detail({ e, evidence, t }: { e: TraceEvent; evidence: Record<string, EvidenceView>; t: T }) {
  switch (e.kind) {
    case 'student':
      return <p className="pl-bubble stu">{e.text}</p>
    case 'ask':
      return (
        <>
          <p className="pl-bubble agent">{e.question}</p>
          <p className="pl-bubble stu">{e.reply}</p>
        </>
      )
    case 'search':
      return (
        <>
          <p className="pl-muted">
            {t('Query', '检索词')}: “{e.query}” · {t('scope', '范围')} {e.scope}
            {e.repeated && <span className="pl-tag warn">{t('repeat search', '重复检索')}</span>}
          </p>
          <Docs ids={e.results} evidence={evidence} t={t} />
        </>
      )
    case 'course':
      return <p className="pl-muted">{e.found ? t('Catalog record found.', '找到课程记录。') : t('No catalog record.', '没有课程记录。')}</p>
    case 'delegate':
    case 'handoff':
      return (
        <>
          <p className="pl-bubble agent">{e.question}</p>
          {e.kind === 'delegate' && Object.keys(e.facts).length > 0 && (
            <p className="pl-muted">
              {t('Shared facts', '共享事实')}: {Object.entries(e.facts).map(([k, v]) => `${k}: ${v}`).join(' · ')}
            </p>
          )}
          {e.kind === 'handoff' && e.reason && <p className="pl-muted">{e.reason}</p>}
        </>
      )
    case 'report':
      return (
        <ul className="pl-findings">
          {e.findings.map((f, i) => (
            <li key={i}>
              <p>{f.claim}</p>
              {f.conditions.length > 0 && <p className="pl-muted">{t('When', '条件')}: {f.conditions.join('; ')}</p>}
              <Docs ids={f.evidence} evidence={evidence} t={t} />
            </li>
          ))}
          {e.missing.length > 0 && <li className="pl-muted">{t('Needs from student', '还需学生提供')}: {e.missing.join('; ')}</li>}
        </ul>
      )
    case 'checklist':
      return (
        <ul className="pl-mini-needs">
          {e.items
            .filter((i) => e.created || e.changed.includes(i.id))
            .map((i) => (
              <li key={i.id} className={`s-${i.status}`}>
                <b>{t(NEED_EN[i.status]!, NEED_ZH[i.status]!)}</b> {i.question}
              </li>
            ))}
          {e.rejected.map((r) => (
            <li key={`r-${r.id}`} className="pl-warn">
              {r.id}: {t('kept open', '保持未解决')} — {r.reason}
            </li>
          ))}
        </ul>
      )
    default:
      return null
  }
}

export function Story({ events, replay, evidence, t, showThoughts }: { events: TraceEvent[]; replay: Replay; evidence: Record<string, EvidenceView>; t: T; showThoughts: boolean }) {
  const box = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = box.current?.querySelector<HTMLElement>('.pl-story-item.on')
    const parent = box.current
    if (el && parent) parent.scrollTo({ top: el.offsetTop - parent.offsetTop - 12, behavior: 'smooth' })
  }, [replay.step])
  return (
    <section className="pl-card">
      <header className="pl-row">
        <h4>{t('Step by step', '逐步过程')}</h4>
        <span className="pl-muted">{t('Click a step to replay from there.', '点击任一步可从那里回放。')}</span>
      </header>
      <ol className="pl-story" ref={box}>
        {events.map((e, i) => {
          if (e.kind === 'thought') {
            return showThoughts ? (
              <li key={i} className="pl-thought">
                💭 <b>{roleName(t, e.agent)}</b> {e.text}
              </li>
            ) : null
          }
          const actor = e.kind === 'delegate' || e.kind === 'handoff' ? e.from : e.kind === 'student' ? 'student' : (e as { agent?: string }).agent ?? ''
          return (
            <li key={i} className={`pl-story-item k-${e.kind} ${i === replay.step ? 'on' : ''} ${i > replay.step ? 'future' : ''}`} onClick={() => replay.jump(i)}>
              <span className="pl-story-icon" style={{ background: ROLE[actor]?.color }}>
                {ICON[e.kind]}
              </span>
              <div className="pl-story-body">
                <p className="pl-story-title">
                  <span className="pl-step-no">{i + 1}</span> {headline(e, t)}
                </p>
                {i <= replay.step && <Detail e={e} evidence={evidence} t={t} />}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
