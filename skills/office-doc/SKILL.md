---
name: office-doc
description: "Generate .docx Word documents from a JSON spec. 当用户要生成 Word 文档/报告/方案/合同框架时使用（关键词：Word、docx、报告、方案、总结、合同、document、report、proposal）。NOT for reading or extracting text from existing Word files, and NOT for PPT/Excel/PDF generation."
tags:
  - office
  - word
  - document
priority: normal
---

# Word 文档生成（office-doc）

将结构化 JSON（doc.json）渲染为带封面、目录、页眉页脚的 .docx Word 文档。脚本为预打包单文件，离线运行、零依赖（只需 bun）。

## 工作流

1. **确认大纲（红线）**：内容较长（超过 5 个章节或用户需求含糊）时，先向用户列出章节大纲（标题 + 每章要点），确认后再生成；短文档可直接生成。
2. **产出 doc.json**：按下方 schema 把内容写成 spec 文件（存到临时目录或用户指定位置）。
3. **执行脚本**：

```bash
bun scripts/render.mjs --spec <doc.json路径> --out <输出.docx路径>
```

4. **返回产物路径**：解析 stdout 的单行 JSON，把 `out` 字段（绝对路径）告知用户。若 spec 里 `toc: true`，同时提醒用户：**目录页码需在 Word 中打开后按 F9（或右键目录→更新域）刷新**，这是 Word 目录域的正常机制。

## 输出格式（CLI 契约）

- **成功**：stdout 单行 JSON，退出码 0：

```json
{"ok":true,"out":"D:\\path\\to\\output.docx","sections":6}
```

- **失败**：stderr 输出人类可读原因，stdout 输出 `{"ok":false,"error":"..."}`，退出码 1。
- 输出文件已存在时默认报错；确需覆盖时追加 `--overwrite` 参数。
- 脚本零网络、零交互，参数不全直接报错退出。

## doc.json schema

```json
{
  "title": "文档标题（必填）",
  "style": "report | proposal | plain（可选，默认 report）",
  "toc": true,
  "author": "作者/署名（可选）",
  "date": "日期字符串（可选，默认当天）",
  "sections": [
    {
      "heading": "章节标题（必填）",
      "level": 1,
      "paragraphs": ["正文段落，一项一段"],
      "bullets": ["无序列表项"],
      "table": {
        "headers": ["列名1", "列名2"],
        "rows": [["单元格", "单元格"]]
      }
    }
  ]
}
```

字段说明：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | 是 | 文档标题；出现在封面、页眉与文档属性中 |
| `style` | 否 | `report` 正式黑蓝（深蓝标题、正文首行缩进）；`proposal` 品牌橘 `#f97316` 标题；`plain` 极简黑白、无封面页。默认 `report` |
| `toc` | 否 | `true` 时在正文前插入目录域（Word 打开后按 F9 更新页码） |
| `author` | 否 | 出现在封面与文档属性 |
| `date` | 否 | 封面日期，缺省用当天（如 `2026年7月7日`） |
| `sections` | 是 | 章节数组，至少 1 个 |
| `sections[].heading` | 是 | 章节标题文本 |
| `sections[].level` | 否 | 1-3，对应 Word 的 Heading1-3，默认 1；**超出 1-3 会报错** |
| `sections[].paragraphs` | 否 | 段落文本数组 |
| `sections[].bullets` | 否 | 无序列表项数组 |
| `sections[].table` | 否 | 一个表格：`headers` 非空字符串数组 + `rows` 二维数组 |

排版约定（无需在 spec 中指定）：中文字体统一 Microsoft YaHei；页眉显示文档标题、页脚显示"第 X 页 / 共 Y 页"；封面含 title/author/date（`plain` 风格不出封面页，标题置于正文顶部）。

## 最小示例

```json
{
  "title": "周报",
  "style": "plain",
  "sections": [
    { "heading": "本周进展", "paragraphs": ["完成技能包联调。"], "bullets": ["office-doc 上线"] }
  ]
}
```

完整中文示例见 `examples/doc.sample.json`（含封面、目录、多级标题、列表与表格）。

## 常见错误与处理

| 现象 | 原因与处理 |
| --- | --- |
| `title 为必填字段` / `sections 为必填字段` | spec 缺少必填字段，补全后重试 |
| `sections[i].level 必须是 1-3 的整数` | level 超界，改为 1/2/3 |
| `spec 文件不是合法 JSON` | doc.json 语法错误，检查逗号/引号/转义 |
| `输出文件已存在` | 换输出路径，或确认可覆盖后追加 `--overwrite` |
| 目录显示"未找到目录项"或页码为空 | 属正常：在 Word 中按 F9 或右键目录→更新域即可 |

## 红线

- 长文档（>5 章节）或需求含糊时，先与用户确认大纲再生成，避免大段返工。
- 不要用本技能读取/解析已有 Word 文件；不要生成 PPT/Excel/PDF（各有对应技能）。
- 输出路径必须尊重用户指定位置；覆盖已有文件前需用户确认。
