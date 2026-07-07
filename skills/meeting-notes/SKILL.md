---
name: meeting-notes
description: "Turn raw meeting transcripts or shorthand notes into structured meeting minutes (conclusions, disagreements, action items with owner and deadline). Use when the user pastes meeting records, shares a meeting transcript file, or asks to 整理会议纪要 / summarize a meeting. Output a Word file via the office-doc skill when the user wants a document."
tags:
  - office
  - meeting
  - writing
priority: normal
---

# 会议纪要（meeting-notes）

把会议速记、聊天记录或转写文本整理成结构化会议纪要。

## 输出结构（固定四段）

1. **会议信息**：主题、时间、参会人（能从原文推断多少写多少，缺失标"未提及"，不要编造）
2. **结论与共识**：达成一致的决定，逐条列出
3. **分歧与待定**：未达成一致的观点、遗留问题
4. **行动项**：表格三列——事项 / 责任人 / 期限。责任人或期限原文没有时写"待定"，并在表格后提醒用户补充

## 工作流

1. 输入来源：用户直接粘贴的文本；或附件文件（.txt/.docx/.pdf 用内置 parse_document 工具先解析）。
2. 按上述四段结构产出纪要，全文使用原文语言（中文会议出中文纪要）。
3. 行动项必须逐条可执行：动词开头、单一事项，不合并多件事。
4. 用户要 Word 文件时：调用 office-doc 技能——组装 doc.json（style 用 report，四段各为一个 section，行动项用 table），执行其 scripts/render.mjs 产出 .docx 并告知路径。

## 红线

- 不编造原文没有的结论、责任人与期限。
- 纪要正文不加入个人评价；有风险提示可放在末尾"备注"段并注明是 AI 补充。
