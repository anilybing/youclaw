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
  websiteUrl: 'https://xiaoju.ncqianxi.cn',
  siteBase: 'https://xiaoju.ncqianxi.cn/site/',
  docsBase: 'https://xiaoju.ncqianxi.cn/site/tutorials.html',

  // ── Server Defaults ──
  defaultPort: 62601,
  defaultDataDir: './data',
  defaultModel: 'minimax/MiniMax-M2.7-highspeed',
  defaultLogLevel: 'info' as const,

  // ── CDN ──  工具与安装包镜像（自建域名托管，不依赖外网/GitHub，国内可直连）
  cdnBase: 'https://xiaoju.ncqianxi.cn/downloads',
  toolsCdnBase: 'https://xiaoju.ncqianxi.cn/downloads/tools',

  // ── External Tool Downloads ──
  // 工具全部由自建域名托管（见 toolsCdnBase）；不保留任何 GitHub/外网下载地址，
  // 国内用户直连服务器域名即可，无外网兜底。
  tools: {
    bun: {
      version: '1.2.15',
    },
    git: {
      version: '2.53.0.2',
      windowsFileName: 'Git-2.53.0.2-64-bit.exe.zip',
    },
    uv: {
      version: '0.7.12',
    },
  },
} as const

export default appConfig
