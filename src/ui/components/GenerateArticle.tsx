import { useEffect, useMemo, useRef, useState } from 'react'

import {
  getCoveredWordsSince,
  getCoveredWordsToday,
  markDayCoverageSkipped,
  markRangeCoverageSkipped,
} from '@/data/article'
import { getDay } from '@/data/store'
import {
  defaultSelection,
  LEVELS,
  LEVEL_LABEL,
  planCandidates,
  trimSelection,
  wordCandidates,
  KIND_LABEL,
  WORD_LIMITS,
  type ArticleLevel,
  type GenProgress,
  type WordCandidate,
  type WordKind,
} from '@/domain/article'
import { collectAllPlan, type PlanSnapshot, type TodaySnapshot } from '@/domain/collect'
import { dateKey, monthDay } from '@/lib/date'
import { readGenDraft, saveGenDraft } from '@/store/ui'

import styles from './GenerateArticle.module.css'
import BackButton from './BackButton'

/**
 * 生成文章（二级页面）。
 *
 * 和文章库同一套形态：标题行 + 内容，从阅读页推进来、返回时退回去。
 *
 * 这一页的职责是「把要用的词确认清楚」：
 * - 日期：只能选有记录的那一天，默认今天（以前是最近 7 天混在一起，会把历史词带进来）
 * - 类型：忘记 / 模糊 / 新学，可任意组合，决定默认勾选哪些词
 * - 难度与词数上限：放在词表上方，先定参数再核对词
 * - 词表：分成「将使用」和「不使用」两组，每个词都能单独点
 * - 当天已被旧文章用过的词默认不出现，顶部开关可展开并手动勾选
 */

export type GenerateRequest = {
  date: string
  words: string[]
  kinds: WordKind[]
  level: ArticleLevel
}

type Props = {
  /** 有记录的日期，倒序 */
  days: string[]
  today: string
  initialLevel: ArticleLevel
  initialLimit: number
  busy: boolean
  /** 生成阶段，busy 时用来交代「模型现在在干嘛」 */
  stage: GenProgress | null
  error: string | null
  onBack: () => void
  onGenerate: (req: GenerateRequest) => Promise<void>
  onLevelChange: (level: ArticleLevel) => void
  onLimitChange: (limit: number) => void
}

const KINDS: WordKind[] = ['forget', 'vague', 'new', 'pending', 'all']

/** 真实类型（'all' 是全选快捷方式，不是一种词） */
const REAL_KINDS: WordKind[] = ['forget', 'vague', 'new', 'pending']

/** 最近 7 天 = 今天 + 往前 6 天（「全部单词」范围的已用口径） */
function sevenDaysAgoKey(): string {
  return dateKey(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000))
}

/** 候选词是否落在勾选的类型里；'all' 匹配全部候选词 */
function matchesKinds(c: WordCandidate, kinds: WordKind[]): boolean {
  return kinds.includes('all') || c.kinds.some((k) => kinds.includes(k))
}

/**
 * 点一个类型后的下一组勾选：
 * - 点「全部单词」：开 = 只留它一个，关 = 全空（再从空里逐个挑）
 * - 点单个类型时先把 'all' 拿掉：从「全部」收窄到这个类型，
 *   否则 'all' 还在会把刚取消的那个类型又匹配回来，按钮像坏了一样
 * - 四个真实类型全勾上 = 全部，折叠成 ['all']，免得「全部」按钮该亮不亮
 */
function nextKindsAfterToggle(current: WordKind[], kind: WordKind): WordKind[] {
  if (kind === 'all') {
    return current.includes('all') ? [] : ['all']
  }
  const base = current.includes('all') ? [] : [...current]
  const next = base.includes(kind) ? base.filter((k) => k !== kind) : [...base, kind]
  return REAL_KINDS.every((k) => next.includes(k)) ? ['all'] : next
}

/**
 * 三步进度：只表示"走到哪一步"，不画百分比。
 * 每一步的真实耗时随思考量波动（20~90 秒都见过），画进度条只会骗人。
 */
const STEPS: { key: 'outline' | 'draft' | 'save'; label: string }[] = [
  { key: 'outline', label: '列提纲' },
  { key: 'draft', label: '写正文' },
  { key: 'save', label: '存文章' },
]

/** 阶段 → 一句人话 */
function stageLine(stage: GenProgress | null): string {
  if (!stage) return '正在连接模型…'
  switch (stage.stage) {
    case 'outline':
      return '在读这些词，先想清楚这篇要论证什么'
    case 'draft':
      // 并行时把「几路里好了几路」说清楚，比转圈更能解释为什么这次值得等
      return stage.total && stage.total > 1
        ? `并行写 ${stage.total} 稿（${stage.done ?? 0}/${stage.total}），写完挑最像真题的那一篇`
        : '按提纲写正文，逐句把目标词放进论证里'
    case 'revise':
      return '挑出来的那篇还差一点（篇幅 / 缺词 / 句式），正在按问题清单改'
    case 'save':
      return '写完了，正在存进文章库'
  }
}

const KIND_COLOR: Record<WordKind, string> = {
  forget: 'var(--state-forget)',
  vague: 'var(--state-vague)',
  new: 'var(--state-new)',
  pending: 'var(--state-pending)',
  // 'all' 不是真实类型，不会出现在词条的 kinds 里，这里只是凑齐类型
  all: 'var(--ink-3)',
}

export default function GenerateArticle({
  days,
  today,
  initialLevel,
  initialLimit,
  busy,
  stage,
  error,
  onBack,
  onGenerate,
  onLevelChange,
  onLimitChange,
}: Props) {
  // 上次的选词草稿：进程被系统回收后回来，不用重新挑一遍
  const [draft] = useState(readGenDraft)
  const restored = useRef(false)

  const [date, setDate] = useState(draft?.date ?? today)
  /** 选词范围：'day' = 某一天的词，'all' = 计划内全部单词 */
  const [scope, setScope] = useState<'day' | 'all'>(draft?.scope === 'all' ? 'all' : 'day')
  const [snapshot, setSnapshot] = useState<TodaySnapshot | null>(null)
  /** 「全部单词」范围的计划快照；切回「今天」再切回来不用重新拉接口 */
  const [plan, setPlan] = useState<PlanSnapshot | null>(null)
  const planRef = useRef<PlanSnapshot | null>(null)
  const [usedWords, setUsedWords] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [kinds, setKinds] = useState<WordKind[]>(() => {
    const saved = draft?.kinds.filter((k): k is WordKind => KINDS.includes(k as WordKind))
    return saved && saved.length > 0 ? saved : KINDS
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showUsed, setShowUsed] = useState(false)
  const [limit, setLimit] = useState(initialLimit)
  const [level, setLevel] = useState<ArticleLevel>(initialLevel)

  // 「清除已用记录」：两步确认 + 完成后重读数据。
  // 按天范围清当天，全部范围清最近 7 天
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearMsg, setClearMsg] = useState<string | null>(null)
  const [reloadTick, setReloadTick] = useState(0)

  /** 生成期间的秒表：只让用户知道"还在动"，不做预估 */
  const [waited, setWaited] = useState(0)
  useEffect(() => {
    if (!busy) {
      setWaited(0)
      return
    }
    const t0 = Date.now()
    const id = setInterval(() => setWaited(Math.floor((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [busy])

  const activeStep = stage?.stage === 'save' ? 2 : stage?.stage === 'outline' ? 0 : 1
  const revising = stage?.stage === 'revise'

  async function handleClearCoverage() {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    try {
      const n =
        scope === 'all'
          ? await markRangeCoverageSkipped(sevenDaysAgoKey())
          : await markDayCoverageSkipped(date)
      setClearMsg(
        n > 0
          ? `已清除 ${n} 篇文章的已用标记，单词恢复可选`
          : scope === 'all'
            ? '最近 7 天还没有需要清除的记录'
            : '今天还没有需要清除的记录',
      )
    } catch (e) {
      setClearMsg(e instanceof Error ? e.message : '清除失败，请重试')
    }
    setReloadTick((t) => t + 1)
  }

  // 换范围 / 换日期：读候选词 + 已用过的词，然后按当前类型重算默认勾选。
  // 按天读那天的快照；「全部单词」读计划内全部记录（走 planRef 缓存，切来切去不重复拉接口）
  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadError(null)

    void (async () => {
      try {
        let cands: WordCandidate[]
        if (scope === 'all') {
          let snap = planRef.current
          if (!snap) {
            snap = await collectAllPlan()
            planRef.current = snap
          }
          const covered = await getCoveredWordsSince(sevenDaysAgoKey())
          if (!alive) return
          setPlan(snap)
          setUsedWords(covered)
          cands = planCandidates(snap, covered)
        } else {
          const [snap, covered] = await Promise.all([getDay(date), getCoveredWordsToday(date)])
          if (!alive) return
          setSnapshot(snap)
          setUsedWords(covered)
          cands = wordCandidates(snap, covered)
        }

        const fallback = new Set(defaultSelection(cands, REAL_KINDS))

        // 第一次进来且有草稿：沿用草稿的勾选（只保留当前范围还在候选里的词）
        if (!restored.current && draft?.selected?.length) {
          const available = new Set(cands.map((c) => c.spelling.toLowerCase()))
          const kept = new Set(draft.selected.filter((s) => available.has(s)))
          if (kept.size > 0) {
            restored.current = true
            setSelected(kept)
            setShowUsed(false)
            setLoading(false)
            return
          }
        }

        restored.current = true
        setSelected(fallback)
        setShowUsed(false)
        setLoading(false)
      } catch {
        if (!alive) return
        setLoadError('读取单词失败，请检查网络后重试')
        setLoading(false)
      }
    })()

    return () => {
      alive = false
    }
  }, [scope, date, draft, reloadTick])

  // 勾选/类型/范围/日期一变就记一笔，被杀之后还能接着来
  useEffect(() => {
    if (loading) return
    saveGenDraft({ date, scope, kinds, selected: [...selected] })
  }, [date, scope, kinds, selected, loading])

  const allCandidates = useMemo(
    () =>
      scope === 'all'
        ? planCandidates(plan, usedWords)
        : wordCandidates(snapshot, usedWords),
    [scope, plan, snapshot, usedWords],
  )

  // 类型变了：重算应该默认勾上/取消哪些（已用手动词保留）。
  // 用「切换前后是否落在勾选类型里」来算，'all' 开关也一样：
  // 刚勾上「全部单词」→ 所有未用词都补进选择；关掉它 → 只撤掉不落在任何剩余类型里的词
  function toggleKind(kind: WordKind) {
    const nextKinds = nextKindsAfterToggle(kinds, kind)
    setKinds(nextKinds)

    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of allCandidates) {
        const key = c.spelling.toLowerCase()
        if (c.used) continue
        const was = matchesKinds(c, kinds)
        const now = matchesKinds(c, nextKinds)
        if (now && !was) next.add(key)
        else if (!now && was) next.delete(key)
      }
      return next
    })
  }

  function toggleWord(c: WordCandidate) {
    const key = c.spelling.toLowerCase()
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleUsed() {
    const next = !showUsed
    setShowUsed(next)

    // 收起「已用」时，把它们从选择里摘掉，避免出现「看不见却被用上」
    if (!next) {
      setSelected((prev) => {
        const copy = new Set(prev)
        for (const c of allCandidates) {
          if (c.used) copy.delete(c.spelling.toLowerCase())
        }
        return copy
      })
    }
  }

  const visible = showUsed ? allCandidates : allCandidates.filter((c) => !c.used)
  const chosen = visible.filter((c) => selected.has(c.spelling.toLowerCase()))
  const rest = visible.filter((c) => !selected.has(c.spelling.toLowerCase()))
  const overLimit = chosen.length > limit

  async function handleGenerate() {
    const words = trimSelection(allCandidates, selected, limit)
    if (words.length === 0) return
    // 「全部单词」范围的文章就是今天生成的，日期记今天；kinds 照常传
    await onGenerate({ date: scope === 'all' ? today : date, words, kinds, level })
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <BackButton onClick={onBack} />
        <h1 className={styles.title}>生成文章</h1>
        <span className={styles.count}>已选 {chosen.length}</span>
      </header>

      <section className={styles.field}>
        <h2 className={styles.fieldLabel}>哪一天</h2>
        <div className={styles.days}>
          <button
            type="button"
            className={styles.day}
            data-on={scope === 'all'}
            onClick={() => setScope('all')}
          >
            全部单词
          </button>
          {days.map((d) => (
            <button
              key={d}
              type="button"
              className={styles.day}
              data-on={scope === 'day' && d === date}
              onClick={() => {
                setScope('day')
                setDate(d)
              }}
            >
              {d === today ? '今天' : monthDay(d)}
            </button>
          ))}
          {days.length === 0 && <p className={styles.hint}>还没有学习记录</p>}
        </div>
        {scope === 'all' && (
          <p className={styles.hint}>
            计划内全部单词：墨墨接口不提供整本单词书，只能读到已加入学习计划的词。
            {plan?.warning ? ` ${plan.warning}` : ''}
          </p>
        )}
      </section>

      <section className={styles.field}>
        <h2 className={styles.fieldLabel}>词的类型</h2>
        <div className={styles.kinds}>
          {KINDS.map((k) => {
            // 'all' 匹配全部候选词（全选快捷方式）；其余按真实类型算
            const match = (c: WordCandidate) => (k === 'all' ? true : c.kinds.includes(k))
            const total = allCandidates.filter(match).length
            const unused = allCandidates.filter((c) => match(c) && !c.used).length
            // 展示口径跟着开关走：打开「包含已用」→ 全量数；
            // 关着但还有词被藏起来 → 「未用/总数」，别让人以为词丢了
            const shown = showUsed || total === unused ? total : `${unused}/${total}`
            return (
              <button
                key={k}
                type="button"
                className={styles.kind}
                data-on={kinds.includes(k)}
                onClick={() => toggleKind(k)}
              >
                <span className={styles.tick} aria-hidden="true" />
                {KIND_LABEL[k]}
                <span className={styles.kindCount}>{shown}</span>
              </button>
            )
          })}
        </div>
        <p className={styles.hint}>
          勾选决定默认用哪些词，下面还可以逐词调整。斜杠后是含已用词的总数；已用过的默认不出现，打开下面的开关再练。
          {scope === 'day' ? '待学只在「全部单词」范围里有词。' : ''}
        </p>
      </section>

      {usedWords.size > 0 && (
        <label className={styles.switchRow}>
          <span className={styles.switchText}>
            {scope === 'all' ? '包含最近 7 天已经用过的词' : '包含这天已经用过的词'}
            <em>共 {usedWords.size} 个，打开后可以手动勾选，再练一次</em>
          </span>
          <input type="checkbox" className={styles.switch} checked={showUsed} onChange={toggleUsed} />
        </label>
      )}

      {usedWords.size > 0 && (
        <div className={styles.clearRow}>
          <button
            type="button"
            className={confirmClear ? styles.clearBtn : styles.clearBtnGhost}
            onClick={() => void handleClearCoverage()}
            disabled={loading}
          >
            {confirmClear
              ? '确认清除？（单词会恢复默认可选）'
              : scope === 'all'
                ? '清除最近 7 天已生成文章的记录'
                : '清除今天已生成文章的记录'}
          </button>
          {clearMsg && <p className={styles.hint}>{clearMsg}</p>}
        </div>
      )}

      <section className={styles.field}>
        <h2 className={styles.fieldLabel}>难度</h2>
        <div className={styles.segments}>
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              className={styles.segment}
              data-on={level === l}
              onClick={() => {
                setLevel(l)
                onLevelChange(l)
              }}
            >
              {LEVEL_LABEL[l]}
            </button>
          ))}
        </div>
        {/* 说明写在难度下面而不是弹窗里：调难度的人一定会看到 */}
        <p className={styles.hint}>
          尽管生成文的结构已尽量参照真题数据（篇幅、句长、文体分布），但这个功能仅适合用来巩固单词、练习长难句分析，不建议当作真题替代品使用。
        </p>
      </section>

      <section className={styles.field}>
        <h2 className={styles.fieldLabel}>词数上限</h2>
        <div className={styles.segments}>
          {WORD_LIMITS.map((n) => (
            <button
              key={n}
              type="button"
              className={styles.segment}
              data-on={limit === n}
              onClick={() => {
                setLimit(n)
                onLimitChange(n)
              }}
            >
              {n}
            </button>
          ))}
        </div>
        {overLimit && (
          <p className={styles.warn}>
            选了 {chosen.length} 个，超过上限 {limit}。按「忘记 → 模糊 → 新学 → 待学」的顺序取前 {limit} 个。
          </p>
        )}
        {/* 词密度是真问题：340 词塞 15 个生僻词，平均每 22 词一个，比真题密得多，容易写成硬凑 */}
        <p className={styles.hint}>
          选得越多，文章越容易为了塞词而生硬。一篇文章里 10~15 个词已经偏密了。
        </p>
      </section>

      {loading && (
        <p className={`${styles.hint} loading-pulse`}>
          {scope === 'all' ? '正在读取计划里的单词…' : '正在读取这天的单词…'}
        </p>
      )}

      {loadError && <p className={styles.error}>{loadError}</p>}

      {!loading && visible.length === 0 && (
        <p className={styles.hint}>
          {scope === 'all'
            ? usedWords.size > 0
              ? '计划里的词最近 7 天都用过了。打开上面的开关，可以挑几个再写一篇。'
              : '计划里没有符合条件的词。去墨墨多背几个，或者把词加进学习计划。'
            : usedWords.size > 0
              ? '这天的词都用过了。打开上面的开关，可以挑几个再写一篇。'
              : '这天没有符合条件的新学 / 模糊 / 忘记的词。换一天，或者去墨墨多背几个。'}
        </p>
      )}

      {!loading && chosen.length > 0 && (
        <section className={styles.group}>
          <h2 className={styles.groupHead}>
            将使用 <span className={styles.groupCount}>{chosen.length}</span>
          </h2>
          <ul>
            {chosen.map((c) => (
              <li key={c.spelling}>
                <button type="button" className={styles.word} data-on="true" onClick={() => toggleWord(c)}>
                  <span className={styles.marks}>
                    {c.kinds.map((k) => (
                      <span key={k} className={styles.mark} style={{ background: KIND_COLOR[k] }} />
                    ))}
                  </span>
                  <span className={styles.spelling}>{c.spelling}</span>
                  {c.used && <span className={styles.used}>已用</span>}
                  <span className={styles.kindsText}>
                    {c.kinds.map((k) => KIND_LABEL[k]).join(' / ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!loading && rest.length > 0 && (
        <section className={styles.group}>
          <h2 className={styles.groupHead}>
            不使用 <span className={styles.groupCount}>{rest.length}</span>
          </h2>
          <ul>
            {rest.map((c) => (
              <li key={c.spelling}>
                <button type="button" className={styles.word} data-on="false" onClick={() => toggleWord(c)}>
                  <span className={styles.marks}>
                    {c.kinds.map((k) => (
                      <span key={k} className={styles.mark} style={{ background: KIND_COLOR[k] }} />
                    ))}
                  </span>
                  <span className={styles.spelling}>{c.spelling}</span>
                  {c.used && <span className={styles.used}>已用</span>}
                  <span className={styles.kindsText}>
                    {c.kinds.map((k) => KIND_LABEL[k]).join(' / ')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p className={styles.error}>{error}</p>}

      <button
        type="button"
        className={styles.primary}
        onClick={() => void handleGenerate()}
        disabled={busy || chosen.length === 0 || loading}
      >
        {busy ? '生成中…' : `用 ${Math.min(chosen.length, limit)} 个词生成`}
      </button>

      {busy && (
        <div className={styles.progress} role="status" aria-live="polite">
          <div className={styles.steps}>
            {STEPS.map((s, i) => (
              <span
                key={s.key}
                className={styles.step}
                data-on={i === activeStep}
                data-done={i < activeStep}
              >
                <span className={styles.dot} aria-hidden="true" />
                {revising && i === 1 ? '重写正文' : s.label}
              </span>
            ))}
          </div>
          <p className={styles.progressLine}>
            {stageLine(stage)}
            <span className={styles.waited}> · 已等 {waited} 秒</span>
          </p>
        </div>
      )}
    </div>
  )
}
