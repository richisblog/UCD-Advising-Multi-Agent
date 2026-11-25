import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { channel, endpoints, type AnalysisResult, type Endpoint, type LabState, type RunSummary } from './contract.js'
import type { PairedRow } from './core/analysis.js'
import { CAT_ZH, errText, fmt, kTok, lbl, readLang, saveJson, saveLang, secs, SPLIT_ZH, STATUS_ZH, titleOf, TYPE_ZH, type LangPref, type T } from './ui/i18n.js'
import { CompareStrip, RunCard, type Request } from './ui/Run.js'
import style from './style.css'

export const name = 'pathfinder-lab-client'
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'connection', 'locale']

const id = 'dsh-plugin-pathfinder-lab/panel'
const kind = 'pathfinder-lab'
type Locale = { get: () => string; subscribe: (listener: () => void) => () => void }

// ------------------------------------------------------------------ consult

function Consult({ state, request, refresh, t, watch }: { state: LabState; request: Request; refresh: () => void; t: T; watch: (ids: string[]) => void }) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'A' | 'B' | 'AB'>('AB')
  const [error, setError] = useState<string>()
  const runs = state.details.filter((r) => r.experimentId === 'consult').sort((a, b) => a.condition.localeCompare(b.condition))
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
  const examples = [
    t('I like photography and app design and want to try computer science. Where do I start?', '我喜欢摄影和 App 界面设计，想试试计算机，该从哪里开始？'),
    t('I got a 4 on AP Psychology. Do I still need PSC 1 to declare psychology?', '我 AP 心理学考了 4 分，申报心理学专业还需要上 PSC 1 吗？'),
    t('Can I double major in Mathematics and Applied Mathematics?', '我可以同时读数学和应用数学双专业吗？'),
  ]
  return (
    <div className="pl-view">
      <section className="pl-hero">
        <h3>{t('Ask an advising question', '提一个选课 / 专业问题')}</h3>
        <p className="pl-muted">
          {t(
            'Watch how one agent — or a team of university, college and department specialists — finds the rules, asks what it needs, and prepares you for an advisor.',
            '看单个 Agent，或由校级、学院、系里专家组成的团队，如何查规则、追问必要信息，并帮你准备好去见顾问。',
          )}
        </p>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={examples[0]} />
        <div className="pl-examples">
          {examples.map((x) => (
            <button key={x} type="button" className="pl-chip-btn" onClick={() => setText(x)}>
              {x}
            </button>
          ))}
        </div>
        <div className="pl-row">
          <div className="pl-seg" role="radiogroup" aria-label={t('Which system', '使用哪种架构')}>
            {(
              [
                ['AB', t('A and B side by side', 'A 与 B 并排')],
                ['A', t('A · Single agent', 'A · 单 Agent')],
                ['B', t('B · Multi-agent team', 'B · 多 Agent')],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'on' : ''} onClick={() => setMode(k)}>
                {label}
              </button>
            ))}
          </div>
          <button type="button" className="pl-btn primary" onClick={start} disabled={!text.trim() || !state.model}>
            {t('Start', '开始咨询')}
          </button>
        </div>
        {error && <p className="pl-warn">{errText(t, error)}</p>}
        <p className="pl-disclaimer">
          {t('Preparation support only — not an official eligibility decision. Official pages retrieved', '仅用于准备面谈，不是官方资格认定。官方页面抓取于')} {state.corpus.builtAt}.
        </p>
      </section>
      {runs.length === 2 && <CompareStrip runs={runs} t={t} />}
      <div className={`pl-cols n${runs.length}`}>
        {runs.map((r) => (
          <RunCard key={r.id} run={r} state={state} request={request} refresh={refresh} t={t} />
        ))}
      </div>
    </div>
  )
}

// --------------------------------------------------------------- experiment

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
        budget: {
          tokens: budget.tokens,
          modelCalls: budget.modelCalls,
          toolCalls: budget.toolCalls,
          clarifications: budget.clarifications,
          specialistCalls: budget.specialistCalls,
          checklist: budget.checklist,
        },
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
  const num = (key: 'tokens' | 'modelCalls' | 'toolCalls' | 'clarifications' | 'specialistCalls', label: string) => (
    <label>
      {label}
      <input type="number" value={budget[key]} onChange={(e) => setBudget({ ...budget, [key]: Number(e.target.value) })} />
    </label>
  )
  const byCat = new Map<string, typeof state.scenarios>()
  for (const s of state.scenarios) byCat.set(s.category, [...(byCat.get(s.category) ?? []), s])
  return (
    <div className="pl-view">
      <section className="pl-card">
        <header className="pl-row">
          <h4>{t('1 · Pick cases', '1 · 选择案例')}</h4>
          <button type="button" className="pl-chip-btn" onClick={() => pick('dev')}>
            {t('dev', '开发')} (4)
          </button>
          <button type="button" className="pl-chip-btn" onClick={() => pick('heldout')}>
            {t('held-out', '留出')} (20)
          </button>
          <button type="button" className="pl-chip-btn" onClick={() => pick('all')}>
            {t('all', '全部')}
          </button>
          <span className="pl-muted">
            {picked.length} × {repeats} × 2 = <b>{picked.length * repeats * 2}</b> {t('runs', '次运行')}
          </span>
        </header>
        <div className="pl-cases">
          {[...byCat].map(([cat, list]) => (
            <fieldset key={cat}>
              <legend>{t(cat, CAT_ZH[cat] ?? cat)}</legend>
              {list.map((s) => (
                <label key={s.id} title={s.opening}>
                  <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked((x) => (e.target.checked ? [...x, s.id] : x.filter((y) => y !== s.id)))} />
                  <b>{s.id}</b> {titleOf(t, s)}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
        <h4>{t('2 · Settings', '2 · 设置')}</h4>
        <div className="pl-form">
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
          {num('tokens', 'tokens')}
          {num('modelCalls', t('model calls', '模型调用'))}
          {num('toolCalls', t('tool calls', '工具调用'))}
          {num('clarifications', t('questions to student', '追问上限'))}
          {num('specialistCalls', t('specialist calls (B)', '专家调用 (B)'))}
        </div>
        <div className="pl-row">
          <label className="pl-switch">
            <input type="checkbox" checked={budget.checklist !== false} onChange={(e) => setBudget({ ...budget, checklist: e.target.checked })} />
            {t('Information checklist (both A and B)', '信息清单（A、B 同时开启）')}
          </label>
          <label className="pl-switch">
            <input type="checkbox" checked={autoGrade} onChange={(e) => setAutoGrade(e.target.checked)} /> {t('Grade automatically', '自动评分')}
          </label>
        </div>
        <div className="pl-row">
          <button type="button" className="pl-btn primary" disabled={Boolean(state.job) || !picked.length || !state.model} onClick={start}>
            {t('3 · Run experiment', '3 · 运行实验')}
          </button>
          {state.job && (
            <>
              <span className="pl-progress">
                <i style={{ width: `${(100 * state.job.progress) / Math.max(1, state.job.planned)}%` }} />
                <b>
                  {state.job.progress}/{state.job.planned}
                </b>
              </span>
              <button type="button" className="pl-btn ghost" onClick={() => request('stop', {}).then(refresh)}>
                {t('Stop', '停止')}
              </button>
            </>
          )}
          {error && <span className="pl-warn">{errText(t, error)}</span>}
        </div>
      </section>
      <RunTable runs={state.runs} t={t} onOpen={setOpen} open={open} title={selected} />
      {detail && <RunCard run={detail} state={state} request={request} refresh={refresh} t={t} scenario={state.scenarios.find((s) => s.id === detail.scenarioId)} />}
    </div>
  )
}

function RunTable({ runs, t, onOpen, open, title }: { runs: RunSummary[]; t: T; onOpen: (id: string) => void; open?: string; title?: string }) {
  if (!runs.length) return <p className="pl-muted">{t('No runs yet.', '还没有运行记录。')}</p>
  return (
    <section className="pl-card">
      <header className="pl-row">
        <h4>{t('Runs', '运行记录')}</h4>
        <span className="pl-muted">{title} · {t('click a row to replay it', '点击一行查看回放')}</span>
      </header>
      <div className="pl-table-wrap">
        <table className="pl-table">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('Case', '案例')}</th>
              <th>{t('System', '组')}</th>
              <th>{t('Status', '状态')}</th>
              <th>tokens</th>
              <th>{t('calls', '调用')}</th>
              <th>{t('asks', '追问')}</th>
              <th>{t('time', '耗时')}</th>
              <th>{t('score', '得分')}</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className={open === r.id ? 'on' : ''} onClick={() => onOpen(r.id)}>
                <td>{r.order}</td>
                <td>{r.scenarioId}</td>
                <td>
                  <span className={`pl-dot c-${r.condition}`} />
                  {r.condition}
                  {r.repeat}
                </td>
                <td className={`s-${r.status}`}>{lbl(t, STATUS_ZH, r.status)}</td>
                <td>{kTok(r.tokens)}</td>
                <td>{r.modelCalls}</td>
                <td>{r.clarifications}</td>
                <td>{secs(r.wallMs)}</td>
                <td>
                  {r.checklistPct != null && (
                    <span className="pl-scorebar">
                      <i style={{ width: `${r.checklistPct}%` }} />
                      {fmt(r.checklistPct, 0)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ results

const HELP: Record<string, [string, string]> = {
  checklistPct: ['Share of the pre-registered checklist the summary satisfied (primary outcome).', '总结满足事先写好的评分清单的比例（主指标）。'],
  unsupportedCritical: ['Key rule claims with no valid citation or not supported by the cited text.', '关键规则陈述没有有效引用，或引用原文不支持它。'],
  criticalElicitedPct: ['Decision-critical student facts the system actually asked about.', '会改变建议的学生关键事实，被问到的比例。'],
  needsResolvedPct: ['Share of the agent’s own information checklist resolved with proof.', 'Agent 自己列出的信息清单中，有凭据解决的比例。'],
  redundantActions: ['Searches, questions or delegations aimed at a need already answered.', '针对已解决信息的多余检索、追问或委派。'],
  repeatedRetrievals: ['Searches that returned nothing new.', '没有带来新内容的重复检索。'],
  tokens: ['Total model tokens, every call included.', '所有模型调用的 token 总数。'],
}

function Bars({ rows, t, unit = '' }: { rows: { label: string; A: number; B: number }[]; t: T; unit?: string }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.A, r.B]).filter(Number.isFinite))
  return (
    <div className="pl-bars">
      <div className="pl-legend-inline">
        <span className="c-A">A {t('single agent', '单 Agent')}</span>
        <span className="c-B">B {t('multi-agent', '多 Agent')}</span>
      </div>
      {rows.map((r) => (
        <div key={r.label} className="pl-barrow">
          <span title={r.label}>{r.label}</span>
          <div>
            <i className="c-A" style={{ width: `${(100 * (r.A || 0)) / max}%` }}>
              {fmt(r.A, 0)}
              {unit}
            </i>
            <i className="c-B" style={{ width: `${(100 * (r.B || 0)) / max}%` }}>
              {fmt(r.B, 0)}
              {unit}
            </i>
          </div>
        </div>
      ))}
    </div>
  )
}

function verdictClass(r: PairedRow) {
  if (r.better === 'neutral' || !Number.isFinite(r.diff) || Math.abs(r.diff) < 1e-9) return ''
  const good = r.better === 'higher' ? r.diff > 0 : r.diff < 0
  const sure = Number.isFinite(r.ci[0]) && (r.ci[0] > 0 || r.ci[1] < 0)
  return `${good ? 'good' : 'bad'}${sure ? ' sure' : ''}`
}

function Takeaways({ rows, n, t }: { rows: PairedRow[]; n: number; t: T }) {
  const get = (k: string) => rows.find((r) => r.key === k)
  const q = get('checklistPct')
  const tok = get('tokens')
  const time = get('wallSec')
  const need = get('needsResolvedPct')
  const red = get('redundantActions')
  const lines: string[] = []
  if (q && Number.isFinite(q.diff)) {
    const sure = q.ci[0] > 0 || q.ci[1] < 0
    const who = q.diff >= 0 ? 'B' : 'A'
    lines.push(
      t(
        `${who} scored ${fmt(Math.abs(q.diff))} points higher on the checklist (A ${fmt(q.meanA)}% vs B ${fmt(q.meanB)}%). ${sure ? 'The 95% interval excludes zero.' : `The 95% interval [${fmt(q.ci[0])}, ${fmt(q.ci[1])}] includes zero, so with ${n} cases this is not yet a reliable difference.`}`,
        `${who} 组的清单得分高 ${fmt(Math.abs(q.diff))} 分（A ${fmt(q.meanA)}%，B ${fmt(q.meanB)}%）。${sure ? '95% 置信区间不含 0。' : `95% 置信区间 [${fmt(q.ci[0])}, ${fmt(q.ci[1])}] 包含 0，${n} 个案例下还不能算可靠差异。`}`,
      ),
    )
    lines.push(t(`B was better in ${q.wins} case(s), tied in ${q.ties}, worse in ${q.losses}.`, `B 在 ${q.wins} 个案例更好、${q.ties} 个持平、${q.losses} 个更差。`))
  }
  if (tok && Number.isFinite(tok.meanA) && tok.meanA > 0) {
    const ratio = tok.meanB / tok.meanA
    const tr = time && time.meanA > 0 ? time.meanB / time.meanA : NaN
    lines.push(t(`Cost: B used ${fmt(ratio, 1)}× the tokens${Number.isFinite(tr) ? ` and ${fmt(tr, 1)}× the time` : ''} of A.`, `成本：B 的 token 是 A 的 ${fmt(ratio, 1)} 倍${Number.isFinite(tr) ? `，用时是 ${fmt(tr, 1)} 倍` : ''}。`))
  }
  if (need && Number.isFinite(need.meanA))
    lines.push(
      t(
        `Information checklist: A resolved ${fmt(need.meanA, 0)}% of its own needs, B ${fmt(need.meanB, 0)}%; redundant research actions A ${fmt(red?.meanA)} vs B ${fmt(red?.meanB)} per run.`,
        `信息清单：A 解决了自己列出需求的 ${fmt(need.meanA, 0)}%，B 为 ${fmt(need.meanB, 0)}%；每次运行的多余查询 A ${fmt(red?.meanA)}，B ${fmt(red?.meanB)}。`,
      ),
    )
  return (
    <section className="pl-card pl-takeaways">
      <h4>{t('Key takeaways', '结论速读')}</h4>
      <ul>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
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
  const rows = a?.paired.filter((r) => Number.isFinite(r.meanA) || Number.isFinite(r.meanB)) ?? []
  return (
    <div className="pl-view">
      <section className="pl-card">
        <div className="pl-row">
          <select value={exp} onChange={(e) => setExperimentId(e.target.value)} aria-label={t('Experiment', '实验')}>
            {state.experiments.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} · {e.id} · {lbl(t, STATUS_ZH, e.status)}
                {e.error ? ` · ${errText(t, e.error).slice(0, 60)}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="pl-row">
          <button type="button" className="pl-btn ghost" disabled={!exp || Boolean(busy)} onClick={() => act('grade', async () => { await request('grade', { experimentId: exp }); await load() })}>
            {busy === 'grade' ? t('Grading…', '评分中……') : t('Grade unscored', '为未评分运行评分')}
          </button>
          <button type="button" className="pl-btn ghost" disabled={!exp || Boolean(busy) || Boolean(state.job)} onClick={() => act('resume', async () => { await request('resume', { experimentId: exp }) })}>
            {t('Resume failed/missing runs', '续跑失败或缺失的运行')}
          </button>
          <button type="button" className="pl-btn ghost" disabled={!exp} onClick={() => act('blind', async () => saveJson(await request('exportBlind', { experimentId: exp }), `${exp}-blind-review.json`))}>
            {t('Export blind review', '导出盲评包')}
          </button>
          <button type="button" className="pl-btn ghost" disabled={!exp} onClick={() => act('runs', async () => saveJson(await request('exportRuns', { experimentId: exp }), `${exp}-runs.json`))}>
            {t('Export full runs', '导出完整轨迹')}
          </button>
          <button type="button" className="pl-btn ghost" disabled={!exp} onClick={() => file.current?.click()}>
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
        {error && <p className="pl-warn">{errText(t, error)}</p>}
      </section>
      {!a || !a.paired[0]?.n ? (
        <p className="pl-muted">{t('Need at least one scenario with scored A and B runs.', '至少需要一个案例同时有已评分的 A、B 运行。')}</p>
      ) : (
        <>
          <Takeaways rows={a.paired} n={a.paired[0].n} t={t} />
          <section className="pl-card">
            <header className="pl-row">
              <h4>{t('All metrics (paired by case, B − A)', '全部指标（按案例配对，B − A）')}</h4>
              <span className="pl-muted">
                {t('cases', '案例')} {a.paired[0].n} · {t('runs', '运行')} {a.runs.done}/{a.runs.total} · {t('scored', '已评分')} {a.runs.scored}
              </span>
            </header>
            <div className="pl-table-wrap">
              <table className="pl-table pl-metrics">
                <thead>
                  <tr>
                    <th>{t('Metric', '指标')}</th>
                    <th>A</th>
                    <th>B</th>
                    <th>B − A</th>
                    <th>95% CI</th>
                    <th>p</th>
                    <th>{t('B better/tie/worse', 'B 更好/持平/更差')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key} className={r.key === 'checklistPct' ? 'primary' : ''}>
                      <td title={HELP[r.key] ? t(HELP[r.key]![0], HELP[r.key]![1]) : undefined}>
                        {t(r.label, r.labelZh)}
                        {HELP[r.key] && <span className="pl-help">?</span>}
                      </td>
                      <td>{fmt(r.meanA)}</td>
                      <td>{fmt(r.meanB)}</td>
                      <td className={`pl-diff ${verdictClass(r)}`}>
                        {Number.isFinite(r.diff) && r.diff > 0 ? '+' : ''}
                        {fmt(r.diff)}
                      </td>
                      <td>
                        [{fmt(r.ci[0])}, {fmt(r.ci[1])}]
                      </td>
                      <td>{p(r.p)}</td>
                      <td>{r.better === 'neutral' ? '—' : `${r.wins}/${r.ties}/${r.losses}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="pl-muted">
              {t(
                'Green = B better, red = B worse; bold = 95% interval excludes zero. Hover a metric for its meaning.',
                '绿色 = B 更好，红色 = B 更差；加粗 = 95% 区间不含 0。鼠标悬停指标可看含义。',
              )}
            </p>
          </section>
          <section className="pl-card">
            <h4>{t('Checklist score by category', '各类别清单得分')}</h4>
            <Bars rows={a.byCategory.map((c) => ({ label: t(c.category, CAT_ZH[c.category] ?? c.category), A: c.A, B: c.B }))} t={t} unit="%" />
          </section>
          <section className="pl-card">
            <h4>{t('Checklist score by case', '各案例清单得分')}</h4>
            <Bars rows={a.perScenario.map((s) => ({ label: s.scenarioId, A: s.A?.checklistPct ?? NaN, B: s.B?.checklistPct ?? NaN }))} t={t} unit="%" />
          </section>
          <section className="pl-card">
            <h4>{t('Tokens by case', '各案例 token 用量')}</h4>
            <Bars rows={a.perScenario.map((s) => ({ label: s.scenarioId, A: s.A?.tokens ?? NaN, B: s.B?.tokens ?? NaN }))} t={t} />
          </section>
          {result.agreement.length > 0 && (
            <section className="pl-card">
              <h4>{t('Scorer agreement', '评分一致性')}</h4>
              <table className="pl-table">
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
            </section>
          )}
        </>
      )}
    </div>
  )
}

// -------------------------------------------------------------------- cases

function Cases({ state, t }: { state: LabState; t: T }) {
  const [open, setOpen] = useState(state.scenarios[0]?.id)
  const s = state.scenarios.find((x) => x.id === open)
  const units = Object.entries(state.corpus.byUnit)
  const maxUnit = Math.max(1, ...units.map(([, n]) => n))
  return (
    <div className="pl-view">
      <section className="pl-card">
        <h4>{t('Evidence collection', '证据库')}</h4>
        <p className="pl-muted">
          {state.corpus.documents} {t('documents', '份文档')} · {state.corpus.chunks} {t('passages', '段')} · {state.corpus.courses} {t('courses', '门课程')} · {t('built', '构建于')} {state.corpus.builtAt} · v{state.corpus.version}
        </p>
        <div className="pl-bars">
          {units.map(([u, n]) => (
            <div key={u} className="pl-barrow">
              <span>{u}</span>
              <div>
                <i className="c-doc" style={{ width: `${(100 * n) / maxUnit}%` }}>
                  {n}
                </i>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="pl-card">
        <div className="pl-row">
          <select value={open} onChange={(e) => setOpen(e.target.value)} aria-label={t('Case', '案例')}>
            {state.scenarios.map((x) => (
              <option key={x.id} value={x.id}>
                {x.id} · {titleOf(t, x)}
              </option>
            ))}
          </select>
        </div>
        {s && (
          <>
            <p>
              <span className="pl-tag">{lbl(t, SPLIT_ZH, s.split)}</span> <span className="pl-tag">{t(s.category, CAT_ZH[s.category] ?? s.category)}</span> <span className="pl-tag">{s.year}</span> {s.majors.join(' / ')}
            </p>
            <p className="pl-bubble stu">{s.opening}</p>
            <h4>{t('Hidden profile (revealed only when asked)', '隐藏档案（只有被问到才透露）')}</h4>
            <ul className="pl-facts-list">
              {s.facts.map((f) => (
                <li key={f.id}>
                  <b>{f.topic}</b>
                  {f.critical && <span className="pl-tag warn">{t('critical', '关键')}</span>}
                  <span className="pl-muted">“{f.answer}”</span>
                </li>
              ))}
            </ul>
            <h4>{t('Scoring checklist', '评分清单')}</h4>
            <ul className="pl-facts-list">
              {s.checklist.map((c) => (
                <li key={c.id}>
                  <b>{c.id}</b> <span className="pl-tag">{lbl(t, TYPE_ZH, c.type)}</span> <span className="pl-tag">×{c.weight}</span> {c.text}
                  {c.docs && <small className="pl-muted"> ({c.docs.join(', ')})</small>}
                </li>
              ))}
            </ul>
            <h4>{t('What a strong answer covers', '好答案应覆盖的要点')}</h4>
            <p>{s.reference}</p>
          </>
        )}
      </section>
    </div>
  )
}

// -------------------------------------------------------------------- panel

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
  const watch = useCallback((ids: string[]) => setWatching(ids), [])
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
    <div className="pl">
      <header className="pl-head">
        <div>
          <div className="pl-eyebrow">PATHFINDER UCD · ADVISING LAB</div>
          <h2>{t('How does an AI advisor find the answer?', 'AI 顾问是怎样找到答案的？')}</h2>
          <p className="pl-muted">
            {state?.model ? `${state.model.id}` : t('No model selected in Harness settings', '尚未在 Harness 设置里选择模型')} · {t('single agent vs institution-scoped team', '单 Agent 对比按学校职责分工的团队')} · ECS · PSC · LIN · MAT
          </p>
        </div>
        <select
          className="pl-lang"
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
      <nav className="pl-tabs" role="tablist">
        {(
          [
            ['consult', t('Consult', '咨询')],
            ['experiment', t('Experiment', '实验')],
            ['results', t('Results', '结果')],
            ['cases', t('Cases & data', '案例与数据')],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} className={view === k ? 'on' : ''} onClick={() => setView(k)}>
            {label}
            {k === 'experiment' && pendingCount > 0 && <span className="pl-badge-dot">{pendingCount}</span>}
          </button>
        ))}
      </nav>
      {error && <p className="pl-warn">{errText(t, error)}</p>}
      {!state ? (
        <p className="pl-muted pl-view">{t('Loading…', '加载中……')}</p>
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
    <button className="pl-entry" type="button" title={title} aria-label={title} onClick={open}>
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
    const result = await rpc.call(channel, endpoints[endpoint], payload)
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
          description: () => (isZh() ? 'UC Davis 学业咨询：看 AI 如何查资料、做判断' : 'UC Davis advising: watch how the AI finds the answer'),
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
