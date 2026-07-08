---
name: translate
description: "多语种翻译：高质量翻译文本，支持指定目标语言、语气（正式/口语/营销）与术语表（用户给的固定译法优先）；保留原文 Markdown、换行与代码块格式；专有名词首次出现标注「译名（原文）」，多义或不确定处给备选。默认自动识别源语言。当用户要翻译、译成中文/英文或其他语言、做文案本地化时使用。High-quality translation: supports a target language, tone (formal / casual / marketing), and a glossary (user-provided fixed translations take priority); preserves the original Markdown, line breaks, and code blocks; annotates proper nouns as translation-then-original on first mention and offers alternatives where meaning is ambiguous. Auto-detects the source language by default. Use when the user wants to translate, localize copy, or render text into another language."
tags:
  - research
  - translation
  - language
priority: normal
---

# 多语种翻译（translate）

做「读起来像母语者写的」高质量翻译：忠实达意、语气贴合场景、格式与术语一致。

## 需要的输入

- **原文**：待翻译的文本（可含 Markdown、代码块）。
- **目标语言**：译成什么语言；用户没说时按上下文合理判断（如中英互译）或简短询问。
- **语气**（可选）：正式 / 口语 / 营销等；默认与原文语气保持一致。
- **术语表**（可选）：用户给的固定译法（如产品名、专有名词对照），优先级最高。

## 工作流

1. **识别源语言**：默认自动识别；识别不确定时说明，并按最可能的语言处理。
2. **确认要求**：目标语言、语气、术语表若用户已给就直接采用；关键信息缺失且影响翻译时才简短询问。
3. **翻译成文**：以「达意」为主、忠于原意，不逐字硬翻，产出通顺自然的目标语言。
4. **术语与专名处理**：术语表里的词严格用指定译法；专有名词、人名、机构名、技术名词首次出现给「译名（原文）」，后文可只用译名。
5. **标注不确定处**：一词多义、或原文本身有歧义、语境无法确定时，给出首选译法并在括注里列备选，不擅自替用户拍板。

## 产出格式

- 默认只输出译文，保持与原文一致的结构。
- **保留格式**：原文的 Markdown（标题/列表/表格/加粗/链接）、换行与段落结构、代码块都原样保留；只译代码块内的注释与用户可见字符串，代码本身与变量名不动。
- 用户要求「对照」时，按段落给「原文 / 译文」上下或双栏对照。
- 术语表命中项或关键专名，可在文末附一个「术语对照」小表便于核对。

## 红线

- **忠实不增删**：不添油加醋、不遗漏信息、不擅自「优化」原文观点；原文的事实、数字、语气如实传达。
- **术语一致**：全篇同一术语译法统一；用户术语表优先于一切默认译法。
- **格式零破坏**：不改动 Markdown 结构、代码、占位符、变量名与标签（如 `{name}`、`%s`、HTML 标签）。
- **拿不准就标注**：不确定的译法给备选而非假装确定；涉及法律/医疗/合同等高风险文本，提示以原文为准并建议人工复核。
