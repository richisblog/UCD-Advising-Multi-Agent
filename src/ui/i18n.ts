// Shared i18n + formatting helpers for every lab view.

export type T = (en: string, zh: string) => string
export type LangPref = 'follow' | 'en' | 'zh'

const LANG_KEY = 'pathfinder-lab-language'

export function readLang(): LangPref {
  try {
    const v = window.localStorage.getItem(LANG_KEY)
    return v === 'en' || v === 'zh' ? v : 'follow'
  } catch {
    return 'follow'
  }
}
export function saveLang(v: LangPref) {
  try {
    window.localStorage.setItem(LANG_KEY, v)
  } catch {
    /* storage unavailable: the choice still applies to this view */
  }
}

export const ROLE: Record<string, { en: string; zh: string; short: string; shortZh: string; color: string }> = {
  student: { en: 'Student', zh: '学生', short: 'Student', shortZh: '学生', color: '#3b82f6' },
  advisor: { en: 'Single Advisor', zh: '单 Agent 顾问', short: 'Advisor', shortZh: '顾问', color: '#f97316' },
  personal: { en: 'Personal Agent', zh: '个人顾问', short: 'Personal', shortZh: '个人顾问', color: '#f97316' },
  university: { en: 'University Policy', zh: '校级政策', short: 'University', shortZh: '校级', color: '#7c3aed' },
  'college-ls': { en: 'College · L&S', zh: '文理学院', short: 'L&S', shortZh: '文理', color: '#0d9488' },
  'college-coe': { en: 'College · Engineering', zh: '工程学院', short: 'Engineering', shortZh: '工程', color: '#0d9488' },
  'dept-ecs': { en: 'Dept · Computer Science', zh: '计算机系', short: 'CS', shortZh: '计算机', color: '#dc2626' },
  'dept-psc': { en: 'Dept · Psychology', zh: '心理学系', short: 'Psych', shortZh: '心理', color: '#dc2626' },
  'dept-lin': { en: 'Dept · Linguistics', zh: '语言学系', short: 'Ling', shortZh: '语言学', color: '#dc2626' },
  'dept-mat': { en: 'Dept · Mathematics', zh: '数学系', short: 'Math', shortZh: '数学', color: '#dc2626' },
}
export const roleName = (t: T, a: string) => (ROLE[a] ? t(ROLE[a].en, ROLE[a].zh) : a)
export const roleShort = (t: T, a: string) => (ROLE[a] ? t(ROLE[a].short, ROLE[a].shortZh) : a)

export const CAT_ZH: Record<string, string> = {
  'unclear-interests': '兴趣不明确',
  'uncertain-preparation': '准备情况不确定',
  'workload-tradeoff': '学业负担取舍',
  'overlapping-requirements': '要求交叉重叠',
  'procedural-risk': '程序/期限风险',
}
export const STATUS_ZH: Record<string, string> = { running: '进行中', done: '完成', failed: '失败', cancelled: '已取消', stopped: '已停止' }
export const TYPE_ZH: Record<string, string> = { elicit: '追问事实', cite: '核对来源', next_step: '下一步', referral: '转介顾问', caution: '风险提示', avoid: '避免错误' }
export const METHOD_ZH: Record<string, string> = { auto: '自动', judge: '评审模型', rule: '规则' }
export const VERDICT_ZH: Record<string, string> = { supported: '有依据', partial: '部分有依据', unsupported: '无依据', contradicted: '与证据矛盾', uncited: '未引用' }
export const SPLIT_ZH: Record<string, string> = { dev: '开发', heldout: '留出' }
export const NEED_ZH: Record<string, string> = { open: '待查', partial: '部分', answered: '已解答', blocked: '需顾问' }
export const NEED_EN: Record<string, string> = { open: 'Open', partial: 'Partial', answered: 'Answered', blocked: 'Needs advisor' }

export const lbl = (t: T, map: Record<string, string>, key: string) => t(key, map[key] ?? key)
export const titleOf = (t: T, s: { title: string; titleZh?: string }) => t(s.title, s.titleZh ?? s.title)

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
export const errText = (t: T, message: string) => t(message, ERROR_ZH.find(([re]) => re.test(message))?.[1] ?? message)

export const fmt = (x: number | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d))
export const secs = (ms: number) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s` : `${Math.round(ms / 1000)}s`)
export const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export function saveJson(value: unknown, file: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = file
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
