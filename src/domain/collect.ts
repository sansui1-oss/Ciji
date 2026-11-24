import { getStudyProgress, getTodayItems, queryStudyRecords } from '@/api/study'
import type { QueryRecordsRequest, StudyRecord, StudyResponse } from '@/api/types'

import { dateKey, diffDays } from '@/lib/date'

export type WordState = 'new' | 'vague' | 'forget'

export interface CollectedWord {
  vocId: string
  spelling: string
  /**
   * 归属的分组，可多个。
   * 「今天新学、但答了模糊」的单词既属于新学，也属于模糊 —— 两个维度是正交的，
   * 强行互斥会让新学数量凭空变少。
   */
  groups: WordState[]
  isNew: boolean
  firstResponse?: StudyResponse
  /** 当天最后一次反馈，仅当能查到记录时存在 */
  lastResponse?: StudyResponse
  isFinished: boolean
  order: number
}

export interface TodaySnapshot {
  /** YYYY-MM-DD（北京时间） */
  date: string
  finished: number
  total: number
  studyTimeMs: number
  words: CollectedWord[]
  collectedAt: string
  /** 接口返回不完整时的说明，界面据此提示而不是假装正常 */
  warning?: string
  /** 诊断：接口原始返回条数 */
  rawCount: number
  /** 诊断：其中今天真正学过的条数 */
  studiedCount: number
}

/** 中文短语，用于界面上的「初模糊 → 终认识」 */
export const RESPONSE_LABEL: Record<StudyResponse, string> = {
  FAMILIAR: '认识',
  VAGUE: '模糊',
  FORGET: '忘记',
  WELL_FAMILIAR: '熟知',
  CANCEL_WELL_FAMILIAR: '取消熟知',
}

/**
 * 判断一个词今天是否真的学过。
 * get_today_items 会返回「今天安排了但还没学」的词，必须排除。
 * 注意不能只看 is_finished —— 学到一半退出时 first_response 已有值但未完成。
 */
function wasStudied(item: {
  first_response?: StudyResponse
  is_finished: boolean
}): boolean {
  return item.is_finished || Boolean(item.first_response)
}

/**
 * 这个词属于哪一组。三类彻底互斥（2026-11-10 用户要求）。
 * - 新学：is_new 为真 → 只进「新学」，哪怕今天答了忘记/模糊
 * - 复习词（非新学）：按当天第一次反馈进「模糊 / 忘记」
 * 只复习且答「认识」的词不属于任何组，界面上不需要展示。
 *
 * 竖线颜色仍按反馈走（lineState），新学组里答错的词照样能一眼看出来。
 */
function classify(item: {
  is_new: boolean
  first_response?: StudyResponse
}): WordState[] {
  if (item.is_new) return ['new']
  if (item.first_response === 'VAGUE') return ['vague']
  if (item.first_response === 'FORGET') return ['forget']
  return []
}

/** 竖线颜色按反馈走，不按分组走 —— 新学组里答错的词也能一眼看出来 */
export function lineState(word: CollectedWord): WordState {
  if (word.firstResponse === 'FORGET') return 'forget'
  if (word.firstResponse === 'VAGUE') return 'vague'
  return 'new'
}

/**
 * 三组各有多少个词。
 *
 * **凡是把「新学 / 模糊 / 忘记」当成三类展示或计数的地方，都必须用它。**
 * 以前统计页自己算了两套：柱状图按 `lineState`（看反馈）、摘要按 `isNew` +
 * `firstResponse`（允许重叠）。结果同一个「新学但答错」的词，在今日页算新学、
 * 在统计页算忘记，两页数字必然对不上——口径不一致比算错更难查。
 *
 * 依据是 `groups`（`classify()` 的互斥归组，与今日页分组、生成页词类同源）。
 */
export function groupCounts(words: CollectedWord[]): Record<WordState, number> {
  const counts: Record<WordState, number> = { new: 0, vague: 0, forget: 0 }
  for (const w of words) for (const g of w.groups) counts[g] += 1
  return counts
}

/* ── 计划内全部单词（生成页「全部单词」范围）────────────────── */

/** 接口一次最多返回的记录数（query_study_records 的 limit 上限） */
const PLAN_FETCH_LIMIT = 1000

/** 分批拉取时 next_study_date 的最外层窗口起点。复习日期再老都极少见，
    窗口外的记录由兜底的不带过滤拉取 + 对账去接 */
const PLAN_DATE_WINDOW_START = '2015-01-01'

/**
 * 计划内单词的类型（单选，互斥）。
 * 故意不用 CollectedWord：它的 groups 是当天的 WordState（只有三类），
 * 扩成四类会牵连今日 / 历史 / 统计页和 WordRow —— 计划内单词只在生成页用，
 * 单独一个类型最干净。
 */
export type PlanWordKind = 'new' | 'vague' | 'forget' | 'pending'

export interface PlanWord {
  vocId: string
  spelling: string
  /** 互斥的唯一归属（见 classifyPlanRecord） */
  kind: PlanWordKind
  /** 最近一次反馈，待学的词没有 */
  lastResponse?: StudyResponse
}

export interface PlanSnapshot {
  /** query_study_records(as_count) 返回的计划内总数；拿不到时为 null */
  total: number | null
  /** 实际拉到的记录数（按 voc_id 去重后） */
  fetched: number
  /** 对账后还少的词数：total - fetched；总数拿不到时为 null */
  missing: number | null
  /** 总数超过一次能拉的上限，列表不完整 */
  truncated: boolean
  /** 已按计划内规则归过类的词（只含属于某一组的） */
  words: PlanWord[]
  collectedAt: string
  /** 接口返回不完整时的说明，界面据此提示而不是假装正常 */
  warning?: string
}

/** 从日期字符串里取 YYYY-MM-DD 一段（墨墨可能带时间部分，解析不出返回 null） */
function datePart(s?: string): string | null {
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim())
  return m ? m[1] : null
}

/**
 * 计划内单词的归组，四类彻底互斥（与当天 classify 同风格，优先级见顺序）：
 * - 待学：study_count 为 0，或没有 first_study_date（加进计划还没学过）
 * - 忘记：最近一次反馈是 FORGET
 * - 模糊：最近一次反馈是 VAGUE
 * - 新学：学过，且 first_study_date 在最近 7 天内（今天 + 往前 6 天），且不属于忘记 / 模糊
 * 以上都不是的已学词（比如认识很久的）不属于任何组，不进候选 ——
 * 跟「只复习且答认识的词不展示」一个道理。
 *
 * 注意和当天规则的区别：当天是「新学优先」（is_new 的词只进新学），
 * 这里是「忘记 / 模糊优先」——最近才开始学、但上次答错的词，更值得按错因练。
 */
function classifyPlanRecord(r: StudyRecord, today: string): PlanWordKind | null {
  if ((r.study_count ?? 0) <= 0 || !r.first_study_date) return 'pending'
  if (r.last_response === 'FORGET') return 'forget'
  if (r.last_response === 'VAGUE') return 'vague'
  const first = datePart(r.first_study_date)
  if (first) {
    const ago = diffDays(today, first)
    if (ago >= 0 && ago < 7) return 'new'
  }
  return null
}

/* ── 分批拉取的工具（只给 collectAllPlan 用）───────────────── */

/** YYYY-MM-DD 加减天数（按 UTC 日历算，和 diffDays 的口径一致） */
function addDaysKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number)
  if (!y || !m || !d) return key
  const t = new Date(Date.UTC(y, m - 1, d + days, 12))
  const yy = t.getUTCFullYear()
  const mm = String(t.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(t.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

/**
 * 把 [start, end]（两端都含）按自然年 / 季度 / 月 / 日切成若干段。
 * 各段互相不重叠、拼起来正好是原段；start > end 或日期非法时原样返回一段（切不动）。
 * 注意：这里假定接口的 next_study_date 是「两端都含」—— 这是 { start, end }
 * 日期过滤最常见的语义；万一服务端把 end 当不含，边界那天的记录可能漏进
 * 兜底拉取和对账里报出来，不会悄悄丢。
 */
function splitDateRange(
  start: string,
  end: string,
  level: 'year' | 'quarter' | 'month' | 'day',
): Array<[string, string]> {
  const min = (a: string, b: string) => (a <= b ? a : b)
  const max = (a: string, b: string) => (a >= b ? a : b)
  if (start > end) return [[start, end]]

  if (level === 'day') {
    const out: Array<[string, string]> = []
    let cur = start
    while (cur <= end) {
      out.push([cur, cur])
      if (cur === end) break
      cur = addDaysKey(cur, 1)
      // 兜底：调用方只在月段（<= 32 天）上切到日，正常到不了这里
      if (out.length > 366) break
    }
    return out.length > 0 ? out : [[start, end]]
  }

  const [y0, m0] = start.split('-').map(Number)
  const [y1, m1] = end.split('-').map(Number)
  if (!y0 || !m0 || !y1 || !m1) return [[start, end]]

  // 各段的段首：年是 1 月 1 日，季度是 1 / 4 / 7 / 10 月 1 日，月是 1 日
  const heads: string[] = []
  if (level === 'year') {
    for (let y = y0; y <= y1; y += 1) heads.push(`${y}-01-01`)
  } else if (level === 'quarter') {
    let y = y0
    let m = Math.floor((m0 - 1) / 3) * 3 + 1
    while (y < y1 || (y === y1 && m <= m1)) {
      heads.push(`${y}-${String(m).padStart(2, '0')}-01`)
      m += 3
      if (m > 12) {
        m = 1
        y += 1
      }
    }
  } else {
    let y = y0
    let m = m0
    while (y < y1 || (y === y1 && m <= m1)) {
      heads.push(`${y}-${String(m).padStart(2, '0')}-01`)
      m += 1
      if (m > 12) {
        m = 1
        y += 1
      }
    }
  }

  // 每段的段尾 = 下一段段首的前一天；最后一段的段尾 = end
  return heads.map((h, i) => {
    const segStart = max(h, start)
    const segEnd = i + 1 < heads.length ? min(addDaysKey(heads[i + 1], -1), end) : end
    return [segStart, segEnd] as [string, string]
  })
}

/** 按跨度选切分粒度：年 → 季度 → 月 → 日；同一天（或非法段）返回 null，切不动 */
function splitLevel(start: string, end: string): 'year' | 'quarter' | 'month' | 'day' | null {
  const span = diffDays(end, start)
  if (!Number.isFinite(span) || span <= 0) return null
  if (span > 370) return 'year'
  if (span > 95) return 'quarter'
  if (span > 32) return 'month'
  return 'day'
}

/** 查某片的总数（as_count），只读 count；失败返回 null，不抛错 */
async function countRecords(req: QueryRecordsRequest): Promise<number | null> {
  try {
    const res = await queryStudyRecords({ ...req, as_count: true })
    return typeof res.count === 'number' ? res.count : null
  } catch {
    return null
  }
}

/** 拉某片的记录并按 voc_id 并进表；失败返回 0，不抛错、不让整页崩掉 */
async function fetchRecordsInto(
  req: QueryRecordsRequest,
  into: Map<string, StudyRecord>,
): Promise<number> {
  let res
  try {
    res = await queryStudyRecords({ ...req, limit: PLAN_FETCH_LIMIT })
  } catch {
    return 0
  }
  let added = 0
  for (const r of res.records ?? []) {
    if (!r.voc_id) continue
    if (!into.has(r.voc_id)) {
      into.set(r.voc_id, r)
      added += 1
    }
  }
  return added
}

/**
 * 按 next_study_date 的日期段拉一片。
 *
 * 切法：年 → 季度 → 月 → 日；每段先 as_count，<= 1000 直接拉，超了继续切；
 * 细到一天还超 1000 就直接拉一次（认栽，对账会报出来）。
 *
 * 盲区：没有 next_study_date 的记录（比如还没学过的待学词）可能不进任何一片，
 * 靠外层的兜底拉取 + 对账去接；日期过滤本身也是公测语义，服务端不认就等于
 * 每片都返回同一批前 1000 条，去重后对账一样会报出缺口。
 */
async function fetchByDateRange(
  baseReq: QueryRecordsRequest,
  start: string,
  end: string,
  into: Map<string, StudyRecord>,
): Promise<void> {
  const req: QueryRecordsRequest = {
    ...baseReq,
    next_study_date: { start, end },
  }
  const count = await countRecords(req)
  if (count === null) {
    // 计数失败：直接拉一次，成败由 fetchRecordsInto 兜底
    await fetchRecordsInto(req, into)
    return
  }
  if (count === 0) return
  if (count <= PLAN_FETCH_LIMIT) {
    await fetchRecordsInto(req, into)
    return
  }
  const level = splitLevel(start, end)
  if (level === null) {
    // 已细到一天还超 1000：直接拉一次，超出的部分认栽，对账会报出来
    await fetchRecordsInto(req, into)
    return
  }
  for (const [s, e] of splitDateRange(start, end, level)) {
    await fetchByDateRange(baseReq, s, e, into)
  }
}

/**
 * 拉取学习计划里的全部单词。
 *
 * 只能做到「已加入学习计划的全部单词」：墨墨开放 API 没有「整本单词书」接口，
 * 书里还没加进计划的词接口根本不给 —— 界面必须把这句写清楚，不许写成「单词书全部」。
 *
 * 为什么要分批：query_study_records 一次最多返回 1000 条，又没有 offset 和翻页游标，
 * 所以只能拿过滤条件当「页」来切。切法分三层：
 * 1. 先按 tags 切三片（STICKING / WELL_FAMILIAR / ''）。注意这层有两处不确定：
 *    服务端可能把 tags: '' 当成「不过滤」而不是「只取无标签」，也可能根本不认 tags ——
 *    无论哪种，三片都会重叠，但合并时按 voc_id 去重，所以重叠只会多发几次请求，
 *    不会多算词；每片的 count 只用来决定要不要继续切，不参与对账。
 * 2. 超 1000 的片再按 next_study_date 的日期段切（年 → 季度 → 月 → 日），
 *    每段先 as_count 再拉，直到每段 <= 1000 或细到一天。
 * 3. 对账是最后一道防线：全部片按 voc_id 去重后和总数 N 比对。少了就再补一次
 *    不带过滤条件的拉取（没学过的词可能只有不带过滤的查询才返回），补完再对一次；
 *    仍然少的，missing 如实记进快照，界面照实显示，不许把没读到的藏起来。
 * 每片拉取失败按 0 算，不让整页崩掉，缺口同样体现在 missing 里。
 *
 * 总数拿不到时不挡主流程：直接拉一次，能读多少是多少，只是不报截断。
 * 总数 <= 1000 时保持一次拉取，别多此一举。
 */
export async function collectAllPlan(): Promise<PlanSnapshot> {
  const today = dateKey()

  const total = await countRecords({})
  const byId = new Map<string, StudyRecord>()

  if (total === null || total <= PLAN_FETCH_LIMIT) {
    // 总数拿不到，或一次能拉完：老路，直接拉一次
    await fetchRecordsInto({}, byId)
  } else {
    // 总数超过一次上限：先按 tags 切三片，超了的片再按日期段切
    for (const tags of ['STICKING', 'WELL_FAMILIAR', ''] as const) {
      const baseReq: QueryRecordsRequest = { tags }
      const count = await countRecords(baseReq)
      if (count === null) {
        // 这片计数失败：直接拉一次，成败由 fetchRecordsInto 兜底
        await fetchRecordsInto(baseReq, byId)
        continue
      }
      if (count === 0) continue
      if (count <= PLAN_FETCH_LIMIT) {
        await fetchRecordsInto(baseReq, byId)
        continue
      }
      const windowEnd = `${Number(today.slice(0, 4)) + 3}-12-31`
      await fetchByDateRange(baseReq, PLAN_DATE_WINDOW_START, windowEnd, byId)
    }
    // 对账 + 兜底：没学过的词可能没有 next_study_date，不进任何日期片；
    // 再补一次不带过滤条件的拉取，能捞回多少是多少，捞完再对一次账
    if (byId.size < total) {
      await fetchRecordsInto({}, byId)
    }
  }

  const records = [...byId.values()]

  const words: PlanWord[] = []
  for (const r of records) {
    const spelling = (r.voc_spelling ?? '').trim()
    if (!spelling) continue
    const kind = classifyPlanRecord(r, today)
    if (!kind) continue
    words.push({
      vocId: r.voc_id,
      spelling,
      kind,
      lastResponse: r.last_response,
    })
  }

  // 计划内没有墨墨的排期顺序，按拼写排，顺序稳定
  words.sort((a, b) => a.spelling.localeCompare(b.spelling))

  const fetched = byId.size
  const missing = total === null ? null : Math.max(0, total - fetched)
  const truncated = missing !== null && missing > 0
  let warning: string | undefined
  if (missing !== null && missing > 0) {
    warning = `计划里有 ${total} 个词，读到了 ${fetched} 个，有 ${missing} 个没读到。`
  }

  return {
    total,
    fetched,
    missing,
    truncated,
    words,
    collectedAt: new Date().toISOString(),
    warning,
  }
}

/** 拉取今天的完整快照：进度 + 词表 + 每个词的末次反馈 */
export async function collectToday(): Promise<TodaySnapshot> {
  const [progressRes, todayRes] = await Promise.all([
    getStudyProgress().catch(() => null),
    getTodayItems({ limit: 1000 }),
  ])

  const rawItems = todayRes.today_items ?? []

  // 只对真正答过题的词查末次反馈，一次批量请求即可（上限 1000）
  const studied = rawItems.filter(wasStudied)
  const needLast = studied.filter((it) => it.first_response).map((it) => it.voc_id)

  const lastMap = new Map<string, StudyResponse>()
  if (needLast.length > 0) {
    try {
      const rec = await queryStudyRecords({ voc_ids: needLast.slice(0, 1000) })
      for (const r of rec.records ?? []) {
        if (r.last_response) lastMap.set(r.voc_id, r.last_response)
      }
    } catch {
      // 末次反馈是锦上添花，失败不影响主流程
    }
  }

  const words: CollectedWord[] = []
  for (const item of studied) {
    const groups = classify(item)
    if (groups.length === 0) continue
    words.push({
      vocId: item.voc_id,
      spelling: item.voc_spelling,
      groups,
      isNew: Boolean(item.is_new),
      firstResponse: item.first_response,
      lastResponse: lastMap.get(item.voc_id),
      isFinished: Boolean(item.is_finished),
      order: item.order ?? 0,
    })
  }

  words.sort((a, b) => a.order - b.order)

  // 接口是公测，且「当日未打开 App 初始化」时不保证有数据，必须显式降级
  const progress = progressRes?.progress
  const hasProgress = Boolean(progress) && typeof progress?.finished === 'number'

  let warning: string | undefined
  if (!hasProgress) {
    warning =
      rawItems.length > 0
        ? '进度数据缺失，下面的词表仍然可用'
        : '接口没有返回今日数据。确认墨墨 App 里已开启「自动同步」，并在今天打开过它。'
  }

  return {
    date: dateKey(),
    finished: hasProgress ? progress!.finished : studied.length,
    total: hasProgress ? progress!.total : 0,
    studyTimeMs: hasProgress ? progress!.study_time : 0,
    words,
    collectedAt: new Date().toISOString(),
    warning,
    rawCount: rawItems.length,
    studiedCount: studied.length,
  }
}

/** 「初模糊 → 终认识」；首末一致或无末次反馈时返回 undefined */
export function responseNote(word: CollectedWord): string | undefined {
  const { firstResponse, lastResponse } = word
  if (!firstResponse || !lastResponse) return undefined
  if (firstResponse === lastResponse) return undefined
  return `初${RESPONSE_LABEL[firstResponse]} → 终${RESPONSE_LABEL[lastResponse]}`
}
