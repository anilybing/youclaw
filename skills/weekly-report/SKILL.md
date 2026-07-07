---
name: weekly-report
description: "Write weekly work reports (周报) from bullet points, chat fragments, or a list of what the user did. Use when the user asks to 写周报 / 写日报 / 写月报 or summarize their work for a period. Remembers the user's preferred style in agent memory."
tags:
  - office
  - writing
  - productivity
priority: normal
---

# 周报生成（weekly-report）

把零散的工作要点整理成一份可直接提交的周报（同样适用于日报/月报，段落粒度随周期调整）。

## 输出结构（默认三段）

1. **本周完成**：按项目/主题分组，量化结果优先（数字、进度百分比、交付物）
2. **下周计划**：可执行的具体事项，避免"继续推进"这类空话
3. **风险与需要的支持**：阻塞点 + 希望谁提供什么帮助（没有则写"无"）

## 工作流

1. 让用户给出：本周期做的事（要点即可）、下周期打算、卡住的地方。已给出就不要重复追问。
2. 语气默认"客观、简洁、对上级汇报"；用户有明确风格偏好（如更口语化、要英文版、老板喜欢看数据）时，**把偏好写入记忆**（append 到 MEMORY），下次直接套用并在开头说明"按你惯用的风格"。
3. 输出默认 Markdown 文本，方便粘贴进 IM/邮件。
4. 用户要 Word 文件时：调用 office-doc 技能组装 doc.json（style 用 plain，三段各一个 section）渲染 .docx 并告知路径。

## 红线

- 不虚构工作量与数据；要点不足时先列出缺口问用户，不要硬编。
- 不在周报里替用户做出未经确认的承诺（如"下周一定上线"）。
