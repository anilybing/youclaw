# xiaojuclaw-skills-dev

这是 XiaoJuClaw 内置办公技能（office-ppt / office-doc / office-excel / office-pdf）的开发工作区，存放技能脚本源码与测试，本目录不进入 Tauri 打包资源、不随应用发布。
构建方式：在本目录执行 `bun install`，然后 `bun run build:all`（或单个构建如 `bun run build:office-ppt`），提交前先跑 `bun test`。
构建产物为零依赖单文件 `.mjs`，输出到 `../skills/<slug>/scripts/`，随 Tauri 资源打包发布（需连同该技能的 SKILL.md 一起提交）。
