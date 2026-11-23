import type { Chunk, Course, CorpusData, CorpusDocument, Level, Unit } from './types.js'

// BM25 over the policy chunks, with an explicit responsibility filter.
// Condition A searches with scope "all" (optionally narrowing itself);
// each Condition B specialist is hard-limited to its own units.

const STOP = new Set(
  'a an and are as at be by can do does for from has have i if in into is it its may me my of on or our so that the their them then there these they this to was we were what when which who will with you your how should would could not no yes'.split(
    ' ',
  ),
)

/** Chinese advising vocabulary → English query terms (the corpus is English). */
const GLOSSARY: [RegExp, string][] = [
  [/转专业|换专业|更换专业/, 'change of major declare petition'],
  [/申报专业|宣布专业|declare/i, 'declare major'],
  [/双专业|双学位/, 'double major multiple majors'],
  [/辅修/, 'minor'],
  [/先修|先决/, 'prerequisite'],
  [/学分/, 'units credit'],
  [/绩点|GPA/i, 'GPA grade point average'],
  [/微积分/, 'calculus MAT 021A'],
  [/编程|程序设计/, 'programming ECS 032A'],
  [/计算机/, 'computer science'],
  [/心理/, 'psychology'],
  [/语言学/, 'linguistics'],
  [/数学/, 'mathematics'],
  [/统计/, 'statistics'],
  [/工程学院/, 'college of engineering'],
  [/文理学院/, 'letters science'],
  [/学术察看|试读|留校察看/, 'academic probation standing'],
  [/退课|弃课/, 'drop course deadline'],
  [/加课|选课/, 'add course register'],
  [/通过\/不通过|P\/NP|PNP/i, 'passed not passed P/NP'],
  [/重修/, 'repeat course'],
  [/截止|期限/, 'deadline'],
  [/毕业/, 'graduation degree requirements'],
  [/通识/, 'general education GE'],
  [/写作/, 'writing'],
  [/转学生/, 'transfer students'],
  [/学业进度|最低进度/, 'minimum progress units'],
  [/上限/, 'maximum limit 225'],
  [/未申报|未定专业|undeclared/i, 'undeclared'],
  [/顾问|咨询/, 'advisor advising appointment'],
  [/AP/, 'advanced placement AP exam'],
  [/IB/, 'international baccalaureate IB'],
]

export function normalizeCourse(raw: string): string | null {
  const m = raw.toUpperCase().match(/\b([A-Z]{2,4})\s*0*(\d{1,3})([A-Z]{0,2})\b/)
  if (!m) return null
  return `${m[1]} ${m[2]}${m[3]}`
}

export function tokenize(text: string): string[] {
  let t = text
  for (const [re, en] of GLOSSARY) if (re.test(t)) t += ` ${en}`
  const out: string[] = []
  // course codes as single tokens: "ECS 032A" and "ECS 32A" both → ecs32a
  for (const m of t.toUpperCase().matchAll(/\b([A-Z]{2,4})\s*0*(\d{1,3})([A-Z]{0,2})\b/g))
    out.push(`${m[1]}${m[2]}${m[3]}`.toLowerCase())
  for (const w of t.toLowerCase().split(/[^a-z0-9.]+/)) {
    const word = w.replace(/^\.+|\.+$/g, '')
    if (!word || STOP.has(word) || word.length < 2) continue
    out.push(word.endsWith('s') && word.length > 4 ? word.slice(0, -1) : word)
  }
  return out
}

export interface SearchHit {
  id: string
  doc: CorpusDocument
  chunk: Chunk
  score: number
}

export interface Scope {
  units?: Unit[]
  levels?: Level[]
}

export class Corpus {
  readonly version: string
  readonly builtAt: string
  readonly documents = new Map<string, CorpusDocument>()
  readonly chunks = new Map<string, Chunk>()
  readonly courses = new Map<string, Course>()
  private postings = new Map<string, Map<string, number>>()
  private lengths = new Map<string, number>()
  private avgLength = 1

  constructor(data: CorpusData) {
    this.version = data.version
    this.builtAt = data.builtAt
    for (const d of data.documents) this.documents.set(d.id, d)
    for (const c of data.courses) this.courses.set(c.code, c)
    let total = 0
    for (const c of data.chunks) {
      this.chunks.set(c.id, c)
      const doc = this.documents.get(c.doc)
      const tokens = tokenize(`${doc?.title ?? ''} ${c.heading} ${c.heading} ${c.text}`)
      this.lengths.set(c.id, tokens.length)
      total += tokens.length
      for (const tok of tokens) {
        let p = this.postings.get(tok)
        if (!p) this.postings.set(tok, (p = new Map()))
        p.set(c.id, (p.get(c.id) ?? 0) + 1)
      }
    }
    this.avgLength = total / Math.max(1, data.chunks.length)
  }

  inScope(docId: string, scope?: Scope): boolean {
    const doc = this.documents.get(docId)
    if (!doc) return false
    if (scope?.units?.length && !scope.units.includes(doc.unit)) return false
    if (scope?.levels?.length && !scope.levels.includes(doc.level)) return false
    return true
  }

  search(query: string, scope?: Scope, k = 4): SearchHit[] {
    const q = [...new Set(tokenize(query))]
    const N = this.chunks.size
    const scores = new Map<string, number>()
    const k1 = 1.4
    const b = 0.7
    for (const tok of q) {
      const p = this.postings.get(tok)
      if (!p) continue
      const idf = Math.log(1 + (N - p.size + 0.5) / (p.size + 0.5))
      const boost = /^[a-z]{2,4}\d/.test(tok) ? 2 : 1 // exact course codes matter most
      for (const [id, tf] of p) {
        const chunk = this.chunks.get(id)!
        if (!this.inScope(chunk.doc, scope)) continue
        const len = this.lengths.get(id) ?? this.avgLength
        const s = (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * len) / this.avgLength))
        scores.set(id, (scores.get(id) ?? 0) + s * boost)
      }
    }
    const ranked = [...scores.entries()].sort((a, b2) => b2[1] - a[1])
    // at most two chunks from one document so a long page cannot crowd out others
    const perDoc = new Map<string, number>()
    const hits: SearchHit[] = []
    for (const [id, score] of ranked) {
      const chunk = this.chunks.get(id)!
      const n = perDoc.get(chunk.doc) ?? 0
      if (n >= 2) continue
      perDoc.set(chunk.doc, n + 1)
      hits.push({ id, chunk, doc: this.documents.get(chunk.doc)!, score })
      if (hits.length >= k) break
    }
    return hits
  }

  course(raw: string): Course | undefined {
    const code = normalizeCourse(raw)
    return code ? this.courses.get(code) : undefined
  }

  /** Text of a cited evidence id, for the grader. `COURSE:ECS 32A` ids name course records. */
  evidenceText(id: string): string | undefined {
    if (id.startsWith('COURSE:')) {
      const c = this.course(id.slice(7))
      return c ? formatCourse(c) : undefined
    }
    const chunk = this.chunks.get(id)
    if (!chunk) return undefined
    const doc = this.documents.get(chunk.doc)
    return `${doc?.title} — ${chunk.heading}\n${chunk.text}`
  }

  docOf(id: string): string | undefined {
    if (id.startsWith('COURSE:')) return 'COURSES'
    return this.chunks.get(id)?.doc
  }
}

export function formatCourse(c: Course): string {
  const parts = [
    `${c.code} — ${c.title} ${c.units}`,
    c.prerequisites && `Prerequisites: ${c.prerequisites}`,
    c.creditLimitations && `Credit limitations: ${c.creditLimitations}`,
    c.gradeMode && `Grade mode: ${c.gradeMode}`,
    c.ge && `GE: ${c.ge}`,
    c.activities && `Activities: ${c.activities}`,
    c.description && `Description: ${c.description}`,
    c.reviews &&
      `Informal student reviews (not official): rating ${c.reviews.rating.toFixed(1)}/5, difficulty ${c.reviews.difficulty.toFixed(1)}/5, n=${c.reviews.count}`,
    `Catalog record date: ${c.updatedAt ?? 'unknown'}`,
  ]
  return parts.filter(Boolean).join('\n')
}

export function formatHit(hit: SearchHit, maxChars = 900): string {
  const d = hit.doc
  const flag = d.source === 'legacy-db' ? ` [LEGACY local record, ${d.note ?? 'undated'}]` : ''
  const text = hit.chunk.text.length > maxChars ? `${hit.chunk.text.slice(0, maxChars)}…` : hit.chunk.text
  return `[${hit.id}] ${d.title} (${d.level}/${d.unit}, retrieved ${d.retrievedAt})${flag}\n§ ${hit.chunk.heading}\n${text}`
}
