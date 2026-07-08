// 数字员工工作台任务卡片配置（T-D8，商业化专属）
// 卡片 = 预置提示词模板 + 表单输入 + 绑定预置数字员工 office-assistant。
// 文案随卡片走 zh/en 双语（避免膨胀全局 i18n；导航等公共文案仍走 i18n）。

export type WorkbenchLocale = 'zh' | 'en'

/** 工作台任务分类（按类型分 tab；未来新增能力扩展此联合类型 + WORKBENCH_CATEGORIES 即可） */
export type WorkbenchCategoryId = 'office' | 'ecom' | 'content'

export interface WorkbenchField {
  key: string
  kind: 'text' | 'textarea' | 'file'
  required: boolean
  label: Record<WorkbenchLocale, string>
  placeholder?: Record<WorkbenchLocale, string>
  /** file 类型的 accept 属性 */
  accept?: string
}

export interface WorkbenchTask {
  id: string
  icon: string
  title: Record<WorkbenchLocale, string>
  desc: Record<WorkbenchLocale, string>
  /** {{key}} 占位符会被表单值替换；附件文件名清单会自动追加说明 */
  promptTemplate: Record<WorkbenchLocale, string>
  fields: WorkbenchField[]
  /**
   * 是否允许"定时执行"（T-G5）。含文件上传的任务不宜定时（附件是一次性的），
   * 默认 false；纯文本输入类任务显式开启。
   */
  schedulable?: boolean
  /**
   * 绑定的数字员工 id；缺省用 WORKBENCH_AGENT_ID（办公助理）。
   * 电商能力包卡片绑定 ecommerce-assistant（电商助理）。
   */
  agentId?: string
  /** 任务分类；缺省按 agentId 归类（见 getTaskCategory），未来能力可显式指定 */
  category?: WorkbenchCategoryId
}

export const WORKBENCH_AGENT_ID = 'office-assistant'
/** 电商能力包卡片绑定的数字员工 */
export const ECOMMERCE_AGENT_ID = 'ecommerce-assistant'
/** 内容创作能力包卡片绑定的数字员工 */
export const CONTENT_AGENT_ID = 'content-creator'

/** 工作台分类定义（数组顺序即 tab 展示顺序） */
export interface WorkbenchCategory {
  id: WorkbenchCategoryId
  label: Record<WorkbenchLocale, string>
  icon: string
}

export const WORKBENCH_CATEGORIES: WorkbenchCategory[] = [
  { id: 'office', label: { zh: '办公', en: 'Office' }, icon: '🗂️' },
  { id: 'ecom', label: { zh: '电商', en: 'E-commerce' }, icon: '🛒' },
  { id: 'content', label: { zh: '创作', en: 'Content' }, icon: '✍️' },
]

/** 归类一个任务：优先显式 category，其次按绑定的数字员工推断 */
export function getTaskCategory(task: WorkbenchTask): WorkbenchCategoryId {
  if (task.category) return task.category
  if (task.agentId === ECOMMERCE_AGENT_ID) return 'ecom'
  if (task.agentId === CONTENT_AGENT_ID) return 'content'
  return 'office'
}

/** 定时执行的 cron 预设（T-G5，工作台友好选项，避免让小白写 cron 表达式） */
export interface CronPreset {
  id: string
  cron: string
  label: Record<WorkbenchLocale, string>
}

export const WORKBENCH_CRON_PRESETS: CronPreset[] = [
  { id: 'weekly-fri-17', cron: '0 17 * * 5', label: { zh: '每周五 17:00', en: 'Every Fri 17:00' } },
  { id: 'weekly-mon-09', cron: '0 9 * * 1', label: { zh: '每周一 09:00', en: 'Every Mon 09:00' } },
  { id: 'daily-09', cron: '0 9 * * *', label: { zh: '每天 09:00', en: 'Daily 09:00' } },
  { id: 'daily-18', cron: '0 18 * * *', label: { zh: '每天 18:00', en: 'Daily 18:00' } },
  { id: 'monthly-1-09', cron: '0 9 1 * *', label: { zh: '每月 1 号 09:00', en: 'Monthly 1st 09:00' } },
]

export const WORKBENCH_TASKS: WorkbenchTask[] = [
  {
    id: 'make-ppt',
    icon: '📊',
    title: { zh: '帮我做 PPT', en: 'Make a PPT' },
    desc: { zh: '给个主题和要点，产出可打开的 .pptx', en: 'Topic + key points → ready-to-open .pptx' },
    promptTemplate: {
      zh: '请帮我制作一份 PPT。主题：{{topic}}。要点或大纲：{{outline}}。页数期望：{{pages}}。请先给出大纲让我确认，再用 office-ppt 技能生成文件到「办公产出」目录。',
      en: 'Please create a PPT. Topic: {{topic}}. Outline/key points: {{outline}}. Expected pages: {{pages}}. Confirm the outline with me first, then generate the file with the office-ppt skill into the output folder.',
    },
    fields: [
      { key: 'topic', kind: 'text', required: true, label: { zh: '主题', en: 'Topic' }, placeholder: { zh: '例如：XiaoJuClaw 产品介绍', en: 'e.g. Product introduction' } },
      { key: 'outline', kind: 'textarea', required: false, label: { zh: '要点/大纲（可选）', en: 'Key points (optional)' }, placeholder: { zh: '一行一个要点，留空由 AI 拟大纲', en: 'One point per line; leave empty to let AI draft' } },
      { key: 'pages', kind: 'text', required: false, label: { zh: '页数（可选）', en: 'Pages (optional)' }, placeholder: { zh: '例如：10', en: 'e.g. 10' } },
    ],
  },
  {
    id: 'write-doc',
    icon: '📝',
    title: { zh: '写 Word 报告', en: 'Write a Word doc' },
    desc: { zh: '报告/方案/总结，产出 .docx', en: 'Report / proposal → .docx' },
    promptTemplate: {
      zh: '请帮我写一份 Word 文档。类型：{{docType}}。主题与要求：{{requirement}}。请先列大纲确认，再用 office-doc 技能生成 .docx 到「办公产出」目录。',
      en: 'Please write a Word document. Type: {{docType}}. Topic & requirements: {{requirement}}. Outline first, then generate .docx via the office-doc skill.',
    },
    fields: [
      { key: 'docType', kind: 'text', required: true, label: { zh: '文档类型', en: 'Type' }, placeholder: { zh: '例如：项目方案 / 工作总结 / 调研报告', en: 'e.g. proposal / summary / research' } },
      { key: 'requirement', kind: 'textarea', required: true, label: { zh: '主题与要求', en: 'Topic & requirements' }, placeholder: { zh: '写清楚给谁看、大概篇幅、必须包含什么', en: 'Audience, length, must-have sections' } },
    ],
  },
  {
    id: 'process-excel',
    icon: '📈',
    title: { zh: '处理 Excel 表格', en: 'Process Excel' },
    desc: { zh: '清洗/汇总/透视/拆分表格文件', en: 'Clean / summarize / pivot / split' },
    promptTemplate: {
      zh: '请帮我处理这个表格文件。我的要求：{{requirement}}。请先读取表头结构确认理解，再用 office-excel 技能处理并输出新文件到「办公产出」目录（不要改动原文件）。若表格很复杂或需多步深加工，可派表格专员（sheet-processor）分治处理。',
      en: 'Please process the attached spreadsheet. Requirement: {{requirement}}. Inspect the headers first, then process via the office-excel skill into a new file (never modify the original). If the spreadsheet is complex or needs multi-step processing, delegate to the sheet-processor specialist.',
    },
    fields: [
      { key: 'file', kind: 'file', required: true, label: { zh: '表格文件', en: 'Spreadsheet' }, accept: '.xlsx,.csv' },
      { key: 'requirement', kind: 'textarea', required: true, label: { zh: '处理要求', en: 'Requirement' }, placeholder: { zh: '例如：按地区汇总销量，或筛选出金额>1000 的行', en: 'e.g. pivot sales by region' } },
    ],
  },
  {
    id: 'data-report',
    icon: '📊',
    title: { zh: '数据报告', en: 'Data report' },
    desc: { zh: '表格数据→图表+结论的 HTML 报告', en: 'Table data → HTML report with charts' },
    promptTemplate: {
      zh: '请使用 data-report 技能帮我做数据分析与可视化报告。我的分析需求：{{requirement}}。请先做数据画像（行数/字段/缺失）并与我确认分析目标，再生成单文件自包含 HTML 报告（内嵌数据 + ECharts 图表 + 3~5 条结论摘要 + 数据明细表）到「数据报告」目录，最后告诉我文件路径和结论摘要。',
      en: 'Use the data-report skill for data analysis and a visual report. My requirement: {{requirement}}. Profile the data first (rows / fields / missing values) and confirm the goals with me, then generate a self-contained single-file HTML report (embedded data + ECharts charts + 3-5 key insights + detail table) into the report folder, and give me the file path with the insights.',
    },
    fields: [
      { key: 'file', kind: 'file', required: false, label: { zh: '数据文件（可选，也可在需求里粘贴数据）', en: 'Data file (optional, or paste data below)' }, accept: '.xlsx,.xls,.csv' },
      { key: 'requirement', kind: 'textarea', required: true, label: { zh: '分析需求', en: 'Requirement' }, placeholder: { zh: '例如：分析各渠道销量趋势，找出下滑原因', en: 'e.g. analyze sales trends by channel and find the decline causes' } },
    ],
  },
  {
    id: 'process-pdf',
    icon: '📄',
    title: { zh: 'PDF 摘要/拆分', en: 'PDF summary / split' },
    desc: { zh: '读 PDF 提要点，或合并拆分加水印', en: 'Summarize, merge, split, watermark' },
    promptTemplate: {
      zh: '请帮我处理这个 PDF。我的要求：{{requirement}}。内容摘要直接用内置文档解析；合并/拆分/水印用 office-pdf 技能，产物放「办公产出」目录。若文档很长（约 50 页以上），可派长文档专员（long-doc-processor）分段分治处理。',
      en: 'Please handle the attached PDF. Requirement: {{requirement}}. Use built-in parsing for summaries; use the office-pdf skill for merge/split/watermark. If the document is very long (50+ pages), delegate to the long-doc-processor specialist for chunked processing.',
    },
    fields: [
      { key: 'file', kind: 'file', required: true, label: { zh: 'PDF 文件', en: 'PDF file' }, accept: '.pdf' },
      { key: 'requirement', kind: 'textarea', required: true, label: { zh: '处理要求', en: 'Requirement' }, placeholder: { zh: '例如：总结要点 / 只保留 1-3 页 / 加"机密"水印', en: 'e.g. summarize / keep pages 1-3' } },
    ],
  },
  {
    id: 'meeting-notes',
    icon: '🗒️',
    title: { zh: '整理会议纪要', en: 'Meeting minutes' },
    desc: { zh: '速记/录音转写 → 结构化纪要', en: 'Raw notes → structured minutes' },
    promptTemplate: {
      zh: '请用 meeting-notes 技能把下面的会议记录整理成纪要（结论/分歧/行动项表）。会议记录：\n{{notes}}\n如需 Word 文件我会再说。',
      en: 'Use the meeting-notes skill to structure these meeting notes (conclusions / disagreements / action items):\n{{notes}}',
    },
    fields: [
      { key: 'notes', kind: 'textarea', required: false, label: { zh: '会议记录（可粘贴或传文件）', en: 'Notes (paste or attach)' }, placeholder: { zh: '粘贴速记，或在下面附上文件', en: 'Paste notes or attach a file below' } },
      { key: 'file', kind: 'file', required: false, label: { zh: '记录文件（可选）', en: 'File (optional)' }, accept: '.txt,.docx,.pdf,.md' },
    ],
  },
  {
    id: 'weekly-report',
    icon: '📅',
    title: { zh: '写周报', en: 'Weekly report' },
    desc: { zh: '扔进要点，产出可提交的周报', en: 'Bullets in, polished report out' },
    schedulable: true,
    promptTemplate: {
      zh: '请用 weekly-report 技能帮我写周报。本周做的事：{{done}}。下周计划：{{plan}}。遇到的问题：{{blockers}}。',
      en: 'Use the weekly-report skill. Done this week: {{done}}. Next week: {{plan}}. Blockers: {{blockers}}.',
    },
    fields: [
      { key: 'done', kind: 'textarea', required: true, label: { zh: '本周做的事', en: 'Done this week' }, placeholder: { zh: '要点即可，一行一条；定时执行时可写"根据本周记忆自动整理"', en: 'One bullet per line' } },
      { key: 'plan', kind: 'textarea', required: false, label: { zh: '下周计划（可选）', en: 'Next week (optional)' } },
      { key: 'blockers', kind: 'text', required: false, label: { zh: '问题/需要的支持（可选）', en: 'Blockers (optional)' } },
    ],
  },
  {
    id: 'daily-briefing',
    icon: '📰',
    title: { zh: '每日简报', en: 'Daily briefing' },
    desc: { zh: '待办日程+关注领域当日要闻，适合定时', en: 'Todos + today\'s news, great scheduled' },
    schedulable: true,
    promptTemplate: {
      zh: '请使用 daily-briefing 技能生成今天的每日简报。我的关注主题：{{topics}}。推送偏好：{{preference}}。结合记忆里的日程与待办，用 web-search 查关注主题的当日要闻，按「今日重点 / 日程与待办 / 关注领域动态 / 建议」四段结构输出。',
      en: 'Use the daily-briefing skill to generate today\'s briefing. My topics: {{topics}}. Preferences: {{preference}}. Combine remembered schedule/todos with today\'s news on my topics via web-search, structured as highlights / schedule & todos / topic updates / suggestions.',
    },
    fields: [
      { key: 'topics', kind: 'textarea', required: true, label: { zh: '关注主题', en: 'Topics' }, placeholder: { zh: '一行一个，例如：AI 行业动态、跨境电商政策', en: 'One per line, e.g. AI industry, cross-border policy' } },
      { key: 'preference', kind: 'text', required: false, label: { zh: '推送偏好说明（可选）', en: 'Preferences (optional)' }, placeholder: { zh: '例如：只要 3 条以内 / 详细版 / 语气轻松', en: 'e.g. max 3 items / detailed / casual tone' } },
    ],
  },
  {
    id: 'email-draft',
    icon: '✉️',
    title: { zh: '草拟邮件', en: 'Draft an email' },
    desc: { zh: '说明目的和语气，中英文都行', en: 'Purpose + tone, CN or EN' },
    promptTemplate: {
      zh: '请用 email-draft 技能帮我写邮件。目的：{{purpose}}。收件人：{{recipient}}。语气：{{tone}}。语言：{{language}}。',
      en: 'Use the email-draft skill. Purpose: {{purpose}}. Recipient: {{recipient}}. Tone: {{tone}}. Language: {{language}}.',
    },
    fields: [
      { key: 'purpose', kind: 'textarea', required: true, label: { zh: '邮件目的', en: 'Purpose' }, placeholder: { zh: '要对方做什么/传达什么；回信场景把原邮件贴进来', en: 'What you need; paste the original mail if replying' } },
      { key: 'recipient', kind: 'text', required: true, label: { zh: '收件人关系', en: 'Recipient' }, placeholder: { zh: '例如：客户 / 上级 / 供应商', en: 'e.g. client / manager' } },
      { key: 'tone', kind: 'text', required: false, label: { zh: '语气（可选）', en: 'Tone (optional)' }, placeholder: { zh: '正式 / 亲和 / 强硬 / 致歉', en: 'formal / friendly / firm' } },
      { key: 'language', kind: 'text', required: false, label: { zh: '语言（可选）', en: 'Language (optional)' }, placeholder: { zh: '中文 / English / 双语', en: 'CN / EN / both' } },
    ],
  },
  {
    id: 'organize-files',
    icon: '🗂️',
    title: { zh: '整理文件夹', en: 'Organize a folder' },
    desc: { zh: '按类型或月份归类，先预览后执行', en: 'Group by type/month, preview first' },
    schedulable: true,
    promptTemplate: {
      zh: '请用 file-organizer 技能整理这个文件夹：{{dir}}。规则：{{rule}}。务必先 dry-run 给我看移动计划，我确认后再执行。',
      en: 'Use the file-organizer skill on: {{dir}}. Rule: {{rule}}. Dry-run first and show me the plan; apply only after I confirm.',
    },
    fields: [
      { key: 'dir', kind: 'text', required: true, label: { zh: '文件夹路径', en: 'Folder path' }, placeholder: { zh: '例如：D:\\下载', en: 'e.g. D:\\Downloads' } },
      { key: 'rule', kind: 'text', required: false, label: { zh: '规则（可选）', en: 'Rule (optional)' }, placeholder: { zh: '按类型（默认）或按月份', en: 'by type (default) or by month' } },
    ],
  },
  {
    id: 'free-ask',
    icon: '💬',
    title: { zh: '其他求助', en: 'Anything else' },
    desc: { zh: '直接描述你要做的事', en: 'Describe what you need' },
    promptTemplate: {
      zh: '{{ask}}',
      en: '{{ask}}',
    },
    fields: [
      { key: 'ask', kind: 'textarea', required: true, label: { zh: '想让我做什么', en: 'What do you need' }, placeholder: { zh: '用一句话描述任务，可以附文件', en: 'Describe the task; attach files if needed' } },
      { key: 'file', kind: 'file', required: false, label: { zh: '相关文件（可选）', en: 'File (optional)' } },
    ],
  },

  // ─── 电商能力包（绑定电商助理，client-side 零配置）─────────────────────
  {
    id: 'ecom-title',
    icon: '🏷️',
    title: { zh: '商品标题优化', en: 'Product title' },
    desc: { zh: '给品名和卖点，产出多条标题', en: 'Name + selling points → titles' },
    agentId: ECOMMERCE_AGENT_ID,
    promptTemplate: {
      zh: '请用 ecom-copywriter 技能（title 模式）帮我优化商品标题。商品：{{product}}。核心卖点：{{points}}。销售平台：{{platform}}。给 5 条候选并标注各自主打的关键词/人群，遵守该平台标题限长。',
      en: 'Use the ecom-copywriter skill (title mode) to optimize product titles. Product: {{product}}. Selling points: {{points}}. Platform: {{platform}}. Give 5 candidates with the keyword/audience each targets, respecting the platform title length limit.',
    },
    fields: [
      { key: 'product', kind: 'text', required: true, label: { zh: '商品名称', en: 'Product' }, placeholder: { zh: '例如：便携无线榨汁杯', en: 'e.g. portable juicer cup' } },
      { key: 'points', kind: 'textarea', required: true, label: { zh: '核心卖点', en: 'Selling points' }, placeholder: { zh: '例如：无线充电、一键清洗、随身带', en: 'e.g. wireless, easy-clean, portable' } },
      { key: 'platform', kind: 'text', required: true, label: { zh: '销售平台', en: 'Platform' }, placeholder: { zh: '淘宝 / 拼多多 / 抖音小店 / 小红书', en: 'Taobao / Pinduoduo / Douyin / etc.' } },
    ],
  },
  {
    id: 'ecom-detail',
    icon: '🛍️',
    title: { zh: '商品详情文案', en: 'Product detail copy' },
    desc: { zh: '结构化详情页卖点文案', en: 'Structured detail-page copy' },
    agentId: ECOMMERCE_AGENT_ID,
    promptTemplate: {
      zh: '请用 ecom-copywriter 技能（detail 模式）帮我写商品详情文案。商品：{{product}}。目标人群：{{audience}}。核心卖点：{{points}}。风格：{{tone}}。按痛点→卖点→场景→信任→促单结构输出。',
      en: 'Use the ecom-copywriter skill (detail mode) to write product detail copy. Product: {{product}}. Audience: {{audience}}. Selling points: {{points}}. Tone: {{tone}}. Structure: pain → benefit → scenario → trust → CTA.',
    },
    fields: [
      { key: 'product', kind: 'text', required: true, label: { zh: '商品名称', en: 'Product' }, placeholder: { zh: '例如：真丝眼罩', en: 'e.g. silk eye mask' } },
      { key: 'audience', kind: 'text', required: true, label: { zh: '目标人群', en: 'Audience' }, placeholder: { zh: '例如：熬夜党 / 送礼', en: 'e.g. night owls / gifting' } },
      { key: 'points', kind: 'textarea', required: true, label: { zh: '核心卖点', en: 'Selling points' }, placeholder: { zh: '一行一个卖点', en: 'One point per line' } },
      { key: 'tone', kind: 'text', required: false, label: { zh: '文案风格（可选）', en: 'Tone (optional)' }, placeholder: { zh: '专业 / 亲和 / 种草 / 促销', en: 'pro / friendly / seeding / promo' } },
    ],
  },
  {
    id: 'ecom-rewrite',
    icon: '🔁',
    title: { zh: '多平台文案改写', en: 'Multi-platform rewrite' },
    desc: { zh: '一份文案适配到不同平台语气', en: 'Adapt copy to each platform' },
    agentId: ECOMMERCE_AGENT_ID,
    promptTemplate: {
      zh: '请用 ecom-copywriter 技能（rewrite 模式）把下面这份文案改写到目标平台，保持卖点事实不变，只调语气/格式/长度以适配。目标平台：{{platform}}。原文案：\n{{source}}',
      en: 'Use the ecom-copywriter skill (rewrite mode) to adapt the copy below to the target platform, keeping the facts but adjusting tone/format/length. Target platform: {{platform}}. Source copy:\n{{source}}',
    },
    fields: [
      { key: 'platform', kind: 'text', required: true, label: { zh: '目标平台', en: 'Target platform' }, placeholder: { zh: '例如：小红书 / 抖音 / 亚马逊', en: 'e.g. Xiaohongshu / Douyin / Amazon' } },
      { key: 'source', kind: 'textarea', required: true, label: { zh: '原文案', en: 'Source copy' }, placeholder: { zh: '粘贴你现有的文案', en: 'Paste your existing copy' } },
    ],
  },
  {
    id: 'ecom-compliance',
    icon: '🛡️',
    title: { zh: '违禁词合规检测', en: 'Compliance check' },
    desc: { zh: '查极限词/违禁词，给合规替换', en: 'Find banned words, suggest fixes' },
    agentId: ECOMMERCE_AGENT_ID,
    promptTemplate: {
      zh: '请用 ecom-compliance 技能检测下面这段文案的《广告法》极限词、虚假宣传与行业违禁词，输出风险清单表（原文片段/命中类型/风险等级/合规替换）并给一键修正版全文。文案：\n{{content}}',
      en: 'Use the ecom-compliance skill to check the copy below for banned/absolute words, false claims and industry-restricted terms; output a risk table (fragment / type / level / replacement) and a fixed full version. Copy:\n{{content}}',
    },
    fields: [
      { key: 'content', kind: 'textarea', required: true, label: { zh: '待检测文案', en: 'Copy to check' }, placeholder: { zh: '粘贴标题/详情/主图文案/直播话术', en: 'Paste title / detail / livestream copy' } },
    ],
  },
  {
    id: 'ecom-image',
    icon: '🖼️',
    title: { zh: '主图批量处理', en: 'Batch product images' },
    desc: { zh: '白底/裁尺寸/压缩/加水印，整文件夹', en: 'White bg / resize / compress / watermark' },
    agentId: ECOMMERCE_AGENT_ID,
    promptTemplate: {
      zh: '请用 ecom-image 技能处理这个文件夹里的商品图：{{dir}}。处理要求：{{requirement}}。产物输出到「电商产出」目录的新子目录，不要覆盖原图；批量前先拿 1 张试参数给我确认。',
      en: 'Use the ecom-image skill to process product images in this folder: {{dir}}. Requirement: {{requirement}}. Output to a new subfolder under the output directory, never overwrite originals; try one image first for confirmation.',
    },
    fields: [
      { key: 'dir', kind: 'text', required: true, label: { zh: '图片文件夹路径', en: 'Image folder path' }, placeholder: { zh: '例如：D:\\商品图', en: 'e.g. D:\\product-images' } },
      { key: 'requirement', kind: 'textarea', required: true, label: { zh: '处理要求', en: 'Requirement' }, placeholder: { zh: '例如：统一做成 800x800 白底图并压缩；或加右下角 logo 水印', en: 'e.g. 800x800 white-bg + compress; or add logo watermark' } },
    ],
  },
  {
    id: 'ecom-analytics',
    icon: '📊',
    title: { zh: '销售报表分析', en: 'Sales report analysis' },
    desc: { zh: '传销售表，产出经营诊断与建议', en: 'Upload report → diagnosis + advice' },
    agentId: ECOMMERCE_AGENT_ID,
    promptTemplate: {
      zh: '请用 ecom-analytics 技能分析这份销售报表。我想看的：{{focus}}。请先读表头跟我确认关键列含义，再用 office-excel 做本地汇总/透视，最后给经营诊断报告（现状→关键发现→问题→按优先级排序的行动建议）。',
      en: 'Use the ecom-analytics skill to analyze this sales report. Focus: {{focus}}. Confirm the key columns first, compute summaries/pivots locally via office-excel, then give a diagnosis report (overview → findings → issues → prioritized actions).',
    },
    fields: [
      { key: 'file', kind: 'file', required: true, label: { zh: '销售报表', en: 'Sales report' }, accept: '.xlsx,.csv' },
      { key: 'focus', kind: 'textarea', required: false, label: { zh: '想重点看什么（可选）', en: 'Focus (optional)' }, placeholder: { zh: '例如：找出滞销款、看哪个渠道转化高', en: 'e.g. find slow movers, best channel' } },
    ],
  },
  {
    id: 'ecom-monitor',
    icon: '🔍',
    title: { zh: '竞品监控', en: 'Competitor monitor' },
    desc: { zh: '盯竞品页面价格/上新，输出变化报告', en: 'Watch pages, report changes' },
    agentId: ECOMMERCE_AGENT_ID,
    schedulable: true,
    promptTemplate: {
      zh: '请使用 web-monitor 技能监控以下网页：\n{{urls}}\n关注要点：{{focus}}。用 agent-browser 访问页面提取关键信息，与工作区 monitor/ 目录的上次快照对比，输出变化报告（新增/变更/无变化）并保存本次快照；首次运行输出基线报告。',
      en: 'Use the web-monitor skill to monitor these pages:\n{{urls}}\nFocus: {{focus}}. Visit each page via agent-browser, extract key fields, diff against the last snapshot under monitor/ in the workspace, report added/changed/unchanged and save the new snapshot; output a baseline on the first run.',
    },
    fields: [
      { key: 'urls', kind: 'textarea', required: true, label: { zh: '监控网址', en: 'URLs to monitor' }, placeholder: { zh: '一行一个网址', en: 'One URL per line' } },
      { key: 'focus', kind: 'text', required: false, label: { zh: '关注要点（可选）', en: 'Focus (optional)' }, placeholder: { zh: '例如：价格 / 上新 / 标题变化', en: 'e.g. price / new arrivals / title changes' } },
    ],
  },

  // ─── 内容创作能力包（绑定创作助理，纯 prompt 技能零配置）───────────────
  {
    id: 'content-article',
    icon: '✒️',
    title: { zh: '写公众号/知乎长文', en: 'Long-form article' },
    desc: { zh: '选题→大纲→成稿，附 3 个备选标题', en: 'Topic → outline → draft + 3 titles' },
    agentId: CONTENT_AGENT_ID,
    promptTemplate: {
      zh: '请使用 content-article 技能帮我写一篇长文。主题：{{topic}}。目标读者：{{audience}}。篇幅/风格：{{style}}。请先给大纲和标题方向让我确认，再成稿（含金句与小标题），最后给 3 个备选标题并自检标题党。',
      en: 'Use the content-article skill to write a long-form article. Topic: {{topic}}. Target readers: {{audience}}. Length/style: {{style}}. Confirm the outline and title direction with me first, then deliver the draft (with hooks and subheadings) plus 3 alternative titles with a clickbait self-check.',
    },
    fields: [
      { key: 'topic', kind: 'text', required: true, label: { zh: '主题', en: 'Topic' }, placeholder: { zh: '例如：打工人如何用 AI 提效', en: 'e.g. How office workers can use AI' } },
      { key: 'audience', kind: 'text', required: false, label: { zh: '目标读者（可选）', en: 'Target readers (optional)' }, placeholder: { zh: '例如：职场新人 / 宝妈 / 创业者', en: 'e.g. juniors / moms / founders' } },
      { key: 'style', kind: 'text', required: false, label: { zh: '篇幅/风格（可选）', en: 'Length/style (optional)' }, placeholder: { zh: '例如：2000 字左右，公众号风格', en: 'e.g. ~2000 words, WeChat style' } },
    ],
  },
  {
    id: 'content-xiaohongshu',
    icon: '📕',
    title: { zh: '小红书笔记', en: 'Xiaohongshu note' },
    desc: { zh: '钩子标题+正文+标签，一次 2 个版本', en: 'Hook title + body + tags, 2 variants' },
    agentId: CONTENT_AGENT_ID,
    promptTemplate: {
      zh: '请使用 content-xiaohongshu 技能帮我写小红书笔记。主题/产品：{{topic}}。亮点/卖点：{{points}}。人设/风格：{{persona}}。按规范输出 2 个风格版本：钩子式标题（含 emoji）、分段正文、结尾互动引导、8-12 个话题标签。',
      en: 'Use the content-xiaohongshu skill to write a Xiaohongshu note. Topic/product: {{topic}}. Highlights: {{points}}. Persona/style: {{persona}}. Deliver 2 style variants: emoji hook title, snackable paragraphs, an engagement CTA and 8-12 hashtags.',
    },
    fields: [
      { key: 'topic', kind: 'text', required: true, label: { zh: '主题/产品', en: 'Topic/product' }, placeholder: { zh: '例如：便携咖啡杯测评', en: 'e.g. portable coffee cup review' } },
      { key: 'points', kind: 'textarea', required: false, label: { zh: '亮点/卖点（可选）', en: 'Highlights (optional)' }, placeholder: { zh: '一行一个，留空由 AI 设计角度', en: 'One per line; leave empty to let AI decide' } },
      { key: 'persona', kind: 'text', required: false, label: { zh: '人设/风格（可选）', en: 'Persona (optional)' }, placeholder: { zh: '例如：学生党 / 职场人 / 专业博主', en: 'e.g. student / office worker / pro blogger' } },
    ],
  },
  {
    id: 'content-video-script',
    icon: '🎬',
    title: { zh: '短视频口播脚本', en: 'Short-video script' },
    desc: { zh: '3 秒钩子分镜表，默认 60 秒', en: '3s-hook storyboard, 60s default' },
    agentId: CONTENT_AGENT_ID,
    promptTemplate: {
      zh: '请使用 content-video-script 技能帮我写短视频口播脚本。主题：{{topic}}。时长：{{duration}}。发布平台：{{platform}}。输出时间轴/画面/台词三列分镜表，按黄金 3 秒钩子→痛点/冲突→干货/反转→行动号召的结构。',
      en: 'Use the content-video-script skill to write a short-video spoken script. Topic: {{topic}}. Duration: {{duration}}. Platform: {{platform}}. Output a timeline/visual/line storyboard table structured as 3s hook → pain/conflict → payoff/twist → CTA.',
    },
    fields: [
      { key: 'topic', kind: 'text', required: true, label: { zh: '主题', en: 'Topic' }, placeholder: { zh: '例如：3 个让厨房不乱的收纳技巧', en: 'e.g. 3 kitchen storage tricks' } },
      { key: 'duration', kind: 'text', required: false, label: { zh: '时长（可选，默认 60 秒）', en: 'Duration (optional, 60s default)' }, placeholder: { zh: '例如：30 秒 / 90 秒', en: 'e.g. 30s / 90s' } },
      { key: 'platform', kind: 'text', required: false, label: { zh: '发布平台（可选）', en: 'Platform (optional)' }, placeholder: { zh: '抖音 / 视频号 / B站', en: 'Douyin / Channels / Bilibili' } },
    ],
  },
  {
    id: 'content-calendar',
    icon: '🗓️',
    title: { zh: '选题规划/内容日历', en: 'Content calendar' },
    desc: { zh: '按行业平台排一周/一月选题表', en: 'Weekly/monthly topic schedule' },
    agentId: CONTENT_AGENT_ID,
    schedulable: true,
    promptTemplate: {
      zh: '请使用 content-calendar 技能帮我做选题排期。行业/账号定位：{{industry}}。发布平台：{{platforms}}。周期：{{period}}。输出日期/平台/选题/形式/钩子五列 Markdown 排期表，并标注可蹭热点位。',
      en: 'Use the content-calendar skill to plan my content schedule. Industry/positioning: {{industry}}. Platforms: {{platforms}}. Period: {{period}}. Output a date/platform/topic/format/hook Markdown table with trend-jacking slots marked.',
    },
    fields: [
      { key: 'industry', kind: 'text', required: true, label: { zh: '行业/账号定位', en: 'Industry/positioning' }, placeholder: { zh: '例如：家常美食号 / 母婴好物分享', en: 'e.g. home cooking / baby products' } },
      { key: 'platforms', kind: 'text', required: true, label: { zh: '发布平台', en: 'Platforms' }, placeholder: { zh: '例如：小红书+抖音', en: 'e.g. Xiaohongshu + Douyin' } },
      { key: 'period', kind: 'text', required: false, label: { zh: '周期（可选，默认一周）', en: 'Period (optional, 1 week default)' }, placeholder: { zh: '一周 / 一月', en: '1 week / 1 month' } },
    ],
  },
]
