#!/usr/bin/env python3
"""
Evolution Engine 3.0 CLI 统一入口
三阶八柱架构 - 记录→推理→策略→守卫

用法:
    python evolve.py record <task_type> <result> '<context_json>'
    python evolve.py hint [task_type]
    python evolve.py summary
    python evolve.py stage
    python evolve.py concepts
    python evolve.py strategies [task_type]
    python evolve.py rules [--status active]
    python evolve.py covenant <action> [rule_id]
    python evolve.py evolve [task_type]
"""

import sys
import json
import argparse
from typing import Optional

# [XJC] 中文 Windows 控制台默认 GBK，人类可读输出含 emoji 会 UnicodeEncodeError 崩溃；
# 强制 stdout/stderr UTF-8（Python 3.7+），失败静默回退。
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

sys.path.insert(0, __file__.rsplit("/", 1)[0] if "/" in __file__ else ".")

from engine import (
    init_engine, flush_all,
    get_sensor, get_world_model, get_causal_reasoning,
    get_symbolic_reasoning, get_concept, get_evo_devo,
    get_metacognitive, get_covenant, get_signal_path,
    __version__
)

# ================================================================
# CLI 命令分为两类:
#   写入命令 — 必须先 init_engine() 注册所有信号订阅者，
#              操作完成后 flush_all() 持久化全部模块
#   只读命令 — 按需获取模块即可（从磁盘加载持久化数据）
# ================================================================

WRITE_COMMANDS = {"record", "evolve", "covenant"}


def cmd_record(args):
    """
    记录任务结果 — 写入命令

    关键: 必须初始化全引擎，否则信号脉冲无人接收！
    修复前: 只 get_sensor() → observation 信号丢失
    修复后: init_engine() → 全部模块订阅信号 → flush_all()
    """
    sensor = get_sensor()
    result = sensor.record(
        task_type=args.task_type,
        result=args.result,
        context=json.loads(args.context) if args.context else {}
    )
    print(json.dumps(result, indent=2, ensure_ascii=False))


def cmd_hint(args):
    """获取行为提示"""
    wm = get_world_model()
    hint = wm.get_hint(args.task_type or "general")
    print(hint)


def cmd_summary(args):
    """查看进化摘要"""
    sensor = get_sensor()
    wm = get_world_model()
    causal = get_causal_reasoning()
    symbolic = get_symbolic_reasoning()
    concept = get_concept()
    evo = get_evo_devo()
    meta = get_metacognitive()
    covenant = get_covenant()
    signal = get_signal_path()

    if args.json:
        summary = {
            "version": __version__,
            "sensor": sensor.get_summary(),
            "world_model": wm.get_summary(),
            "causal": causal.get_summary(),
            "symbolic": symbolic.get_summary(),
            "concept": concept.get_summary(),
            "evo_devo": evo.get_summary(),
            "metacognitive": meta.get_summary(),
            "covenant": covenant.get_summary(),
            "signal": signal.get_summary()
        }
        print(json.dumps(summary, indent=2, ensure_ascii=False))
    else:
        _print_human_summary(sensor, wm, causal, symbolic, concept, evo, meta, covenant, signal)


def cmd_stage(args):
    """查看发育阶段"""
    evo = get_evo_devo()
    stage = evo.get_stage()
    summary = evo.get_summary()
    print(f"当前阶段: {stage}")
    print(f"总成功数: {summary.get('total_successes', 0)}")
    print(f"策略数量: {summary.get('active_strategies', 0)}")
    print(f"下一代阈值: {summary.get('next_stage_threshold', '?')}")


def cmd_concepts(args):
    """查看概念"""
    concept = get_concept()
    concepts = concept.get_concepts()
    if not concepts:
        print("暂无概念")
        return
    for c in concepts[:10]:
        print(f"[{c.get('concept_id', '?')[:8]}] {c.get('name', '?')} "
              f"(置信度: {c.get('confidence', 0):.2f}, 样本: {c.get('example_count', 0)})")


def cmd_strategies(args):
    """查看策略"""
    evo = get_evo_devo()
    strategies = evo.get_strategies(args.task_type)
    if not strategies:
        print("暂无策略")
        return
    for s in strategies[:10]:
        print(f"[{s.get('strategy_id', '?')[:8]}] {s.get('task_type', '?')} "
              f"权重: {s.get('weight', 0):.2f} 来源: {s.get('origin', '?')} "
              f"成功/失败: {s.get('success_count', 0)}/{s.get('failure_count', 0)}")


def cmd_rules(args):
    """查看规则"""
    covenant = get_covenant()
    rules = covenant.get_rules(status=args.status)
    if not rules:
        print("暂无规则")
        return
    for r in rules[:15]:
        status_icon = {"active": "✓", "suspended": "⏸", "retired": "✗", "vetoed": "⛔"}.get(r.get("status", ""), "?")
        print(f"{status_icon} [{r.get('rule_id', '?')[:8]}] "
              f"优先级: {r.get('priority', 0)} 来源: {r.get('source', '?')}")


def cmd_covenant(args):
    """
    契约管理 — 写入命令 (approve/reject 会修改状态)
    """
    covenant = get_covenant()
    if args.action == "list":
        covenants = covenant.get_covenants(limit=args.limit or 20)
        if not covenants:
            print("暂无契约记录")
            return
        for c in covenants:
            icon = "✓" if c["status"] == "active" else ("↩" if c["status"] == "rolled_back" else "✗")
            print(f"{icon} [{c['covenant_id']}] {c.get('trigger', '?')} - {c['status']}")
    elif args.action == "veto":
        queue = covenant.get_veto_queue()
        suspended = [v for v in queue if v["status"] == "suspended"]
        if not suspended:
            print("否决队列为空")
            return
        for v in suspended:
            print(f"⏸ [{v['rule_id'][:8]}] 原因: {v.get('reason', '?')}")
    elif args.action == "approve":
        if not args.rule_id:
            print("请指定 rule_id")
            return
        if covenant.approve_vetoed_rule(args.rule_id):
            print(f"规则 {args.rule_id} 已批准")
        else:
            print(f"批准失败")
    elif args.action == "reject":
        if not args.rule_id:
            print("请指定 rule_id")
            return
        if covenant.reject_vetoed_rule(args.rule_id):
            print(f"规则 {args.rule_id} 已否决")
        else:
            print(f"否决失败")
    elif args.action == "summary":
        print(json.dumps(covenant.get_summary(), indent=2, ensure_ascii=False))
    else:
        print(f"未知操作: {args.action}")
        print("可用: list, veto, approve, reject, summary")


def cmd_evolve(args):
    """
    手动触发进化 — 写入命令

    evolve 产生的 strategy_proposed 信号需要 covenant 订阅，
    所以也必须初始化全引擎。
    """
    evo = get_evo_devo()
    results = evo.evolve(args.task_type or None)
    if not results:
        print("无需进化")
        return
    for r in results:
        print(f"[{r.get('strategy_id', '?')[:8]}] {r.get('task_type', '?')} "
              f"来源: {r.get('origin', '?')}")


def cmd_health(args):
    """查看系统健康度"""
    meta = get_metacognitive()
    health = meta.get_health_score()
    exploration = meta.get_exploration_rate()
    summary = meta.get_summary()
    print(f"健康度: {health:.2f}")
    print(f"探索率: {exploration:.2f}")
    print(f"停滞计数: {summary.get('stagnation_count', 0)}")
    print(f"调整次数: {summary.get('total_adjustments', 0)}")


def _print_human_summary(sensor, wm, causal, symbolic, concept, evo, meta, covenant, signal):
    """打印人类可读摘要"""
    print("=" * 55)
    print(f"  Evolution Engine v{__version__} — 三阶八柱")
    print("=" * 55)

    s = sensor.get_summary()
    print(f"\n📡 感知器: {s['records_count']}条记录, "
          f"成功{s['total_success']}/失败{s['total_failure']}, "
          f"威胁模式{s['failure_patterns']}个")

    w = wm.get_summary()
    print(f"🌍 世界模型: {w['states_count']}状态, "
          f"{w['transitions_count']}转移, "
          f"平均置信度{w['avg_confidence']:.2f}")

    c = causal.get_summary()
    print(f"🔗 因果推理: {c['node_count']}节点, "
          f"{c['edge_count']}因果边")

    sym = symbolic.get_summary()
    print(f"⚖️ 符号推理: {sym['rules_count']}规则, "
          f"验证{sym['total_verifications']}次, "
          f"阻断危险{sym['blocked_dangerous']}次")

    con = concept.get_summary()
    print(f"💡 概念形成: {con['active_concepts']}概念, "
          f"{con['active_clusters']}聚类, "
          f"迁移命中{con['transfer_hits']}次")

    e = evo.get_summary()
    print(f"🧬 演化发育: 阶段[{e.get('stage', '?')}], "
          f"{e.get('active_strategies', 0)}策略, "
          f"成功{e.get('total_successes', 0)}次")

    m = meta.get_summary()
    print(f"🧠 元认知: 健康度{m['health_score']:.2f}, "
          f"探索率{m['exploration_rate']:.2f}")

    cov = covenant.get_summary()
    print(f"🔐 约束契约: {cov['active_rules']}活跃规则, "
          f"{cov['total_vetoed']}次否决, "
          f"{cov['backup_count']}份备份")

    sig = signal.get_summary()
    print(f"⚡ 信号通路: {sig['active_modules']}活跃模块, "
          f"{sig['total_emits']}脉冲, "
          f"节流{sig['throttled_emits']}次")

    print("\n" + "=" * 55)


def main():
    parser = argparse.ArgumentParser(
        description="Evolution Engine 3.0 CLI - 三阶八柱进化引擎",
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--version", action="version", version=f"Evolution Engine {__version__}")
    parser.add_argument("--json", action="store_true", help="输出JSON格式")

    sub = parser.add_subparsers(dest="command", help="可用命令")

    # record
    p = sub.add_parser("record", help="记录任务结果")
    p.add_argument("task_type", help="任务类型")
    p.add_argument("result", help="结果 (success/failure/partial)")
    p.add_argument("context", nargs="?", default="{}", help="上下文JSON")

    # hint
    p = sub.add_parser("hint", help="获取行为提示")
    p.add_argument("task_type", nargs="?", help="任务类型")

    # summary
    p = sub.add_parser("summary", help="查看进化摘要")
    p.add_argument("--json", action="store_true", help="输出JSON格式")

    # stage
    sub.add_parser("stage", help="查看发育阶段")

    # concepts
    sub.add_parser("concepts", help="查看概念")

    # strategies
    p = sub.add_parser("strategies", help="查看策略")
    p.add_argument("task_type", nargs="?", help="任务类型")

    # rules
    p = sub.add_parser("rules", help="查看规则")
    p.add_argument("--status", help="过滤状态 (active/suspended/retired)")

    # covenant
    p = sub.add_parser("covenant", help="契约管理")
    p.add_argument("action", choices=["list", "veto", "approve", "reject", "summary"])
    p.add_argument("rule_id", nargs="?", help="规则ID")
    p.add_argument("--limit", type=int, default=20)

    # evolve
    p = sub.add_parser("evolve", help="手动触发进化")
    p.add_argument("task_type", nargs="?", help="任务类型")

    # health
    sub.add_parser("health", help="查看系统健康度")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(0)  # 无命令不是错误，退出码 0

    # ================================================================
    # 关键修复: 写入命令必须初始化全引擎 + 操作后 flush_all
    #
    # 问题根因:
    #   CLI 每个命令是独立进程，信号在进程内同步传递。
    #   如果只初始化 sensor，observation 脉冲无人订阅，
    #   world_model / causal / evo_devo 等模块的状态永远不更新。
    #   进程退出后，内存中已更新的状态全部丢失。
    #
    # 修复方案:
    #   1. 写入命令执行前 init_engine() — 确保所有信号订阅者已注册
    #   2. 写入命令执行后 flush_all() — 强制所有模块持久化到磁盘
    #   3. 只读命令无需 init_engine，按需加载即可
    # ================================================================
    is_write = args.command in WRITE_COMMANDS

    if is_write:
        init_engine()

    commands = {
        "record": cmd_record, "hint": cmd_hint, "summary": cmd_summary,
        "stage": cmd_stage, "concepts": cmd_concepts, "strategies": cmd_strategies,
        "rules": cmd_rules, "covenant": cmd_covenant, "evolve": cmd_evolve,
        "health": cmd_health,
    }
    fn = commands.get(args.command)
    if fn:
        fn(args)

    if is_write:
        flush_all()


if __name__ == "__main__":
    main()
