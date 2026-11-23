import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { channel, endpoints, type AnalysisResult, type Endpoint, type EvidenceView, type LabState, type RunSummary } from './contract.js'
import type { RunRecord, Scenario, TraceEvent } from './core/types.js'
import { FlowView } from './flow.js'
import style from './style.css'

export const name = 'pathfinder-lab-client'
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'connection', 'locale']

const id = 'dsh-plugin-pathfinder-lab/panel'
const kind = 'pathfinder-lab'

type T = (en: string, zh: string) => string
type Locale = { get: () => string; subscribe: (listener: () => void) => () => void }
type Request = <R = unknown>(endpoint: Endpoint, payload?: unknown) => Promise<R>

const ROLE_ZH: Record<string, string> = {
  advisor: '单 Agent 顾问',
  personal: '个人顾问',
  university: '校级政策',
  'college-ls': '文理学院',
  'college-coe': '工程学院',
  'dept-ecs': '计算机系',
  'dept-psc': '心理学系',
  'dept-lin': '语言学系',
  'dept-mat': '数学系',
}
const CAT_ZH: Record<string, string> = {
  'unclear-interests': '兴趣不明确',
  'uncertain-preparation': '准备情况不确定',
  'workload-tradeoff': '学业负担取舍',
  'overlapping-requirements': '要求交叉重叠',
  'procedural-risk': '程序/期限风险',
}

const STATUS_ZH: Record<string, string> = { running: '进行中', done: '完成', failed: '失败', cancelled: '已取消', stopped: '已停止' }
const TYPE_ZH: Record<string, string> = { elicit: '追问事实', cite: '核对来源', next_step: '下一步', referral: '转介顾问', caution: '风险提示', avoid: '避免错误' }
const METHOD_ZH: Record<string, string> = { auto: '自动', judge: '评审模型', rule: '规则' }
const VERDICT_ZH: Record<string, string> = { supported: '有依据', partial: '部分有依据', unsupported: '无依据', contradicted: '与证据矛盾', uncited: '未引用' }
const SPLIT_ZH: Record<string, string> = { dev: '开发', heldout: '留出' }
const LANG_KEY = 'pathfinder-lab-language'
type LangPref = 'follow' | 'en' | 'zh'
function readLang(): LangPref {
  try {
    const v = window.localStorage.getItem(LANG_KEY)
    return v === 'en' || v === 'zh' ? v : 'follow'
  } catch {
    return 'follow'
  }
}
function saveLang(v: LangPref) {
  try {
    window.localStorage.setItem(LANG_KEY, v)
  } catch {
    /* storage unavailable: the choice still applies to this view */
  }
}
/** Label from a zh map when the UI is in Chinese. */
const lbl = (t: T, map: Record<string, string>, key: string) => t(key, map[key] ?? key)
const ERROR_ZH: [RegExp, string][] = [
  [/Choose a DeepSeek model/i, '请先在 Harness 设置里选择 DeepSeek 模型。'],
  [/Type a question first/i, '请先输入问题。'],
  [/already running/i, '已有实验在运行，请等待或先停止。'],
  [/Pick at least one scenario/i, '请至少选择一个案例。'],
  [/not waiting for an answer/i, '这次运行当前没有在等待回答。'],
  [/Every planned run already finished/i, '所有计划中的运行都已完成。'],
  [/Experiment not found/i, '找不到该实验。'],
  [/Wait for the running experiment/i, '请等待正在运行的实验结束。'],
  [/authorization failed/i, 'DeepSeek 授权失败，请在 Harness 设置里登录或更新服务商。'],
  [/Paused after repeated network failures/i, '连续网络失败，实验已暂停；可在「结果」页续跑。'],
]
const errText = (t: T, message: string) => t(message, ERROR_ZH.find(([re]) => re.test(message))?.[1] ?? message)
const titleOf = (t: T, s: { title: string; titleZh?: string }) => t(s.title, s.titleZh ?? s.title)

function saveJson(value: unknown, file: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = file
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
const fmt = (x: number | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d))
const secs = (ms: number) => `${Math.round(ms / 1000)}s`

// ------------------------------------------------------------------ pieces

function Evidence({ ids, evidence, t }: { ids: string[]; evidence: Record<string, EvidenceView>; t: T }) {
  const [open, setOpen] = useState<string>()
  if (!ids.length) return null
  const ev = open ? evidence[open] : undefined
  return (
    <span className="pfl-ev">
      {ids.map((x) => (
        <button
          key={x}
          type="button"
          className={`pfl-chip ${evidence[x] ? '' : 'bad'} ${open === x ? 'on' : ''}`}
          title={evidence[x] ? evidence[x].title : t('Not retrieved in this run', '本次运行未检索到该证据')}
          onClick={() => setOpen(open === x ? undefined : x)}
        >
          {x}
        </button>
      ))}
      {ev && (
        <span className="pfl-evcard">
          <strong>{ev.title}</strong>
          <small>
            {ev.heading} · {ev.scope} · {t('retrieved', '抓取')} {ev.retrievedAt}
            {ev.legacy && ` · ${t('LEGACY record', '旧版记录')}`}
          </small>
          <span className="pfl-evtext">{ev.text}</span>
          {ev.url && (
            <a href={ev.url} target="_blank" rel="noreferrer">
              {t('Open source', '打开原文')}
            </a>
          )}
        </span>
      )}
    </span>
  )
}

function Report({ run, evidence, t }: { run: RunRecord; evidence: Record<string, EvidenceView>; t: T }) {
  const r = run.report
  if (!r) return null
  return (
    <div className="pfl-report">
      <p className="pfl-reply">{r.reply}</p>
      {r.options.length > 0 && (
        <section>
          <h4>{t('Options', '可选路径')}</h4>
          {r.options.map((o, i) => (
            <div key={i} className="pfl-opt">
              <strong>{o.title}</strong>
              {o.why && <p>{o.why}</p>}
              {o.steps.length > 0 && (
                <ol>
                  {o.steps.map((s, j) => (
                    <li key={j}>{s}</li>
                  ))}
                </ol>
              )}
              <Evidence ids={o.evidence} evidence={evidence} t={t} />
            </div>
          ))}
        </section>
      )}
      {r.claims.length > 0 && (
        <section>
          <h4>{t('Checked claims', '核对过的规则')}</h4>
          <ul>
            {r.claims.map((c, i) => {
              const verdict = run.score?.claims[i]?.verdict
              return (
                <li key={i}>
                  {c.critical && <span className="pfl-tag">{t('critical', '关键')}</span>}
                  {verdict && <span className={`pfl-tag v-${verdict}`}>{lbl(t, VERDICT_ZH, verdict)}</span>} {c.text} <Evidence ids={c.evidence} evidence={evidence} t={t} />
                </li>
              )
            })}
          </ul>
        </section>
      )}
      {r.uncertain.length > 0 && (
        <section>
          <h4>{t('Still uncertain', '仍待确认')}</h4>
          <ul>
            {r.uncertain.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </section>
      )}
      {r.advisor_questions.length > 0 && (
        <section>
          <h4>{t('Questions for your advisor', '带给顾问的问题')}</h4>
          <ul>
            {r.advisor_questions.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </section>
      )}
      {r.referral.needed && (
        <p className="pfl-ref">
          ➜ {r.referral.office}
          {r.referral.reason && ` — ${r.referral.reason}`}
        </p>
      )}
    </div>
  )
}

function eventLine(e: TraceEvent, t: T): { who: string; text: string; cls: string } {
  const who = (a: string) => t(a, ROLE_ZH[a] ?? a)
  switch (e.kind) {
    case 'student':
      return { who: t('Student', '学生'), text: e.text, cls: 'stu' }
    case 'ask':
      return { who: who(e.agent), text: `❓ ${e.question}\n↳ ${e.reply}`, cls: 'ask' }
    case 'search':
      return { who: who(e.agent), text: `🔎 "${e.query}" [${e.scope}] → ${e.results.join(', ') || '∅'}${e.repeated ? ` (${t('repeat', '重复')})` : ''}`, cls: 'tool' }
    case 'course':
      return { who: who(e.agent), text: `📘 ${e.code} ${e.found ? '' : t('(not found)', '（未找到）')}`, cls: 'tool' }
    case 'delegate':
      return { who: who(e.from), text: `→ ${who(e.to)}: ${e.question}`, cls: 'hand' }
    case 'report':
      return { who: who(e.agent), text: e.findings.map((f) => `• ${f.claim} [${f.evidence.join(', ')}]`).join('\n') || t('no findings', '没有结论'), cls: 'rep' }
    case 'handoff':
      return { who: who(e.from), text: `⇢ ${who(e.to)} ${e.accepted ? '' : `✕ ${e.reason}`}: ${e.question}`, cls: 'hand' }
    case 'thought':
      return { who: who(e.agent), text: e.text, cls: 'thought' }
    case 'limit':
      return { who: t('Budget', '预算'), text: e.detail, cls: 'limit' }
    case 'error':
      return { who: t('Error', '错误'), text: e.detail, cls: 'limit' }
  }
}

function Trace({ run, t, thoughts }: { run: RunRecord; t: T; thoughts: boolean }) {
  return (
    <ol className="pfl-trace">
      {run.trace
        .filter((e) => thoughts || e.kind !== 'thought')
        .map((e, i) => {
          const l = eventLine(e, t)
          return (
            <li key={i} className={l.cls}>
              <b>{l.who}</b>
              <span>{l.text}</span>
            </li>
          )
        })}
    </ol>
  )
}

function Usage({ run, t }: { run: RunRecord; t: T }) {
  const u = run.usage
  const b = run.budget
  const bar = (v: number, max: number, label: string) => (
    <span className="pfl-meter" title={`${label} ${v}/${max}`}>
      <span style={{ width: `${Math.min(100, (100 * v) / Math.max(1, max))}%` }} />
      <em>
        {label} {v}/{max}
      </em>
    </span>
  )
  return (
    <div className="pfl-usage">
      {bar(u.tokens, b.tokens, 'tokens')}
      {bar(u.modelCalls, b.modelCalls, t('calls', '调用'))}
      {bar(u.toolCalls, b.toolCalls, t('tools', '工具'))}
      {bar(u.clarifications, b.clarifications, t('asks', '追问'))}
      {run.condition === 'B' && bar(u.specialistCalls, b.specialistCalls, t('specialists', '专家'))}
    </div>
  )
}

function RunCard({
  run,
  state,
  request,
  refresh,
  t,
  scenario,
}: {
  run: RunRecord
  state: LabState
  request: Request
  refresh: () => void
  t: T
  scenario?: Scenario
}) {
  const [answer, setAnswer] = useState('')
  const [facts, setFacts] = useState<string[]>([])
  const [thoughts, setThoughts] = useState(false)
  const [tab, setTab] = useState<'flow' | 'answer' | 'trace' | 'score'>('flow')
  const pending = state.pending.find((p) => p.runId === run.id)
  const send = async () => {
    if (!answer.trim()) return
    await request(endpoints.answer as Endpoint, { runId: run.id, text: answer, facts })
    setAnswer('')
    setFacts([])
    refresh()
  }
  return (
    <article className={`pfl-run c-${run.condition}`}>
      <header>
        <span className="pfl-badge">{run.condition === 'A' ? t('A · Single agent', 'A · 单 Agent') : t('B · Multi-agent', 'B · 多 Agent')}</span>
        <span className={`pfl-status s-${run.status}`}>{lbl(t, STATUS_ZH, run.status)}</span>
        <span className="pfl-dim">
          {secs(run.usage.wallMs || Date.now() - run.startedAt)} · {run.stop ?? ''}
        </span>
        {run.status === 'running' && (
          <button type="button" className="pfl-link" onClick={() => request('stop', { runId: run.id }).then(refresh)}>
            {t('Stop', '停止')}
          </button>
        )}
      </header>
      <Usage run={run} t={t} />
      {pending && (
        <div className="pfl-pending">
          <strong>{pending.question}</strong>
          {scenario && (
            <div className="pfl-facts">
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
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} placeholder={t('Your answer…', '你的回答……')} />
          <button type="button" className="pfl-primary" onClick={send} disabled={!answer.trim()}>
            {t('Reply', '回复')}
          </button>
        </div>
      )}
      <nav className="pfl-subtabs">
        <button type="button" className={tab === 'flow' ? 'on' : ''} onClick={() => setTab('flow')}>
          {t('Process', '流程图')}
        </button>
        <button type="button" className={tab === 'answer' ? 'on' : ''} onClick={() => setTab('answer')}>
          {t('Summary', '总结')}
        </button>
        <button type="button" className={tab === 'trace' ? 'on' : ''} onClick={() => setTab('trace')}>
          {t('Trace', '执行轨迹')} ({run.trace.length})
        </button>
        {run.score && (
          <button type="button" className={tab === 'score' ? 'on' : ''} onClick={() => setTab('score')}>
            {t('Score', '评分')} {fmt(run.score.checklistPct, 0)}%
          </button>
        )}
      </nav>
      {tab === 'flow' && <FlowView run={run} evidence={state.evidence} t={t} />}
      {tab === 'answer' &&
        (run.report ? (
          <Report run={run} evidence={state.evidence} t={t} />
        ) : (
          <p className="pfl-dim">{run.status === 'running' ? t('Working…', '处理中……') : run.error ?? t('No summary', '没有总结')}</p>
        ))}
      {tab === 'trace' && (
        <>
          <label className="pfl-dim">
            <input type="checkbox" checked={thoughts} onChange={(e) => setThoughts(e.target.checked)} /> {t('show reasoning notes', '显示思路')}
          </label>
          <Trace run={run} t={t} thoughts={thoughts} />
        </>
      )}
      {tab === 'score' && run.score && (
        <div className="pfl-score">
          <p>
            {t('Checklist', '清单')} {fmt(run.score.checklistPct)}% · {t('unsupported critical claims', '无依据关键论断')} {run.score.unsupportedCritical} ·{' '}
            {t('valid / invalid citations', '有效/无效引用')} {run.score.validCitations}/{run.score.invalidCitations} · {t('critical facts elicited', '关键事实获取')}{' '}
            {run.score.criticalFactsElicited}/{run.score.criticalFactsTotal}
          </p>
          <table>
            <tbody>
              {run.score.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.id}</td>
                  <td>{lbl(t, TYPE_ZH, i.type)}</td>
                  <td>×{i.weight}</td>
                  <td className={i.score >= 1 ? 'ok' : i.score > 0 ? 'mid' : 'no'}>{i.score}</td>
                  <td>{lbl(t, METHOD_ZH, i.method)}</td>
                  <td>{scenario?.checklist.find((c) => c.id === i.id)?.text} — <em>{i.why}</em></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  )
}

// ------------------------------------------------------------------ views

function Consult({ state, request, refresh, t, watch }: { state: LabState; request: Request; refresh: () => void; t: T; watch: (ids: string[]) => void }) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'A' | 'B' | 'AB'>('AB')
  const [error, setError] = useState<string>()
  const runs = state.details.filter((r) => r.experimentId === 'consult')
  const start = async () => {
    setError(undefined)
    try {
      const res = await request<{ runIds: string[] }>('consult', { opening: text, conditions: mode === 'AB' ? ['A', 'B'] : [mode] })
      watch(res.runIds)
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="pfl-view">
      <div className="pfl-compose">
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t(
            'e.g. I like photography and app design and want to try computer science. Where do I start?',
            '例如：我喜欢摄影和 App 界面设计，想试试计算机，该从哪里开始？',
          )}
        />
        <div className="pfl-row">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'A' | 'B' | 'AB')}>
            <option value="AB">{t('A and B side by side', 'A 与 B 并排对比')}</option>
            <option value="A">{t('A · Single agent only', '仅 A · 单 Agent')}</option>
            <option value="B">{t('B · Multi-agent only', '仅 B · 多 Agent')}</option>
          </select>
          <button type="button" className="pfl-primary" onClick={start} disabled={!text.trim() || !state.model}>
            {t('Start consultation', '开始咨询')}
          </button>
        </div>
        {error && <p className="pfl-error">{errText(t, error)}</p>}
        <p className="pfl-dim">
          {t(
            'Preparation support only — not an official eligibility decision. Answers cite UC Davis pages retrieved',
            '仅用于准备顾问面谈，不是官方资格认定。回答引用的 UC Davis 页面抓取于',
          )}{' '}
          {state.corpus.builtAt}.
        </p>
      </div>
      <div className={`pfl-cols n${runs.length}`}>
        {runs.map((r) => (
          <RunCard key={r.id} run={r} state={state} request={request} refresh={refresh} t={t} />
        ))}
      </div>
    </div>
  )
}

function Experiment({ state, request, refresh, t, watch, selected }: { state: LabState; request: Request; refresh: () => void; t: T; watch: (ids: string[]) => void; selected?: string }) {
  const [picked, setPicked] = useState<string[]>(() => state.scenarios.filter((s) => s.split === 'dev').map((s) => s.id))
  const [repeats, setRepeats] = useState(2)
  const [seed, setSeed] = useState(2026)
  const [mode, setMode] = useState<'simulated' | 'manual'>('simulated')
  const [autoGrade, setAutoGrade] = useState(true)
  const [name, setName] = useState('dev')
  const [budget, setBudget] = useState({ ...state.defaults })
  const [error, setError] = useState<string>()
  const [open, setOpen] = useState<string>()
  const pick = (split: string) => setPicked(state.scenarios.filter((s) => split === 'all' || s.split === split).map((s) => s.id))
  const start = async () => {
    setError(undefined)
    try {
      await request('experiment', {
        name,
        scenarioIds: picked,
        repeats,
        seed,
        studentMode: mode,
        autoGrade,
        budget: { tokens: budget.tokens, modelCalls: budget.modelCalls, toolCalls: budget.toolCalls, clarifications: budget.clarifications, specialistCalls: budget.specialistCalls },
      })
      refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const runningIds = state.runs.filter((r) => r.status === 'running').map((r) => r.id)
  useEffect(() => {
    watch([...runningIds, ...(open ? [open] : [])])
  }, [runningIds.join(','), open])
  const detail = state.details.find((r) => r.id === open) ?? state.details.find((r) => runningIds.includes(r.id))
  const num = (key: keyof typeof budget, label: string) => (
    <label>
      {label}
      <input type="number" value={budget[key]} onChange={(e) => setBudget({ ...budget, [key]: Number(e.target.value) })} />
    </label>
  )
  return (
    <div className="pfl-view">
      <section className="pfl-box">
        <div className="pfl-row">
          <strong>{t('Scenarios', '案例')}</strong>
          <button type="button" className="pfl-link" onClick={() => pick('dev')}>
            dev (4)
          </button>
          <button type="button" className="pfl-link" onClick={() => pick('heldout')}>
            {t('held-out', '留出')} (20)
          </button>
          <button type="button" className="pfl-link" onClick={() => pick('all')}>
            {t('all', '全部')}
          </button>
          <span className="pfl-dim">
            {picked.length} × {repeats} × 2 = {picked.length * repeats * 2} {t('runs', '次运行')}
          </span>
        </div>
        <div className="pfl-grid">
          {state.scenarios.map((s) => (
            <label key={s.id} className="pfl-sc" title={s.opening}>
              <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />
              <b>{s.id}</b> {titleOf(t, s)}
            </label>
          ))}
        </div>
        <div className="pfl-form">
          <label>
            {t('Name', '名称')}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            {t('Repeats', '重复')}
            <input type="number" min={1} max={5} value={repeats} onChange={(e) => setRepeats(Number(e.target.value))} />
          </label>
          <label>
            {t('Seed', '随机种子')}
            <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
          </label>
          <label>
            {t('Student', '学生')}
            <select value={mode} onChange={(e) => setMode(e.target.value as 'simulated' | 'manual')}>
              <option value="simulated">{t('Scripted simulator', '脚本模拟')}</option>
              <option value="manual">{t('Researcher answers', '研究员手动答复')}</option>
            </select>
          </label>
          <label>
            <input type="checkbox" checked={autoGrade} onChange={(e) => setAutoGrade(e.target.checked)} /> {t('Grade automatically', '自动评分')}
          </label>
        </div>
        <div className="pfl-form">
          {num('tokens', 'tokens')}
          {num('modelCalls', t('model calls', '模型调用'))}
          {num('toolCalls', t('tool calls', '工具调用'))}
          {num('clarifications', t('clarifications', '追问'))}
          {num('specialistCalls', t('specialist calls (B)', '专家调用 (B)'))}
        </div>
        <div className="pfl-row">
          <button type="button" className="pfl-primary" disabled={Boolean(state.job) || !picked.length || !state.model} onClick={start}>
            {t('Run experiment', '运行实验')}
          </button>
          {state.job && (
            <>
              <span>
                {state.job.progress}/{state.job.planned}
              </span>
              <button type="button" className="pfl-link" onClick={() => request('stop', {}).then(refresh)}>
                {t('Stop', '停止')}
              </button>
            </>
          )}
          {error && <span className="pfl-error">{errText(t, error)}</span>}
        </div>
      </section>
      <RunTable runs={state.runs} t={t} onOpen={setOpen} open={open} title={selected} />
      {detail && <RunCard run={detail} state={state} request={request} refresh={refresh} t={t} scenario={state.scenarios.find((s) => s.id === detail.scenarioId)} />}
    </div>
  )
}

function RunTable({ runs, t, onOpen, open, title }: { runs: RunSummary[]; t: T; onOpen: (id: string) => void; open?: string; title?: string }) {
  if (!runs.length) return <p className="pfl-dim">{t('No runs yet.', '还没有运行记录。')}</p>
  return (
    <section className="pfl-box">
      <strong>{title}</strong>
      <table className="pfl-table">
        <thead>
          <tr>
            <th>#</th>
            <th>{t('Case', '案例')}</th>
            <th>{t('Cond.', '组')}</th>
            <th>{t('Status', '状态')}</th>
            <th>tokens</th>
            <th>{t('calls', '调用')}</th>
            <th>{t('asks', '追问')}</th>
            <th>{t('time', '耗时')}</th>
            <th>{t('checklist', '清单')}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className={open === r.id ? 'on' : ''} onClick={() => onOpen(r.id)}>
              <td>{r.order}</td>
              <td>{r.scenarioId}</td>
              <td>
                {r.condition}
                {r.repeat}
              </td>
              <td className={`s-${r.status}`}>{lbl(t, STATUS_ZH, r.status)}</td>
              <td>{r.tokens}</td>
              <td>{r.modelCalls}</td>
              <td>{r.clarifications}</td>
              <td>{secs(r.wallMs)}</td>
              <td>{fmt(r.checklistPct, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Bars({ rows, t }: { rows: { label: string; A: number; B: number }[]; t: T }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.A, r.B]).filter(Number.isFinite))
  return (
    <div className="pfl-bars">
      <div className="pfl-legend">
        <span className="c-A">A {t('single', '单 Agent')}</span>
        <span className="c-B">B {t('multi', '多 Agent')}</span>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="pfl-barrow">
          <span>{r.label}</span>
          <div>
            <i className="c-A" style={{ width: `${(100 * (r.A || 0)) / max}%` }}>
              {fmt(r.A, 0)}
            </i>
            <i className="c-B" style={{ width: `${(100 * (r.B || 0)) / max}%` }}>
              {fmt(r.B, 0)}
            </i>
          </div>
        </div>
      ))}
    </div>
  )
}

function Results({ state, request, t, experimentId, setExperimentId }: { state: LabState; request: Request; t: T; experimentId?: string; setExperimentId: (id: string) => void }) {
  const [result, setResult] = useState<AnalysisResult>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<string>()
  const exp = experimentId ?? state.experiments[0]?.id
  const load = useCallback(async () => {
    if (!exp) return
    try {
      setResult(await request<AnalysisResult>('analysis', { experimentId: exp }))
    } catch (e) {
      setError((e as Error).message)
    }
  }, [exp, request])
  useEffect(() => {
    void load()
  }, [load, state.runs.length])
  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(undefined)
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy('')
    }
  }
  const file = useRef<HTMLInputElement>(null)
  const a = result?.analysis
  const p = (x: number) => (!Number.isFinite(x) ? '—' : x < 0.001 ? '<0.001' : x.toFixed(3))
  return (
    <div className="pfl-view">
      <div className="pfl-row">
        <select value={exp} onChange={(e) => setExperimentId(e.target.value)}>
          {state.experiments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} · {e.id} · {lbl(t, STATUS_ZH, e.status)}
              {e.error ? ` · ${errText(t, e.error).slice(0, 60)}` : ''}
            </option>
          ))}
        </select>
        <button type="button" className="pfl-link" disabled={!exp || Boolean(busy)} onClick={() => act('grade', async () => { await request('grade', { experimentId: exp }); await load() })}>
          {busy === 'grade' ? t('Grading…', '评分中……') : t('Grade unscored', '为未评分运行评分')}
        </button>
        <button
          type="button"
          className="pfl-link"
          disabled={!exp || Boolean(busy) || Boolean(state.job)}
          onClick={() => act('resume', async () => { await request('resume', { experimentId: exp }) })}
        >
          {t('Resume failed/missing runs', '续跑失败或缺失的运行')}
        </button>
        <button type="button" className="pfl-link" disabled={!exp} onClick={() => act('blind', async () => saveJson(await request('exportBlind', { experimentId: exp }), `${exp}-blind-review.json`))}>
          {t('Export blind review', '导出盲评包')}
        </button>
        <button type="button" className="pfl-link" disabled={!exp} onClick={() => act('runs', async () => saveJson(await request('exportRuns', { experimentId: exp }), `${exp}-runs.json`))}>
          {t('Export full runs', '导出完整轨迹')}
        </button>
        <button type="button" className="pfl-link" disabled={!exp} onClick={() => file.current?.click()}>
          {t('Import human scores', '导入人工评分')}
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f)
              void act('import', async () => {
                await request('importHuman', { experimentId: exp, scores: JSON.parse(await f.text()) })
                await load()
              })
            e.target.value = ''
          }}
        />
      </div>
      {error && <p className="pfl-error">{errText(t, error)}</p>}
      {!a || !a.paired[0]?.n ? (
        <p className="pfl-dim">{t('Need at least one scenario with scored A and B runs.', '至少需要一个案例同时有已评分的 A、B 运行。')}</p>
      ) : (
        <>
          <p className="pfl-dim">
            {t('Paired over', '配对案例数')} {a.paired[0].n} · {t('runs', '运行')} {a.runs.done}/{a.runs.total} · {t('scored', '已评分')} {a.runs.scored} ·{' '}
            {t('B handoffs', 'B 组交接')} {a.handoffs.total}
          </p>
          <table className="pfl-table">
            <thead>
              <tr>
                <th>{t('Metric', '指标')}</th>
                <th>A</th>
                <th>B</th>
                <th>B − A</th>
                <th>95% CI</th>
                <th>p</th>
                <th>dz</th>
                <th>{t('B better/tie/worse', 'B 更好/持平/更差')}</th>
              </tr>
            </thead>
            <tbody>
              {a.paired.map((r) => (
                <tr key={r.key} className={r.key === 'checklistPct' ? 'primary' : ''}>
                  <td>{t(r.label, r.labelZh)}</td>
                  <td>{fmt(r.meanA)}</td>
                  <td>{fmt(r.meanB)}</td>
                  <td>{fmt(r.diff)}</td>
                  <td>
                    [{fmt(r.ci[0])}, {fmt(r.ci[1])}]
                  </td>
                  <td>{p(r.p)}</td>
                  <td>{fmt(r.dz, 2)}</td>
                  <td>{r.better === 'neutral' ? '—' : `${r.wins}/${r.ties}/${r.losses}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>{t('Checklist by category', '各类别清单得分')}</h4>
          <Bars rows={a.byCategory.map((c) => ({ label: t(c.category, CAT_ZH[c.category] ?? c.category), A: c.A, B: c.B }))} t={t} />
          <h4>{t('Checklist by scenario', '各案例清单得分')}</h4>
          <Bars rows={a.perScenario.map((s) => ({ label: s.scenarioId, A: s.A?.checklistPct ?? NaN, B: s.B?.checklistPct ?? NaN }))} t={t} />
          <h4>{t('Tokens by scenario', '各案例 token 用量')}</h4>
          <Bars rows={a.perScenario.map((s) => ({ label: s.scenarioId, A: s.A?.tokens ?? NaN, B: s.B?.tokens ?? NaN }))} t={t} />
          {result.agreement.length > 0 && (
            <>
              <h4>{t('Scorer agreement', '评分一致性')}</h4>
              <table className="pfl-table">
                <tbody>
                  {result.agreement.map((g) => (
                    <tr key={`${g.a}-${g.b}`}>
                      <td>
                        {g.a} vs {g.b}
                      </td>
                      <td>n={g.n}</td>
                      <td>{fmt(100 * g.agreement)}%</td>
                      <td>κ {fmt(g.kappa, 2)}</td>
                      <td>κw {fmt(g.weighted, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  )
}

function Cases({ state, t }: { state: LabState; t: T }) {
  const [open, setOpen] = useState(state.scenarios[0]?.id)
  const s = state.scenarios.find((x) => x.id === open)
  return (
    <div className="pfl-view">
      <p className="pfl-dim">
        {t('Corpus', '语料')} {state.corpus.version} · {state.corpus.documents} {t('documents', '份文档')} · {state.corpus.chunks} {t('chunks', '段')} · {state.corpus.courses}{' '}
        {t('courses', '门课程')} · {Object.entries(state.corpus.byUnit).map(([u, n]) => `${u} ${n}`).join(' · ')}
      </p>
      <div className="pfl-row">
        <select value={open} onChange={(e) => setOpen(e.target.value)}>
          {state.scenarios.map((x) => (
            <option key={x.id} value={x.id}>
              {x.id} · {titleOf(t, x)}
            </option>
          ))}
        </select>
      </div>
      {s && (
        <section className="pfl-box">
          <p>
            <span className="pfl-tag">{lbl(t, SPLIT_ZH, s.split)}</span> <span className="pfl-tag">{t(s.category, CAT_ZH[s.category] ?? s.category)}</span> <span className="pfl-tag">{s.year}</span>{' '}
            {s.majors.join(' / ')}
          </p>
          <blockquote>{s.opening}</blockquote>
          <h4>{t('Hidden profile', '隐藏档案')}</h4>
          <ul>
            {s.facts.map((f) => (
              <li key={f.id}>
                <b>{f.id}</b>
                {f.critical && <span className="pfl-tag">{t('critical', '关键')}</span>} {f.topic}: <em>{f.answer}</em>
              </li>
            ))}
          </ul>
          <h4>{t('Checklist', '评分清单')}</h4>
          <ul>
            {s.checklist.map((c) => (
              <li key={c.id}>
                <b>{c.id}</b> <span className="pfl-tag">{lbl(t, TYPE_ZH, c.type)}</span> ×{c.weight} {c.text}
                {c.docs && <small> ({c.docs.join(', ')})</small>}
              </li>
            ))}
          </ul>
          <h4>{t('Reference notes', '参考要点')}</h4>
          <p>{s.reference}</p>
        </section>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ panel

export function Panel({ request, locale }: { request: Request; locale: Locale }) {
  const active = useSyncExternalStore(locale.subscribe, locale.get)
  const [lang, setLang] = useState<LangPref>(readLang)
  const zh = lang === 'follow' ? active.toLowerCase().startsWith('zh') : lang === 'zh'
  const t: T = useCallback((en, z) => (zh ? z : en), [zh])
  const [view, setView] = useState<'consult' | 'experiment' | 'results' | 'cases'>('consult')
  const [state, setState] = useState<LabState>()
  const [error, setError] = useState<string>()
  const [watching, setWatching] = useState<string[]>([])
  const [experimentId, setExperimentId] = useState<string>()
  const watchRef = useRef<string[]>([])
  const consultIds = useRef<string[]>([])
  const watch = useCallback((ids: string[]) => {
    setWatching(ids)
  }, [])
  watchRef.current = [...new Set([...consultIds.current, ...watching])].slice(-4)
  const refresh = useCallback(async () => {
    try {
      setState(await request<LabState>('state', { experimentId, runIds: watchRef.current }))
      setError(undefined)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [request, experimentId])
  const watchConsult = useCallback(
    (ids: string[]) => {
      consultIds.current = ids
      void refresh()
    },
    [refresh],
  )
  useEffect(() => {
    void refresh()
  }, [refresh, watching.join(',')])
  const live = Boolean(state?.job) || Boolean(state?.details.some((r) => r.status === 'running'))
  useEffect(() => {
    const timer = setInterval(() => void refresh(), live ? 1500 : 6000)
    return () => clearInterval(timer)
  }, [refresh, live])
  const pendingCount = state?.pending.length ?? 0

  return (
    <div className="pfl">
      <header className="pfl-head">
        <div>
          <div className="pfl-eyebrow">PATHFINDER UCD · ADVISING LAB</div>
          <h2>{t('Single agent vs institution-scoped team', '单 Agent 对比按学校职责分工的多 Agent')}</h2>
          <p className="pfl-dim">
            {state?.model ? `${state.model.id} · ${state.model.provider}` : t('No model selected in Harness settings', '尚未在 Harness 设置里选择模型')} · ECS · PSC · LIN · MAT
          </p>
        </div>
        <select
          className="pfl-lang"
          value={lang}
          aria-label={t('Interface language', '界面语言')}
          onChange={(e) => {
            const v = e.target.value as LangPref
            setLang(v)
            saveLang(v)
          }}
        >
          <option value="follow">{t('Follow Harness', '跟随 Harness')}</option>
          <option value="en">English</option>
          <option value="zh">中文</option>
        </select>
      </header>
      <nav className="pfl-tabs">
        {(
          [
            ['consult', t('Consult', '咨询')],
            ['experiment', t('Experiment', '实验')],
            ['results', t('Results', '结果')],
            ['cases', t('Cases & data', '案例与数据')],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className={view === k ? 'on' : ''} onClick={() => setView(k)}>
            {label}
            {k === 'experiment' && pendingCount > 0 && <span className="pfl-dot">{pendingCount}</span>}
          </button>
        ))}
      </nav>
      {error && <p className="pfl-error">{errText(t, error)}</p>}
      {!state ? (
        <p className="pfl-dim pfl-view">{t('Loading…', '加载中……')}</p>
      ) : view === 'consult' ? (
        <Consult state={state} request={request} refresh={refresh} t={t} watch={watchConsult} />
      ) : view === 'experiment' ? (
        <Experiment state={state} request={request} refresh={refresh} t={t} watch={watch} selected={experimentId ?? state.experiments[0]?.id} />
      ) : view === 'results' ? (
        <Results state={state} request={request} t={t} experimentId={experimentId} setExperimentId={setExperimentId} />
      ) : (
        <Cases state={state} t={t} />
      )}
    </div>
  )
}

function Glyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
      <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" />
      <path d="M7.5 15h9" />
    </svg>
  )
}

export function Entry({ open, locale }: { open: () => void; locale: Locale }) {
  const active = useSyncExternalStore(locale.subscribe, locale.get)
  const pref = readLang()
  const zh = pref === 'follow' ? active.toLowerCase().startsWith('zh') : pref === 'zh'
  const title = zh ? '打开 Pathfinder 咨询实验室' : 'Open Pathfinder Advising Lab'
  return (
    <button className="pfl-icon" type="button" title={title} aria-label={title} onClick={open}>
      <Glyph />
      <span>{zh ? '咨询实验室' : 'Advising Lab'}</span>
    </button>
  )
}

export function apply(ctx: Context) {
  const locale: Locale = {
    get: () => ctx.locale.getLocale().active,
    subscribe: (listener) => ctx.on('locale/change', listener),
  }
  const rpc = (ctx.connection as unknown as { rpc: ClientConnectionRpc }).rpc
  const request: Request = async (endpoint, payload = {}) => {
    const path = endpoints[endpoint as Endpoint] ?? endpoint
    const result = await rpc.call(channel, path, payload)
    if (!result.ok) throw new Error(result.error.message)
    return result.value as never
  }
  const isZh = () => (readLang() === 'follow' ? locale.get().toLowerCase().startsWith('zh') : readLang() === 'zh')
  const label = () => (isZh() ? '咨询实验室' : 'Advising Lab')
  const open = () => ctx.sidebarRight.openTab(kind)

  ctx.effect(() => {
    const node = document.createElement('style')
    node.dataset.plugin = 'dsh-plugin-pathfinder-lab'
    node.textContent = style
    document.head.append(node)
    return () => node.remove()
  })
  ctx.effect(() =>
    ctx.sidebarRightTabs.register({
      id,
      kind,
      title: label,
      guide: [
        {
          id: kind,
          order: 5,
          title: label,
          description: () =>
            isZh()
              ? 'UC Davis 学业咨询：单 Agent 与多 Agent 对比实验'
              : 'UC Davis advising: single vs multi-agent experiment',
        },
      ],
    }),
  )
  ctx.effect(() =>
    ctx.slots.inject('sidebar.right.pane.tab', () =>
      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id, inject: () => ({ request, locale }) }, Panel),
    ),
  )
  ctx.effect(() =>
    ctx.slots.inject('conversation.session.header.actions', () =>
      ctx.slots.register({ name: 'conversation.session.header.actions', id: kind, order: 33, inject: () => ({ open, locale }) }, Entry),
    ),
  )
}
