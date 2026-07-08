---
name: daily-briefing
description: "每日简报：汇总记忆与近期会话要点、用 web-search 查用户关注主题的当日要闻，输出固定结构简报（今日重点/日程与待办/关注领域动态/建议）。当用户要每日简报、晨报、今日摘要，或设置了每天早晨的定时简报任务时使用。Generate a daily briefing: recap memory and recent sessions, fetch today's news on the user's topics via web-search, and output a fixed-structure digest (highlights / schedule / news / suggestions). Designed to pair with a scheduled morning task."
tags:
  - briefing
  - productivity
  - news
priority: normal
---

# 每日简报（daily-briefing）

每天早晨把「你该知道的事」浓缩成一份 1 分钟能读完的简报。本技能常配合定时任务在每天早晨自动运行（用户说「每天早上给我发简报」时，用 task MCP 工具创建 cron 任务，如 `0 8 * * *`）。

## 需要的输入

- **关注主题**：用户关心的领域/关键词（如 AI 行业、跨境电商、某只股票）；定时任务场景从任务 prompt 或记忆中读取
- **推送偏好**（可选）：条数、详略、语气

## 工作流

1. **回顾内部上下文**：系统会自动注入记忆上下文（长期记忆与近期日志）；从中提取——未完成的待办、今天/近期的日程约定、上次对话的挂起事项。没有就如实留空，不编造。
2. **查外部要闻**：用 web-search 技能检索关注主题的当日要闻，每个主题 1~3 条；只选与主题强相关的，标注来源。
3. **输出固定结构简报**：

   ## 📌 今日重点
   （1~3 条今天最该关注的事，内部事项优先）

   ## 📅 日程与待办
   （从记忆中提取的日程/待办；无则写「暂无记录」）

   ## 📰 关注领域动态
   （按主题分组的当日要闻，每条一句话 + 来源）

   ## 💡 建议
   （1~2 条基于以上信息的行动建议，具体可执行）

4. **控制篇幅**：全文默认 300 字以内；用户偏好「详细版」时放宽。

## 红线

- 记忆里没有的日程/待办不臆造；搜不到的要闻如实说「今日无重要更新」
- 要闻必须来自 web-search 结果并带来源，不凭训练数据编「今日新闻」
- 建议不夸大不制造焦虑，给用户能落地的下一步
