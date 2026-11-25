import { useMemo, useRef, useState } from 'react'
import type { EvidenceView } from '../contract.js'
import type { RunRecord } from '../core/types.js'
import { ChecklistBoard, ProgressRing } from './Checklist.js'
import { Flow } from './Flow.js'
import { kTok, secs, type T } from './i18n.js'
import { snapshotAt, useReplay, type Replay } from './replay.js'
import { headline, Story } from './Story.js'
import { Timeline } from './Timeline.js'

// "How the AI found the answer": every process view shares one replay cursor.

function Player({ replay, total, t, onPresent }: { replay: Replay; total: number; t: T; onPresent: () => void }) {
  return (
    <div className="pl-player">
      <button type="button" onClick={() => replay.jump(0)} title={t('First step', '第一步')} aria-label={t('First step', '第一步')}>
        ⏮
      </button>
      <button type="button" onClick={() => replay.jump(replay.step - 1)} title={t('Previous', '上一步')} aria-label={t('Previous', '上一步')}>
        ◀
      </button>
      <button type="button" className="pl-play" onClick={replay.toggle} aria-label={replay.playing ? t('Pause', '暂停') : t('Play', '播放')}>
        {replay.playing ? '⏸' : '▶'}
      </button>
      <button type="button" onClick={() => replay.jump(replay.step + 1)} title={t('Next', '下一步')} aria-label={t('Next', '下一步')}>
        ▶|
      </button>
      <input
        type="range"
        min={0}
        max={replay.last}
        value={replay.step}
        onChange={(e) => replay.jump(Number(e.target.value))}
        aria-label={t('Step', '步骤')}
      />
      <span className="pl-stepcount">
        {total ? replay.step + 1 : 0}/{total}
      </span>
      <select value={replay.speed} onChange={(e) => replay.setSpeed(Number(e.target.value))} aria-label={t('Speed', '速度')}>
        <option value={0.5}>0.5×</option>
        <option value={1}>1×</option>
        <option value={2}>2×</option>
        <option value={4}>4×</option>
      </select>
      <button type="button" className={replay.follow ? 'on' : ''} onClick={() => replay.setFollow(!replay.follow)}>
        {replay.live ? t('● Live', '● 实时') : t('End', '结尾')}
      </button>
      <button type="button" onClick={onPresent}>
        ⛶ {t('Present', '演示')}
      </button>
    </div>
  )
}

export function Process({ run, evidence, t }: { run: RunRecord; evidence: Record<string, EvidenceView>; t: T }) {
  const events = run.trace
  const live = run.status === 'running'
  const replay = useReplay(events.length, live)
  const [thoughts, setThoughts] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const snap = useMemo(() => snapshotAt(run, events, replay.step, evidence), [run, events, replay.step, evidence])
  const atEnd = !live && replay.step >= replay.last
  const done = snap.checklist.filter((i) => i.status === 'answered' || i.status === 'blocked').length
  const present = () => {
    if (document.fullscreenElement) void document.exitFullscreen()
    else void box.current?.requestFullscreen?.()
  }
  const caption = snap.event?.kind === 'thought' ? snap.event.text : headline(snap.event, t)

  return (
    <div className="pl-process" ref={box}>
      <div className="pl-kpis">
        <div className="pl-kpi ring">
          <ProgressRing done={done} total={snap.checklist.length} size={52} />
          <span>{t('needs resolved', '信息已解决')}</span>
        </div>
        <div className="pl-kpi">
          <b>{snap.docs.size}</b>
          <span>{t('documents read', '份文件已查阅')}</span>
        </div>
        <div className="pl-kpi">
          <b>{snap.factsShared}</b>
          <span>{t('answers from student', '条学生回答')}</span>
        </div>
        <div className="pl-kpi">
          <b>
            {kTok(snap.tokens)}
            <small>/{kTok(run.budget.tokens)}</small>
          </b>
          <span>tokens</span>
          <i className="pl-kpi-bar" style={{ width: `${Math.min(100, (100 * snap.tokens) / run.budget.tokens)}%` }} />
        </div>
        <div className="pl-kpi">
          <b>
            {snap.calls}
            <small>/{run.budget.modelCalls}</small>
          </b>
          <span>{t('model calls', '次模型调用')}</span>
          <i className="pl-kpi-bar" style={{ width: `${Math.min(100, (100 * snap.calls) / run.budget.modelCalls)}%` }} />
        </div>
        <div className="pl-kpi">
          <b>{secs(snap.elapsedMs)}</b>
          <span>{t('elapsed', '已用时')}</span>
        </div>
      </div>

      <Player replay={replay} total={events.length} t={t} onPresent={present} />

      <p className={`pl-caption k-${snap.event?.kind ?? 'none'}`} aria-live="polite">
        {caption}
        {snap.thought && snap.event?.kind !== 'thought' && <small className="pl-caption-thought">💭 {snap.thought}</small>}
      </p>

      <div className="pl-stage">
        <div className="pl-card pl-flow">
          <Flow run={run} snap={snap} evidence={evidence} t={t} final={atEnd} />
          <ul className="pl-legend">
            <li className="k-ask">{t('student Q&A', '追问学生')}</li>
            <li className="k-delegate">{t('task handed off', '委派任务')}</li>
            <li className="k-handoff">{t('specialist asks another', '专家互相交接')}</li>
            <li className="k-report">{t('findings returned', '回传结论')}</li>
            <li className="k-search">{t('document search', '检索文件')}</li>
          </ul>
        </div>
        <ChecklistBoard items={snap.checklist} changed={snap.changedNeeds} event={snap.event} evidence={evidence} t={t} enabled={run.budget.checklist !== false} />
      </div>

      <Timeline run={run} events={events} replay={replay} t={t} />

      <label className="pl-muted pl-toggle">
        <input type="checkbox" checked={thoughts} onChange={(e) => setThoughts(e.target.checked)} /> {t('Show the agents’ reasoning notes', '显示智能体的思路')}
      </label>
      <Story events={events} replay={replay} evidence={evidence} t={t} showThoughts={thoughts} />
    </div>
  )
}
