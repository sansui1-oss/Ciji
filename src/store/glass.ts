import { Preferences } from '@capacitor/preferences'
import { create } from 'zustand'

/**
 * 液态玻璃（默认开）+ 玻璃不透明度滑杆。
 *
 * 开着时整个界面走玻璃：底栏是悬浮胶囊，吸顶的顶栏、答题条、弹窗、
 * 主要按钮也都变成磨砂玻璃面，内容从下面滚过透出模糊的质感。
 * 各处的 data-glass 分支见 TabBar.module.css 与各页面的 CSS module。
 *
 * 没存过偏好的用户默认开；存过「关」的用户保持关，不强制覆盖。
 * 不透明度走 CSS 变量 --glass-alpha（tokens.css 里按主题给了默认值），
 * 滑杆把覆盖值挂在 <html> 的内联样式上——改一个变量，两层主题都生效。
 * 滑杆只管底栏 / 顶栏的填充，卡片、弹窗、按钮是不透明度固定的玻璃面。
 */

const K_GLASS = 'liquid_glass'
const K_ALPHA = 'glass_alpha'

/** 滑杆范围与默认值（0.55 ≈ tokens.css 里浅色主题的默认） */
export const GLASS_ALPHA_MIN = 0
export const GLASS_ALPHA_MAX = 1
export const GLASS_ALPHA_DEFAULT = 0.55

type GlassState = {
  glass: boolean
  alpha: number
  load: () => Promise<void>
  setGlass: (on: boolean) => Promise<void>
  setAlpha: (v: number) => Promise<void>
}

function applyAlpha(alpha: number): void {
  document.documentElement.style.setProperty('--glass-alpha', alpha.toFixed(2))
}

export const useGlass = create<GlassState>((set) => ({
  // 首帧先按默认开画，load() 读完本地偏好再纠正（存过「关」的会关掉）
  glass: true,
  alpha: GLASS_ALPHA_DEFAULT,

  load: async () => {
    const [{ value }, { value: rawAlpha }] = await Promise.all([
      Preferences.get({ key: K_GLASS }),
      Preferences.get({ key: K_ALPHA }),
    ])
    // value === null 是从来没存过：默认开；'1' 开、'0' 关
    const glass = value === null ? true : value === '1'
    const alpha = Number(rawAlpha)
    if (Number.isFinite(alpha) && alpha >= GLASS_ALPHA_MIN && alpha <= GLASS_ALPHA_MAX) {
      applyAlpha(alpha)
      set({ glass, alpha })
    } else {
      set({ glass })
    }
  },

  setGlass: async (on) => {
    // 先生效再落盘：开关要即时
    set({ glass: on })
    await Preferences.set({ key: K_GLASS, value: on ? '1' : '0' })
  },

  setAlpha: async (v) => {
    const alpha = Math.min(GLASS_ALPHA_MAX, Math.max(GLASS_ALPHA_MIN, v))
    applyAlpha(alpha)
    set({ alpha })
    await Preferences.set({ key: K_ALPHA, value: alpha.toFixed(2) })
  },
}))
