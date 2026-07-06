// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
// 官网与文档统一指向自有站点 /site/（MVP 无 /docs/* 路径，避免落到管理后台）
export const OFFICIAL_WEBSITE_URL = 'https://www.xiaojuclaw.top/site/'
export const OFFICIAL_DOCS_BASE_URL = 'https://www.xiaojuclaw.top/site/tutorials.html'

export function getOfficialDocsUrl(slug: string): string {
  const normalizedSlug = slug.replace(/^\/+/, '')
  return `${OFFICIAL_DOCS_BASE_URL}#${normalizedSlug}`
}
