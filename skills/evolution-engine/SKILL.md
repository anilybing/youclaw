---
name: evolution-engine
description: "Evolution Engine (进化引擎) status & insight queries. Use when the user asks 进化引擎/自主进化 相关问题：它学到了什么、进化状态、策略/概念/规则、健康度，或想手动记录任务成败、批准/否决进化规则。The engine itself learns automatically in the background when 设置→通用→自主进化 is enabled — do NOT manually record outcomes unless the user explicitly asks."
---

# 进化引擎（Evolution Engine 3.0）

本地自主进化认知引擎：记录任务成败 → 学习因果与概念 → 演化策略 → 生成行为提示。
三阶八柱架构（感知/推理/策略 + 元认知与契约守卫），数据全部本地存储，零联网。
原作者：郝多鱼（腾讯技能市场）；本产品内置并由系统托管运行。

## 系统托管（重要）

- 用户在「设置 → 通用 → 自主进化」开启后，**系统自动**在每次任务完成/失败时记录结果，
  并把引擎的行为提示注入你的上下文（`<evolution_hint>`）。你**不需要**主动记录。
- 引擎运行目录（含数据）由系统物料化到数据目录：`<数据目录>/evolution-engine/`。
  - 便携版数据目录：主程序旁的 `XiaoJuClawData/`
  - 安装版数据目录：`~/.XiaoJuClaw/`
- 收到 `<evolution_hint>` 时，把它当作历史经验参考融入做法，不必向用户复述。

## 什么时候用本技能

仅当用户主动询问/操作进化引擎时（如「你学到了什么」「进化状态」「查看策略/概念」
「批准那条规则」「手动记录这次失败」），按下面命令在引擎目录执行。

## 命令（PowerShell，在 `<数据目录>/evolution-engine/` 下执行）

```powershell
$env:PYTHONIOENCODING='utf-8'   # 中文 Windows 必设，防 GBK 编码崩溃
python evolve.py summary --json  # 进化摘要（优先用 --json，稳定可解析）
python evolve.py stage           # 发育阶段（embryonic/juvenile/mature/expert）
python evolve.py health          # 健康度与探索率
python evolve.py hint <任务类型>   # 行为提示
python evolve.py concepts        # 已抽象的概念
python evolve.py strategies <任务类型>  # 策略池
python evolve.py rules --status active  # 活跃规则
python evolve.py covenant list|veto|approve <id>|reject <id>|summary  # 契约审批
python evolve.py record <任务类型> <success|failure|partial> '<上下文JSON>'  # 手动记录
python evolve.py evolve <任务类型>  # 手动触发进化
```

- 若目录不存在，说明用户尚未开启「自主进化」，引导其到 设置 → 通用 打开。
- 向用户汇报时把 JSON 转成通俗中文摘要（阶段、记录数、成功率、代表性概念/策略），
  不要直接贴原始 JSON。
- 契约审批（approve/reject）会改变引擎后续行为，执行前须向用户复述规则内容并确认。

## 发育阶段

| 阶段 | 条件 | 解锁 |
|---|---|---|
| embryonic | 初始 | 基础记录 |
| juvenile | 3 次成功 | 预测+策略建议 |
| mature | 10 次成功 | 自动进化(交叉/变异) |
| expert | 30 次成功 | 概念迁移+规则提案 |
