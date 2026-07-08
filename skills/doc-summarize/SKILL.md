---
name: doc-summarize
description: "文档/长文/网页摘要：把长文本、PDF、网页提炼成 TL;DR + 结构化要点 + 关键结论/待办，支持多篇归并。粘贴文本直接做，PDF 用内置 parse_document 工具读取、网页配合 web-search/agent-browser 读取。当用户要总结、摘要、划重点、读这篇/这个文件/这个链接时使用。Summarize long text, PDFs or web pages into a TL;DR plus structured key points and action items; supports merging multiple docs."
tags:
  - summarize
  - documents
  - productivity
priority: normal
---

# 文档摘要（doc-summarize）

把「读不完」的材料压缩成「1 分钟抓住重点」。支持长文、PDF、网页，以及多篇归并对比。

## 需要的输入

- **材料**：粘贴的文本，或文件路径（PDF/Word 等用内置 `parse_document` 工具读取内容），或网址（用 web-search / agent-browser 读取）
- **用途/侧重**（可选）：如只关心结论、只要行动项、面向什么读者
- **篇幅**（可选）：极简 TL;DR / 标准 / 详细

## 工作流

1. **获取内容**：粘贴文本直接用；PDF/文档 → 用内置 `parse_document` 工具解析内容（office-pdf 技能只做合并/拆分/水印，不用于读内容）；网页 → web-search 或 agent-browser 取正文。取不到就告诉用户并请其粘贴。
2. **分层摘要**：
   - **TL;DR**：1~3 句话讲清全文核心
   - **关键要点**：分点列出（按主题/章节归组），保留关键数据与结论
   - **行动项/待办**（如有）：文中隐含的 next step，逐条列出
   - **存疑/缺口**（可选）：材料没讲清或值得追问的点
3. **多篇归并**：多个材料时先各自摘要，再做「共识 / 分歧 / 互补」的对比小结。
4. **忠于原文**：只摘原文有的，不外部补充；观点归观点、事实归事实。

## 红线

- 不添加原文没有的信息、不编造数字与结论
- 长文按比例覆盖全篇，避免只摘开头漏掉后半
- 材料含明显偏见/营销话术时中立提示，不照单全收
- 涉及敏感/隐私内容，产出留在本地不外传
