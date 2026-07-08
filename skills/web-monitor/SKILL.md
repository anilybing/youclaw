---
name: web-monitor
description: "网页/竞品监控：用 agent-browser 访问用户给的 URL 列表，提取价格/标题/更新时间等关键信息，与工作区 monitor/ 目录的上次快照 JSON 对比，输出变化报告（新增/变更/无变化）并写回本次快照；首轮无快照输出基线。当用户要盯竞品页面、监控价格/上新/内容更新时使用。Monitor web pages and competitors: visit given URLs via agent-browser, extract key fields, diff against the last snapshot JSON under monitor/ in the workspace, report added/changed/unchanged items and save the new snapshot; first run outputs a baseline."
tags:
  - monitoring
  - browser
  - ecommerce
priority: normal
---

# 网页/竞品监控（web-monitor）

定期看住一批网页，回答「和上次比，变了什么」。适合盯竞品价格、上新、文章更新。本技能常配合定时任务周期运行（用户说「每天帮我盯着」时，用 task MCP 工具创建 cron 任务）。

## 需要的输入

- **URL 列表**：要监控的网页（一行一个）
- **关注要点**（可选）：如价格、标题、库存、上新、更新时间；没说就按页面类型抓常识性关键字段

## 快照约定

- 快照存在工作区 `monitor/` 目录（不存在先创建），每个监控组一个 JSON 文件
- 文件名从 URL 集合派生并保持稳定（如主域名 + 简短标识，例：`monitor/jd-competitor.json`），确保下次运行能找到同一份快照
- 快照结构（示例）：

```json
{
  "updatedAt": "2026-07-08T08:00:00+08:00",
  "pages": [
    { "url": "https://…", "title": "…", "fields": { "价格": "199 元", "更新时间": "2026-07-07" } }
  ]
}
```

## 工作流

1. **访问页面**：用 agent-browser 技能逐个打开 URL（open → wait → snapshot），从页面提取关注要点字段；打不开的页面记为「抓取失败」，不阻塞其余页面。
2. **读上次快照**：读 `monitor/` 下对应 JSON。**首轮无快照**：输出「基线报告」（本次抓到的各页关键信息），说明下次运行开始对比。
3. **对比**：逐 URL 逐字段与上次比对，归为——**新增**（新 URL 或新字段）/ **变更**（字段值变化，给出 旧值 → 新值）/ **无变化**。
4. **输出变化报告**（Markdown）：

   ## 🔍 监控报告（本次 vs YYYY-MM-DD 上次）
   ### 🆕 新增
   ### 🔄 变更（旧值 → 新值）
   ### ➖ 无变化
   ### ⚠️ 抓取失败

   变更为空时明确说「本轮无变化」，不硬凑结论。
5. **写回快照**：把本次抓取结果写回同一 JSON（覆盖前一份），并在报告末尾注明快照路径。

## 红线

- 只做读取与提取，不在目标网站上做登录、下单、提交表单等写操作
- 页面抓不到的字段如实标「未获取」，不猜测填充
- 尊重目标站点：控制频率，不高频轮询；异常反爬提示用户降低频次
