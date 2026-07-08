---
name: web-extract
description: "网页信息结构化提取：给定一个或多个网址和想要的字段（如 标题/价格/时间/联系方式/列表项），用 agent-browser 技能打开页面，把非结构化的网页内容提取成结构化的 Markdown 表格或 JSON，多页可合并去重；提取不到的字段留空标注，不臆造。当用户要从网页扒取信息、批量整理网页字段、把网页内容变成表格时使用。Extract structured data from web pages: given one or more URLs and the fields you want (title, price, date, contact, list items, etc.), open the pages via the agent-browser skill and turn unstructured page content into a structured Markdown table or JSON, merging and de-duplicating across pages; leave missing fields blank instead of inventing them. Use when the user wants to pull information from web pages into a table."
tags:
  - research
  - browser
  - extraction
priority: normal
---

# 网页信息结构化提取（web-extract）

把散落在网页里的非结构化内容，按用户要的字段提取成规整的表格或 JSON。适合批量整理商品信息、榜单/列表、企业资料、文章清单、招聘/展会信息等。

## 需要的输入

- **网址**：一个或多个 URL（一行一个）
- **要提取的字段**：如 标题、价格、发布时间、联系方式、地址、列表项等；用户没说清就先按页面类型提议一组常识性字段，确认后再抓
- **输出格式**（可选）：Markdown 表格（默认）或 JSON

## 工作流

1. **明确字段**：动手前先把「要哪些字段、输出成什么形态」列清楚，字段名统一（避免同义混用）。用户没指定字段时，先给出建议字段清单，请其确认或增删。
2. **逐页打开**：用 agent-browser 技能逐个打开 URL（open → wait --load load → snapshot -i），必要时用 `get text body` 取正文；列表页可先抓列表项，再按需进入详情页补字段。打不开或超时的页面记为「抓取失败」，跳过不阻塞其余页面。
3. **提取字段**：从页面内容按字段抽取对应值，做基本清洗（去掉多余空白、统一单位/日期格式）。**页面里没有的字段一律留空并标注**（如 `—` 或「未提供」），绝不按常识或推测补值。
4. **多页合并**：把多个页面/多条记录汇总到同一张表；结构一致时纵向合并，并按明显主键（如 来源链接、标题、编号）去重。
5. **输出结果**：按约定格式给出结构化结果，并附一句话小结（共几条、几个字段、几处缺失、几页抓取失败）。

## 产出格式

**Markdown 表格**（默认，字段少、便于阅读时）：

| 标题 | 价格 | 发布时间 | 来源链接 |
| --- | --- | --- | --- |
| 示例商品 A | 199 元 | 2026-07-08 | https://… |
| 示例商品 B | — | 2026-07-07 | https://… |

**JSON**（字段多、需再加工时）：

```json
[
  { "标题": "示例商品 A", "价格": "199 元", "发布时间": "2026-07-08", "来源链接": "https://…" },
  { "标题": "示例商品 B", "价格": null, "发布时间": "2026-07-07", "来源链接": "https://…" }
]
```

- 每条记录尽量带「来源链接」字段，便于回溯核对
- 缺失值：表格用 `—`、JSON 用 `null`，并在小结里说明哪些字段缺失较多

## 红线

- **只提取页面公开可见的信息**：不绕过登录、不破解付费墙、不抓取需授权才能看到的内容；遇到需登录/付费的页面，如实告知无法提取。
- **不抓取个人隐私数据**：不批量收集自然人的手机号、身份证号、家庭住址等个人敏感信息（企业公开对外的联系方式除外）。
- **不臆造**：提取不到的字段留空标注，绝不用推测或常识填充；拿不准的值宁可标「待核对」。
- **尊重站点**：控制访问频率，不高频扒站；遇到反爬/验证码如实提示用户，不强行绕过。
- 只做读取与提取，不在目标网站上做登录、下单、评论、提交表单等写操作。
