/**
 * External tool download URLs — derived from app.config.ts
 */

import appConfig from '../../app.config.ts'

export const CDN_BASE = appConfig.toolsCdnBase

// Bun runtime (self-hosted domain only — no GitHub fallback)
export const BUN_VERSION = appConfig.tools.bun.version
export const BUN_CDN_BASE = `${CDN_BASE}/bun`

// Git for Windows (self-hosted domain only)
export const GIT_VERSION = appConfig.tools.git.version
export const GIT_CDN_URL = `${CDN_BASE}/git/${appConfig.tools.git.windowsFileName}`

// uv (Python package manager, self-hosted domain only)
export const UV_VERSION = appConfig.tools.uv.version
export const UV_CDN_BASE = `${CDN_BASE}/uv`
