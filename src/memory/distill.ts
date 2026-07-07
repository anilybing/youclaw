// [XJC-PATCH] T-G1 记忆自动蒸馏：蒸馏 prompt 构造（clean-room 自研）
//
// 两个 prompt 由 distill-scheduler 种子进 scheduled_tasks，到点经 agent runtime
// 以任务形式执行——agent 在自己的工作区（agents/<id>/）内用文件工具完成读写，
// 不新增任何 LLM 调用层。
//
// [G3-HOOK] 蒸馏任务未来应消费 T-G3 的模型路由 hint（hint:memory）走低价模型；
// 本期经 runtime 用 agent 默认模型执行，不在此实现路由。

/** 当日纪要幂等标记前缀，完整形如 `<!-- distilled:2026-07-07 -->` */
export const DAILY_DISTILL_MARKER_PREFIX = '<!-- distilled:'

/** 周蒸馏幂等标记前缀，完整形如 `<!-- weekly-distilled:2026-W28 -->` */
export const WEEKLY_DISTILL_MARKER_PREFIX = '<!-- weekly-distilled:'

/**
 * 每日纪要蒸馏 prompt：读当日 memory/YYYY-MM-DD.md 与 memory/logs/ 当日日志，
 * 在当日文件头部写入 ≤500 token 的「当日纪要」段，幂等标记开头。
 */
export function buildDailyDistillPrompt(): string {
  return `\
【系统任务：每日记忆蒸馏】请严格按以下步骤操作，全程只使用文件读写工具，不要执行其他动作。

1. 取今天的日期（本地时区，格式 YYYY-MM-DD，下文记作 <日期>）。
2. 幂等检查：读取工作区文件 memory/<日期>.md（当日记忆文件）。
   - 若文件开头已存在标记 \`${DAILY_DISTILL_MARKER_PREFIX}<日期> -->\`，说明今天已蒸馏过：直接回复「今日已蒸馏，跳过」并结束，禁止重复写入。
3. 收集素材：
   - memory/<日期>.md 的现有内容（若存在）；
   - memory/logs/<日期>.md 当日会话日志（若存在；logs 目录是只读的，禁止修改其中任何文件）。
   - 若两者都不存在或内容为空：回复「今日无记忆可蒸馏」并结束，不要创建空文件。
4. 蒸馏：把素材整理成一段「当日纪要」，总长度不超过 500 token，用 Markdown 列表分三类：
   - **关键事实**：今天新获知的稳定信息（人物/项目/环境等）
   - **决定**：今天做出的决定与结论
   - **待办**：明确提到但尚未完成的事项
   空类可省略。
5. 写入：把下面这个片段插入到 memory/<日期>.md 的最顶部（原有内容完整保留在其后；文件不存在则新建）：

${DAILY_DISTILL_MARKER_PREFIX}<日期> -->
## 当日纪要（<日期>）
…（第 4 步的列表）…

红线（必须遵守）：
- 只整理素材中已有的信息，禁止虚构、推测或补全任何事实；
- 纪要一律用列表，不写成段落长文；
- 禁止把密码、API Key、token 等敏感凭据写进纪要；
- 除 memory/<日期>.md 外不修改任何文件。

完成后只回复一行结果摘要（如「已写入 <日期> 当日纪要：事实 3 条 / 决定 1 条 / 待办 2 条」）。`
}

/**
 * 每周长期记忆蒸馏 prompt：读最近 7 天的当日纪要，把稳定信息蒸馏进 MEMORY.md
 * 对应分区，末尾维护周幂等标记。
 */
export function buildWeeklyDistillPrompt(): string {
  return `\
【系统任务：每周长期记忆蒸馏】请严格按以下步骤操作，全程只使用文件读写工具，不要执行其他动作。

1. 取本周编号（ISO 8601，周一为一周之始，格式 YYYY-Www，如 2026-W28，下文记作 <周>）。
2. 幂等检查：读取工作区文件 MEMORY.md（长期记忆）。
   - 若文件末尾已存在标记 \`${WEEKLY_DISTILL_MARKER_PREFIX}<周> -->\`，说明本周已蒸馏过：直接回复「本周已蒸馏，跳过」并结束，禁止重复写入。
3. 收集素材：读取最近 7 天（含今天）的 memory/YYYY-MM-DD.md，优先取各文件中的「当日纪要」段；某天没有纪要段就浏览该文件正文要点；一天文件都没有则回复「近 7 天无记忆可蒸馏」，但仍执行第 6 步更新标记后结束。
4. 蒸馏：从素材中挑出值得长期保留的内容——
   - 稳定事实（用户身份/环境/长期约定）→ 归入 Profile 或 Notes；
   - 偏好与习惯 → 归入 Preferences；
   - 例行日程 → 归入 Schedule；人物关系 → 归入 Relationships；
   - 项目进展 → 归入 Projects（同一项目的多天流水折叠成一句话现状，已完成或过期的事项合并为一句结论，不逐日罗列）。
5. 写入：把蒸馏结果**追加**到 MEMORY.md 对应的二级分区（## Profile / ## Schedule / ## Preferences / ## Relationships / ## Projects / ## Notes）：
   - 每条一行列表项；写入前先通读该分区，已有等价条目就不再重复写（去重）；
   - 与既有条目冲突时保留新信息并删掉过时条目；
   - 不改动分区标题结构，不触碰无关内容。
6. 维护标记：删除 MEMORY.md 中旧的 \`${WEEKLY_DISTILL_MARKER_PREFIX}… -->\` 标记（若有），在文件末尾写入一行 \`${WEEKLY_DISTILL_MARKER_PREFIX}<周> -->\`。

红线（必须遵守）：
- 只整理已有信息，禁止虚构、推测或补全任何事实；
- 禁止把密码、API Key、token 等敏感凭据写进长期记忆；
- 只修改 MEMORY.md，不改动每日记忆文件与 logs。

完成后只回复一行结果摘要（如「本周蒸馏完成：Projects +2 / Preferences +1」）。`
}
