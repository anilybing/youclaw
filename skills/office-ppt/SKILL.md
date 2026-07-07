---
name: office-ppt
description: "从结构化大纲 JSON 生成可打开的 .pptx 演示文稿。当用户要生成/制作 PPT、演示文稿、幻灯片、slide deck、PowerPoint 时使用。NOT for 读取/解析已有 PPT 文件内容。"
tags:
  - office
  - ppt
  - document
priority: normal
---

# office-ppt：大纲 JSON 一键生成 PPT

把符合 deck.json 契约的结构化大纲渲染为 16:9 的 .pptx（中文字体 Microsoft YaHei），内置 business / minimal / orange 三套主题。

## 工作流（Agent 按此顺序执行）

1. **先产出大纲**：根据用户需求写一份符合下方 schema 的 deck.json，保存到工作区临时文件（如 `<工作区>/deck.json`）。内容**不足 8 页时先与用户确认大纲**再渲染。
2. **执行渲染脚本**（脚本路径相对本技能目录）：

```bash
bun <本技能目录>/scripts/render.mjs --spec <工作区>/deck.json --out <工作区>/演示文稿.pptx
```

3. **回报结果**：成功后把 stdout JSON 里的 `out` 绝对路径告诉用户。

可选参数：

- `--theme business|minimal|orange`：覆盖 deck.json 里的 theme
- `--overwrite`：输出文件已存在时允许覆盖（默认报错，防止误覆盖）

## 输出契约

- 成功：stdout 单行 JSON `{"ok":true,"out":"<绝对路径>","slides":N}`，退出码 0
- 失败：stderr 打印人类可读原因（缺哪个字段会写清楚），stdout `{"ok":false,"error":"..."}`，退出码 1
- 脚本零网络、零交互、零额外依赖（只需 bun）

## deck.json 完整 schema

```json
{
  "title": "string 必填（封面主标题，也用于页脚）",
  "subtitle": "string 可选（封面副标题）",
  "author": "string 可选（封面署名）",
  "theme": "business | minimal | orange（可选，默认 business）",
  "slides": [
    {
      "type": "cover | toc | section | content | two-column | table | end",
      "title": "string（section/content/two-column/table 必填）",
      "bullets": ["string 数组（content 必填；toc/section/end 可选）"],
      "left": ["string 数组（two-column 必填）"],
      "right": ["string 数组（two-column 必填）"],
      "table": { "headers": ["列名"], "rows": [["单元格"]] },
      "notes": "string 可选（演讲者备注，任何版式都支持）"
    }
  ]
}
```

七种版式说明：

| type | 用途 | 字段要求 |
| --- | --- | --- |
| `cover` | 封面：大标题居中，取 deck 的 title/subtitle/author | 无必填字段 |
| `toc` | 目录：不给 bullets 时自动取各 section 标题（无 section 则取内容页标题） | 可选 bullets |
| `section` | 章节页：自动编号 01/02…，可加 bullets 做章节摘要 | title 必填 |
| `content` | 内容页：标题条 + 项目符号列表 | title 必填，bullets 建议 3-6 条 |
| `two-column` | 双栏对比：左右各一列项目符号 | title/left/right 必填 |
| `table` | 表格页：自动列宽、表头填充色、隔行变色 | title/table 必填 |
| `end` | 致谢页：固定版式，title 默认"谢谢观看" | 无必填字段 |

除封面外每页自动加页脚（左侧 deck 标题、右侧页码）。

## 最小示例

```json
{
  "title": "季度汇报",
  "theme": "minimal",
  "slides": [
    { "type": "cover" },
    { "type": "toc" },
    { "type": "section", "title": "业绩回顾" },
    { "type": "content", "title": "关键数据", "bullets": ["营收同比 +32%", "新客户 120 家"] },
    { "type": "end" }
  ]
}
```

完整示例见本技能目录 `examples/deck.sample.json`（10 页：cover + toc + 2 章节 + 3 内容页 + 双栏 + 表格 + end）。

## 三套主题

- `business`：深蓝商务（默认）。深蓝封面 + 蓝色强调，正式汇报、对外方案用
- `minimal`：黑白极简。黑色封面 + 灰阶层次，设计感/技术分享用
- `orange`：品牌橘（#f97316 系）。橘色封面 + 暖色调，营销、发布会用

## 常见错误与处理

- `deck.title 缺失或为空`：spec 顶层必须有非空 title
- `slides[i].type "xxx" 为未知版式`:type 只能是七种之一，检查拼写
- `slides[i].table 缺失`：table 版式必须带 headers + rows
- `输出文件已存在`：换输出路径，或确认可覆盖后追加 `--overwrite`

## 红线

- **禁止手写 PPTX 的 XML/二进制内容**，一律通过本脚本渲染
- 内容不足 8 页时，先把大纲给用户确认后再渲染
- 脚本禁止网络请求与交互输入；输出只写到 `--out` 指定路径
