---
name: file-organizer
description: "Organize messy folders: group loose files into subfolders by type (文档/表格/图片/演示…) or by month. Use when the user asks to 整理文件夹 / 归类文件 / clean up a directory. ALWAYS dry-run first and show the plan; only apply after explicit user confirmation."
tags:
  - office
  - files
  - automation
priority: normal
---

# 文件整理（file-organizer）

把一个目录第一层的散落文件按规则归入子目录。**只移动、永不删除、重名自动加序号不覆盖。**

## 命令

```bash
# 第 1 步：dry-run（默认），输出移动计划 JSON，不动任何文件
bun <本技能目录>/scripts/organize.mjs --dir "D:\Users\me\Desktop\待整理" --rule bytype

# 第 2 步：用户确认计划后，才允许加 --apply 真正执行
bun <本技能目录>/scripts/organize.mjs --dir "D:\Users\me\Desktop\待整理" --rule bytype --apply
```

- `--rule bytype`：按类型分组（文档/表格/演示/图片/音视频/压缩包/程序/其他）
- `--rule bydate`：按修改月份分组（如 `2026-07/`）
- 成功输出单行 JSON：dry-run 为 `{ok,dryRun:true,count,moves[]}`；apply 为 `{ok,dryRun:false,moved,report}`
- apply 后在目录内生成 `整理报告.md`（分类清单 + 撤销说明）

## 工作流（必须严格遵守）

1. 先 dry-run，把 moves 计划整理成人类可读的分组清单展示给用户（多少个文件、分到哪些目录）。
2. **明确询问用户"确认执行吗"，得到肯定答复后才允许带 --apply 执行**。用户未确认前绝不执行。
3. apply 完成后告知移动数量与报告路径。

## 安全边界（脚本内置，不可绕过）

- 拒绝整理：磁盘根目录、用户主目录本身、Windows/Program Files 系统目录、U 盘工具目录
- 只处理目录第一层文件；子目录与隐藏文件不动
- 没有任何删除操作；撤销 = 把文件从分类子目录移回
