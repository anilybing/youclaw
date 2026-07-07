---
name: office-excel
description: "当用户要处理/清洗/汇总/透视/拆分 Excel 或 CSV 表格时使用。Process, clean, summarize, pivot, or split Excel (.xlsx) / CSV spreadsheets locally. NOT for creating slides/documents, and NOT for reading a spreadsheet's content into chat (use the built-in document parser for that)."
tags:
  - office
  - excel
  - data
priority: normal
---

# Excel / CSV 表格处理（office-excel）

对本地 `.xlsx` / `.csv` 表格做汇总统计、条件筛选、透视聚合、按列拆分，输出一个新的 `.xlsx` 文件。脚本为预打包单文件，只需 bun，离线运行，**数据不出本机**。

## 红线（必须遵守）

- **数据不出本机**：脚本零网络请求；不得把表格内容上传到任何服务。
- **覆盖前确认**：`--out` 指向已存在的文件时脚本会直接报错；必须先向用户确认，确认后追加 `--overwrite` 重跑。
- 输出只写到用户指定的 `--out` 路径，必须是 `.xlsx`。

## 工作流

1. **先看表头结构**：用已内置的文档解析能力读取输入文件，确认工作表名与列名（列名匹配**大小写敏感**，必须与实际表头完全一致）。
2. **选 mode 并写 config**：按下方 schema 生成 config JSON，写入临时文件（summarize 无需 config）。
3. **执行脚本**：

```bash
bun scripts/excel.mjs --mode <summarize|filter|pivot|split> --input <输入.xlsx|.csv> --out <输出.xlsx> [--config <cfg.json>] [--overwrite]
```

4. **返回产物路径**：解析 stdout 的单行 JSON，把 `out` 的绝对路径告知用户。

## 四种 mode

### summarize（无需 config）

对每个工作表生成 `"<原名>_统计"` 表：每列的非空数、唯一值数；数值列附 sum/avg/min/max（非数值列这四项留空）。

```bash
bun scripts/excel.mjs --mode summarize --input 销售.xlsx --out 销售_统计.xlsx
```

### filter（多条件 AND 筛选）

config schema（`sheet` 可省略，默认第一个工作表；下同）：

```json
{
  "sheet": "Sheet1",
  "where": [
    { "column": "地区", "op": "eq", "value": "华东" },
    { "column": "销量", "op": "gt", "value": 100 }
  ]
}
```

- `op` 可选：`eq`（等于）/ `ne`（不等）/ `gt`（大于）/ `lt`（小于）/ `contains`（文本包含）。
- 多条件之间为 AND。输出命中的行（保留表头）。`gt`/`lt` 只对可转成数值的单元格生效。

### pivot（单字段透视）

```json
{ "sheet": "Sheet1", "rowField": "地区", "valueField": "销量", "agg": "sum" }
```

- `agg` 可选：`sum` / `count` / `avg`。输出两列（分组值、聚合值）到 `"<原名>_透视"` 表。

### split（按列值拆 sheet）

```json
{ "sheet": "Sheet1", "byColumn": "地区" }
```

- 每个不同列值一个工作表（sheet 名 = 该值；Excel 非法字符替换为 `_`，超 31 字符截断，空值归入 `(空)`）。

## 输出契约

- 成功：stdout 单行 JSON，退出码 0。`rows` 含义：summarize=输入数据行数、filter=命中行数、pivot=分组数、split=拆分的总行数。

```json
{"ok":true,"out":"D:\\path\\to\\输出.xlsx","mode":"filter","rows":7}
```

- 失败：stderr 输出人类可读原因，退出码 1（stdout 同时给 `{"ok":false,"error":"..."}`）。

## 常见错误

| 错误信息 | 处理 |
| --- | --- |
| `找不到列 "xxx"（列名匹配大小写敏感）；可用列: ...` | 按错误里列出的可用列改 config（常见原因：大小写/空格不一致） |
| `找不到工作表 "xxx"；可用工作表: ...` | 改 config.sheet 为实际存在的工作表名 |
| `输出文件已存在: ...；确认覆盖请追加 --overwrite` | 先向用户确认，再加 `--overwrite` 重跑 |
| `模式 xxx 需要 --config ...` | filter/pivot/split 必须传 `--config` |
| `不支持的输入格式` | 输入只支持 `.xlsx` 与 `.csv` |

config 示例见 `examples/filter.config.json`。
