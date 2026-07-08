---
name: research-report
description: "深度联网调研：针对一个主题做多来源联网调研——用 web-search 技能检索、用 agent-browser 技能深入关键页面，交叉核对后输出结构化调研报告（背景 / 关键发现 / 多方观点 / 结论建议 / 信息来源清单含链接）。每条关键结论可追溯来源，并注明检索日期与时效性。当用户要做主题调研、深度研究、行业/竞品/技术调查或撰写调研报告时使用。Deep web research on a topic across multiple sources: search with the web-search skill, dive into key pages with the agent-browser skill, cross-check, then produce a structured report (background / key findings / multiple viewpoints / conclusions & recommendations / a source list with links). Every key conclusion is traceable to a source, with the search date noted. Use for topic research, deep dives, industry / competitor / tech investigations, or writing a research report."
tags:
  - research
  - web
  - report
priority: normal
---

# 深度联网调研（research-report）

针对一个主题做多来源联网调研，交叉核对后给出「每条结论都能查证来源」的结构化报告。

## 需要的输入

- **调研主题**：要研究的问题或对象（如某技术选型、某行业趋势、某竞品）。
- **范围与侧重**（可选）：时间范围、地域，或只看某个角度（技术/市场/价格/口碑）。
- **深度与篇幅**（可选）：快速概览还是深度报告；默认中等深度。

## 工作流

1. **拆解主题**：先把主题拆成 3-6 个具体子问题/检索角度，明确要回答什么。
2. **广度检索**：用 web-search 技能围绕各子问题检索——关键词短而精、技术类优先英文、加年份或「最新」限定时效；每个角度换 1-2 组关键词多查几遍。
3. **深入关键来源**：对检索到的高价值页面，用 agent-browser 技能打开读取正文核对细节（`agent-browser open <url> && agent-browser wait --load load` 后取正文），不要只凭搜索摘要下结论。
4. **交叉核对**：重要事实/数据至少在 2 个独立来源确认一致；出现矛盾时并列呈现并说明分歧。
5. **成文**：按下面结构组织，边写边把每条关键结论对应到来源。

## 报告结构

**一、背景与调研问题**：主题背景、要回答的核心问题、检索范围。

**二、关键发现**：核心事实与数据，逐条列出，每条关键结论标注来源编号（如 [1]）。

**三、多方观点**：对有争议或有多种做法的点，并列不同立场/方案及其依据。

**四、结论与建议**：基于以上发现给出可执行结论；属于自己的推断而非来源明说的，标【推测】。

**五、信息来源清单**：编号列出全部来源，每条含标题 + 链接（URL）+（可选）来源性质；并注明「检索日期：YYYY-MM-DD」。

## 红线

- **结论可追溯**：每条关键结论/数据都要能对应到来源清单里的具体链接；无来源支撑的判断一律标【推测】。
- **不编造**：绝不虚构链接、数据、引文或不存在的来源；搜不到就如实说「未检索到可靠来源」。
- **标注时效**：注明检索日期，对时间敏感的信息（价格、版本、政策等）提示可能已更新。
- **区分事实与推断**：来源明确支持的写为事实，自己的综合判断写为推断/建议并标注。
- 来源质量存疑（营销软文、无署名、互相转抄）时降低权重并提示读者。
