// [XJC] 对话式技能安装的可信源策略（供 src/agent/skills-mcp.ts 使用）。
// 与 web 端 registry-source.ts 的可见性口径一致：自有 xiaojuclaw 源永远可用，
// 第三方源默认隐藏、仅在配置放开后可选；recommended 榜单不可直接下载，
// 按 web 端 resolveMarketplaceActionSource 的中文环境映射落到 tencent。
// 注：本文件位于 src/skills/ 下（brand-audit 对技能市场源实现文件放行源 id）。
import type { RegistrySelectableSource } from './registry.ts'

/** 可直接下载安装的技能市场源 id（recommended 榜单不可直下） */
export type MarketplaceInstallSource = Exclude<RegistrySelectableSource, 'recommended'>

/** 面向用户/模型的中文源名（内部 id 括注，便于模型继续引用） */
export const INSTALL_SOURCE_LABELS: Record<MarketplaceInstallSource, string> = {
  xiaojuclaw: '小橘技能库',
  tencent: '腾讯技能市场（tencent）',
  clawhub: '第三方技能源（clawhub）',
}

export type ResolvedInstallSource =
  | { ok: true; source: MarketplaceInstallSource }
  | { ok: false; error: string }

/**
 * 解析并校验安装源：只放行「可见/可信」源。
 * - 默认与首选：xiaojuclaw（自有源，永远可用）
 * - recommended：映射到 tencent 下载（仍受第三方开关约束）
 * - clawhub / tencent：第三方源，默认隐藏，仅在远程配置放开后可用
 */
export function resolveInstallSource(
  requested: string | undefined,
  thirdPartyEnabled: boolean,
): ResolvedInstallSource {
  const normalized = (requested ?? '').trim().toLowerCase() || 'xiaojuclaw'
  const mapped = normalized === 'recommended' ? 'tencent' : normalized

  if (mapped === 'xiaojuclaw') {
    return { ok: true, source: 'xiaojuclaw' }
  }
  if (mapped === 'clawhub' || mapped === 'tencent') {
    if (!thirdPartyEnabled) {
      return {
        ok: false,
        error: `第三方技能源（${normalized}）当前未开放，仅可从小橘技能库（source: xiaojuclaw）安装`,
      }
    }
    return { ok: true, source: mapped }
  }
  return { ok: false, error: `未知或不受信任的技能源：${normalized}` }
}
