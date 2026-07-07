// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
/**
 * XiaoJuClaw Application Configuration
 *
 * Single source of truth for all app-level constants.
 * Both backend (src/) and frontend (web/src/) import from this file.
 */

const appConfig = {
  // ── App Info ──
  name: 'XiaoJuClaw',
  identifier: 'com.xiaojuclaw.app',
  github: 'https://github.com/anilybing/youclaw',
  supportEmail: 'support@xiaojuclaw.top',

  // ── Website（官网 /site/ 与文档教程页，禁止指向管理后台）──
  websiteUrl: 'https://www.xiaojuclaw.top',
  siteBase: 'https://www.xiaojuclaw.top/site/',
  docsBase: 'https://www.xiaojuclaw.top/site/tutorials.html',

  // ── Server Defaults ──
  defaultPort: 62601,
  defaultDataDir: './data',
  defaultModel: 'minimax/MiniMax-M2.7-highspeed',
  defaultLogLevel: 'info' as const,

  // ── CDN ──  工具与安装包镜像（人类采购 CDN 后只改这两行）
  cdnBase: 'https://cdn.xiaojuclaw.top/xiaojuclaw',
  toolsCdnBase: 'https://cdn.xiaojuclaw.top/xiaojuclaw/tools',

  // ── External Tool Downloads ──
  tools: {
    bun: {
      version: '1.2.15',
      githubReleaseBase: 'https://github.com/oven-sh/bun/releases/download',
    },
    git: {
      version: '2.53.0.2',
      windowsFileName: 'Git-2.53.0.2-64-bit.exe.zip',
    },
    uv: {
      version: '0.7.12',
      githubReleaseBase: 'https://github.com/astral-sh/uv/releases/download',
    },
  },
} as const

export default appConfig
