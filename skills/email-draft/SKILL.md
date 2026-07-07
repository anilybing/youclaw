---
name: email-draft
description: "Draft professional emails in Chinese or English (business outreach, replies, apologies, follow-ups, cross-border communication). Use when the user asks to 写邮件 / 回邮件 / draft an email, or pastes an email asking how to reply."
tags:
  - office
  - email
  - writing
priority: normal
---

# 邮件草拟（email-draft）

按目的、收件人与语气快速产出可直接发送的邮件草稿，支持中英双语。

## 需要的输入（缺失时一次性问全，不要挤牙膏）

- 目的：要对方做什么 / 传达什么
- 收件人关系：客户、上级、同事、供应商、陌生开发信…
- 语气：正式 / 亲和 / 强硬 / 致歉
- 语言：中文、英文或双语对照
- 回信场景：把对方的原邮件贴上来

## 输出格式

```text
主题：<一行，直切主题>

<称呼>，

<正文：第一段说目的，中段给要点（多于 3 点用列表），结尾明确期望动作与时限>

<落款>
```

- 英文邮件遵循同结构；双语时先中文后英文，两版语义一致而非直译。
- 回信场景先给"一句话立场"，再给全文草稿。

## 红线

- 不代替用户做超出其授权的承诺（价格、期限、赔偿）；涉及时在草稿中用【待确认】标注。
- 强硬语气也保持专业措辞，不输出侮辱性内容。
- 邮件默认直接输出文本，不落盘；用户明确要 .docx 才走 office-doc。
