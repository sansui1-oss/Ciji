import { getStudyProgress, getTodayItems, queryStudyRecords } from '@/api/study'
import type { StudyRecord, StudyResponse } from '@/api/types'

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
  /** 实际拉到的记录数 */
  fetched: number
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

/**
 * 拉取学习计划里的全部单词。
 *
 * 只能做到「已加入学习计划的全部单词」：墨墨开放 API 没有「整本单词书」接口，
 * 书里还没加进计划的词接口根本不给 —— 界面必须把这句写清楚，不许写成「单词书全部」。
 *
 * 先拿总数再拉记录：总数超过 1000 时接口一次给不完，warning 里写明只读到了前 1000 个，
 * 不要假装拿到了全部。总数拿不到时不挡主流程，只是不报截断。
 */
export async function collectAllPlan(): Promise<PlanSnapshot> {
  const today = dateKey()

  const countRes = await queryStudyRecords({ as_count: true }).catch(() => null)
  const total =
    countRes && typeof countRes.count === 'number' ? countRes.count : null

  const recRes = await queryStudyRecords({ limit: PLAN_FETCH_LIMIT })
  const records = recRes.records ?? []

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

  const truncated = total !== null && total > records.length
  let warning: string | undefined
  if (total !== null && total > PLAN_FETCH_LIMIT) {
    warning = `计划里有 ${total} 个词，接口一次最多返回 1000 个，只能读到前 1000 个。`
  } else if (total !== null && records.length < total) {
    warning = `计划里有 ${total} 个词，这次只读到了 ${records.length} 个。`
  }

  return {
    total,
    fetched: records.length,
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
