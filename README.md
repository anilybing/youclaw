# XiaoJuClaw 桌面端

XiaoJuClaw（小橘 Claw）是面向"不懂技术但需要 AI"人群的开箱即用 AI 工作助手：
U 盘交付、插上即用、内置数字员工（PPT / Word / Excel / PDF 等办公自动化技能），
配合 MVP 云端完成账号、激活码、积分与运营管理。

> 本项目基于开源项目 [YouClaw](https://github.com/OtterMind/youclaw)（MIT License）二次开发，
> 在其多 Agent 运行时、技能系统与 Tauri 桌面壳之上增加了商业化隔离层与便携交付能力。
> 感谢上游社区的工作。

## 技术栈

Bun + TypeScript + Hono（Sidecar）· Vite + React + shadcn/ui（前端）· Tauri 2（桌面壳）

## 常用命令

```bash
bun install && cd web && bun install && cd ..

bun dev              # Sidecar 后端（默认 62601）
bun dev:web          # 前端开发服（5173）
bun dev:tauri        # 桌面模式

bun run typecheck    # 根 TS 检查（web 目录内同名命令检查前端）
bun test '.test.'    # 后端单测
bun run brand-audit  # 品牌与外链审计（发布门禁）

bun run build:tauri  # 正式打包（需 updater 签名，见 doc/发布操作手册.md）
build-release.bat    # 一键发布流水线
```

## 目录速览

```text
src/            Sidecar：Agent 运行时、技能、渠道、商业化隔离层（routes/commercial*）
web/src/        前端：聊天、模板中心、激活与设备、个人中心、（工作台开发中）
skills/         内置技能（SKILL.md + 预打包脚本，随安装包分发）
skills-dev/     技能源码工作区（bun build 产出单文件脚本，不随包分发）
agents/         预置数字员工模板
scripts/        构建、制盘（make-usb-payload.ps1）、审计（brand-audit.ts）
```

## 配套文档（MVPClawToC 仓库）

- `doc/AI执行任务书.md` — 开发任务与进度
- `doc/上游同步SOP.md` — 上游版本同步流程
- `doc/技能包开发规范.md` — 内置技能开发规范
- `doc/U盘制盘指引.md` / `doc/发布操作手册.md` — 交付与发布

## License

MIT（沿用上游许可证，见 `LICENSE`）。
