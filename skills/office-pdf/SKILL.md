---
name: office-pdf
description: "当用户要合并/拆分 PDF 或加水印时使用；PDF 内容摘要/问答直接用内置 parse_document 工具，不要调本脚本"
tags:
  - office
  - pdf
  - document
priority: normal
---

# PDF 处理（合并 / 拆分 / 加水印）

对已有 PDF 文件做三类处理：把多个 PDF 按顺序合并成一个、从一个 PDF 抽取指定页组成新文件、给每一页加半透明对角线平铺文字水印。脚本为预打包单文件，只需 bun，离线可用，无需安装任何依赖。

> 摘要/问答场景不要用本技能：用户要「总结这个 PDF」「PDF 里写了什么」时，直接用内置 parse_document 工具解析内容，不要调本脚本。

## 调用命令

```bash
bun skills/office-pdf/scripts/pdf.mjs --mode <merge|split|watermark> ...
```

### merge — 合并多个 PDF

```bash
bun skills/office-pdf/scripts/pdf.mjs --mode merge --input "D:\docs\a.pdf,D:\docs\b.pdf" --out "D:\docs\merged.pdf"
```

- `--input`：至少 2 个 PDF 路径，英文逗号分隔，按书写顺序合并全部页。
- `--out`：输出文件路径（必须是新路径）。

### split — 抽取指定页

```bash
bun skills/office-pdf/scripts/pdf.mjs --mode split --input "D:\docs\a.pdf" --pages 1-3,5 --out "D:\docs\part.pdf"
```

- `--input`：单个 PDF 路径。
- `--pages`：页码从 1 开始，支持单页（`5`）、区间（`1-3`）与逗号组合（`1-3,5`）；页码越界会报可读错误并提示该 PDF 的总页数。
- `--out`：输出文件路径（必须是新路径）。

### watermark — 加文字水印

```bash
bun skills/office-pdf/scripts/pdf.mjs --mode watermark --input "D:\docs\a.pdf" --text "CONFIDENTIAL" --out "D:\docs\marked.pdf" --opacity 0.15
```

- `--input`：单个 PDF 路径。
- `--text`：水印文本，每页以 45° 对角线半透明平铺。
- `--opacity`：可选，(0, 1] 之间，默认 `0.15`。
- `--out`：输出文件路径（必须是新路径）。

**水印文本限制（重要）**：脚本使用 PDF 内置标准字体（WinAnsi 编码），**不支持中文等 CJK 字符**。水印文本请使用英文/数字（如 `CONFIDENTIAL`、`DRAFT`、`INTERNAL USE ONLY`）。若文本含中文，脚本会报错退出：「水印文本包含内置标准字体不支持的字符…请改用英文或数字水印文本」。用户要求中文水印时，先向用户说明该限制并建议等价英文文本。

## 输出契约

- 成功：stdout 输出单行 JSON，退出码 0：

```json
{"ok":true,"out":"D:\\docs\\merged.pdf","pages":5}
```

  `out` 为输出文件绝对路径，`pages` 为输出文件页数。

- 失败：stderr 输出人类可读原因，stdout 输出 `{"ok":false,"error":"..."}`，退出码 1。
- 脚本零网络、零交互：参数不全直接报错退出，不会等待输入。

## 红线

- **不覆盖原文件**：`--out` 与任何输入文件相同会直接报错；输出必须是新路径。
- `--out` 指向已存在的其他文件时也会报错，确需覆盖必须显式加 `--overwrite`。
- 处理加密 PDF 会报错，请先解除密码保护。

## 常见错误与处理

| 错误信息（stderr） | 原因与处理 |
| --- | --- |
| `merge 模式至少需要 2 个输入文件…` | `--input` 只给了 1 个路径；补齐至少 2 个，逗号分隔 |
| `--pages 中的「9」超出范围：该 PDF 共 N 页…` | 页码越界；按提示的总页数改 `--pages` |
| `水印文本包含内置标准字体不支持的字符…` | 水印含中文等 CJK 字符；改用英文/数字文本 |
| `--out 不能与输入文件相同…` | 输出路径撞了输入文件；换一个新路径 |
| `输出文件已存在…` | 目标文件已存在；换新路径或显式 `--overwrite` |
| `输入文件已加密，无法处理…` | PDF 有密码；先解除保护再试 |
