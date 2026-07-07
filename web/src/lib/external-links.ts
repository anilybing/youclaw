// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
// 官网与文档统一走 app.config.ts 单一来源（/site/ 官网，禁止指向管理后台）
import appConfig from '../../../app.config.ts'

export const OFFICIAL_WEBSITE_URL = appConfig.siteBase
export const OFFICIAL_DOCS_BASE_URL = appConfig.docsBase

export function getOfficialDocsUrl(slug: string): string {
  const normalizedSlug = slug.replace(/^\/+/, '')
  return `${OFFICIAL_DOCS_BASE_URL}#${normalizedSlug}`
}
