// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
export const OFFICIAL_WEBSITE_URL = 'https://XiaoJuClaw.dev'
export const OFFICIAL_DOCS_BASE_URL = `${OFFICIAL_WEBSITE_URL}/docs`

export function getOfficialDocsUrl(slug: string): string {
  const normalizedSlug = slug.replace(/^\/+/, '')
  return `${OFFICIAL_DOCS_BASE_URL}/${normalizedSlug}`
}
