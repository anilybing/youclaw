"""
Evolution Engine 3.0 符号推理 (推理层)
快直觉+慢逻辑的双轨审校机制

上游: 接收世界模型的 "prediction" 脉冲
下游: 发射 "verified_fact" 脉冲给概念形成
功能: 快直觉+慢逻辑的双轨审校

信令契约:
  subscribe("prediction")    ← world_model
  emit("verified_fact")      → 概念形成
"""

import time
import hashlib
import json
import re
from typing import Dict, Any, List, Optional
from collections import defaultdict
from datetime import datetime

from .config import get_config
from .signal_path import get_signal_path, Spike
from .persistence import get_persistence


# ================================================================
# 危险模式库 - 硬约束阻断
# ================================================================

_DANGEROUS_PATTERNS = [
    r"\brm\s+-rf\s+/",
    r"\brm\s+-rf\s+~",
    r"\brm\s+-rf\s+\*",
    r"\bDROP\s+TABLE",
    r"\bDELETE\s+FROM\s+\w+\s*;?\s*$",
    r"\bformat\s+[C-Zc-z]:",
    r"\bshutdown\s",
    r"\breboot\s",
    r"\bdd\s+if=.*of=/dev/",
    r"\b:()\s*\{.*;\s*\}",         # bash fork bomb
    r"\bsudo\s+rm\s",
    r"\bchmod\s+777\s+/",
    r"\bchown\s+.*\s+/",
    r"\bmkfs\b",
    r"\b>:>\s*/dev/sd",            # 覆写磁盘
]

# 编译正则表达式（只编译一次）
_DANGEROUS_COMPILED = [re.compile(p, re.IGNORECASE) for p in _DANGEROUS_PATTERNS]


# ================================================================
# 规则ID生成
# ================================================================

def _rule_id(condition: Dict, consequence: Dict) -> str:
    """
    生成规则的唯一标识 (12字符十六进制)
    基于条件和结论的哈希
    """
    canonical = json.dumps({"c": condition, "e": consequence}, sort_keys=True, default=str)
    return hashlib.md5(canonical.encode()).hexdigest()[:12]


# ================================================================
# 符号推理核心
# ================================================================

class SymbolicReasoning:
    """
    符号推理 - 推理层核心模块

    职责:
    1. 管理符号规则库 (条件 → 结论)
    2. 验证神经提案的硬约束 (概率钳位、危险模式阻断、自相矛盾检查)
    3. 前向链式推理 (事实 → 推论)
    4. 冲突消解 (更具体的规则优先)

    双轨审校:
    - 快直觉: 规则匹配的直接判定 (O(n)扫描)
    - 慢逻辑: 前向链式推理 + 矛盾检测 (多轮推导)
    """

    VERSION = "3.0.0"

    def __init__(self, config=None, signal_path=None, persistence=None):
        self.config = config or get_config()
        self.signal = signal_path or get_signal_path()
        self.persistence = persistence or get_persistence()
        self.persistence.register("symbolic")

        # 读取配置
        cfg = self.config.get_module_config("symbolic")
        self.max_rules = cfg.get("max_rules", 200)
        self.verification_strictness = cfg.get("verification_strictness", 0.8)

        # === 核心数据结构: 规则库 ===
        # rule_id → {condition, consequence, priority, fires_count, created_at}
        self._rules: Dict[str, Dict] = {}

        # 规则插入顺序（用于FIFO冲突消解的二级排序）
        self._rule_order: List[str] = []

        # 统计
        self._total_verifications = 0
        self._total_deductions = 0
        self._total_conflicts_resolved = 0
        self._blocked_dangerous = 0
        self._facts_emitted = 0

        # 订阅 prediction 脉冲
        self.signal.subscribe("prediction", self._on_prediction)

        # 注册到信号通路
        self.signal.register_module("symbolic", {"type": "reasoning"})

        # 加载持久化数据
        self._load_state()

    # ================================================================
    # 脉冲处理
    # ================================================================

    def _on_prediction(self, spike: Spike):
        """
        处理世界模型的 prediction 脉冲
        对预测结果进行符号验证，通过则发射 verified_fact
        格式: {task_type, source_state, predictions, confidence}
        """
        pattern = spike.pattern
        predictions = pattern.get("predictions", [])
        confidence = pattern.get("confidence", 0.0)

        # 快直觉: 验证每条预测
        for pred in predictions:
            # 将预测构造成待验证的提案
            proposal = {
                "type": "prediction",
                "task_type": pattern.get("task_type", "unknown"),
                "action": pred.get("action", "unknown"),
                "confidence": pred.get("confidence", confidence),
                "prob": pred.get("prob", 0.0),
                "avg_reward": pred.get("avg_reward", 0.0)
            }

            # 验证
            result = self.verify(proposal, {"source": "world_model", "spike_strength": spike.strength})

            if result["valid"]:
                # 验证通过 → 发射 verified_fact
                self.signal.emit("symbolic", "verified_fact", {
                    "fact": proposal,
                    "confidence": result["confidence"],
                    "verified_by": "symbolic_reasoning",
                    "corrections": result.get("corrections", [])
                }, strength=min(1.0, result["confidence"]))
                self._facts_emitted += 1

        # 定期持久化
        if self._total_verifications % 10 == 0:
            self._save_state()

    # ================================================================
    # 规则管理
    # ================================================================

    def add_rule(self, condition: Dict, consequence: Dict, priority: float = 1.0) -> str:
        """
        添加符号规则

        condition: 触发条件 {key: value, ...}，value可为具体值或比较表达式
        consequence: 触发后的结论 {key: value, ...}
        priority: 优先级 [0, ∞)，默认1.0

        返回: rule_id
        """
        rid = _rule_id(condition, consequence)

        # 检查规则数量上限
        if rid not in self._rules and len(self._rules) >= self.max_rules:
            # 淘汰触发次数最少的规则
            self._evict_weakest_rule()

        self._rules[rid] = {
            "condition": condition,
            "consequence": consequence,
            "priority": priority,
            "fires_count": 0,
            "created_at": time.time()
        }

        # 维护插入顺序
        if rid not in self._rule_order:
            self._rule_order.append(rid)

        self._save_state()
        return rid

    def _evict_weakest_rule(self):
        """淘汰触发次数最少的规则（FIFO打破平局）"""
        if not self._rules:
            return

        # 按触发次数升序，同次数按插入顺序（先入先出）
        min_fires = min(r["fires_count"] for r in self._rules.values())
        candidates = [
            rid for rid in self._rule_order
            if rid in self._rules and self._rules[rid]["fires_count"] == min_fires
        ]

        if candidates:
            evict_id = candidates[0]
            self._rules.pop(evict_id, None)
            self._rule_order.remove(evict_id)

    def _match_condition(self, condition: Dict, facts: Dict) -> bool:
        """
        检查事实是否匹配规则条件
        支持精确匹配和比较表达式:
        - 精确匹配: {"status": "active"} → facts["status"] == "active"
        - 比较表达式: {"confidence": ">=0.5"} → facts["confidence"] >= 0.5
        - 存在性检查: {"error": "*"} → "error" in facts
        """
        for key, expected in condition.items():
            if key not in facts:
                return False

            actual = facts[key]

            # 通配符：只要key存在就匹配
            if expected == "*":
                continue

            # 比较表达式: >=, <=, >, <, !=
            if isinstance(expected, str) and len(expected) > 2:
                for op in [">=", "<=", "!=", ">", "<"]:
                    if expected.startswith(op):
                        try:
                            threshold = float(expected[len(op):])
                            actual_num = float(actual)
                            if op == ">=" and not (actual_num >= threshold):
                                return False
                            elif op == "<=" and not (actual_num <= threshold):
                                return False
                            elif op == ">" and not (actual_num > threshold):
                                return False
                            elif op == "<" and not (actual_num < threshold):
                                return False
                            elif op == "!=" and not (actual_num != threshold):
                                return False
                            break
                        except (TypeError, ValueError):
                            return False

            # 精确匹配
            elif actual != expected:
                return False

        return True

    # ================================================================
    # 验证 (快直觉 + 慢逻辑)
    # ================================================================

    def verify(self, proposal: Dict, context: Dict) -> Dict:
        """
        验证神经提案的硬约束

        快直觉 (即时检查):
        1. 概率钳位: 所有概率值必须在 [0, 1]
        2. 危险模式阻断: rm -rf, DROP TABLE 等
        3. 自相矛盾检查: 提案内部是否存在逻辑矛盾

        慢逻辑 (规则匹配):
        4. 匹配规则库中的约束规则
        5. 汇总违反项和修正建议

        返回: {valid: bool, confidence: float, violations: List, corrections: List}
        """
        self._total_verifications += 1

        violations = []
        corrections = []
        confidence = 1.0  # 初始完美置信度，每发现一个违反项衰减

        # === 快直觉1: 概率钳位 ===
        prob_issues = self._check_probability_clamp(proposal)
        if prob_issues["violations"]:
            violations.extend(prob_issues["violations"])
            corrections.extend(prob_issues["corrections"])
            confidence *= 0.5  # 概率越界严重降权

        # === 快直觉2: 危险模式阻断 ===
        danger_issues = self._check_dangerous_patterns(proposal)
        if danger_issues["violations"]:
            violations.extend(danger_issues["violations"])
            corrections.extend(danger_issues["corrections"])
            confidence *= 0.1  # 危险模式极严重降权
            self._blocked_dangerous += 1

        # === 快直觉3: 自相矛盾检查 ===
        contradiction_issues = self._check_contradictions(proposal)
        if contradiction_issues["violations"]:
            violations.extend(contradiction_issues["violations"])
            corrections.extend(contradiction_issues["corrections"])
            confidence *= 0.3  # 矛盾严重降权

        # === 慢逻辑: 规则匹配验证 ===
        rule_issues = self._check_rules(proposal, context)
        if rule_issues["violations"]:
            violations.extend(rule_issues["violations"])
            corrections.extend(rule_issues["corrections"])
            confidence *= rule_issues["confidence_factor"]

        # 最终判定
        confidence = max(0.0, min(1.0, confidence))
        valid = confidence >= (1.0 - self.verification_strictness)

        return {
            "valid": valid,
            "confidence": round(confidence, 4),
            "violations": violations,
            "corrections": corrections
        }

    def _check_probability_clamp(self, proposal: Dict) -> Dict:
        """
        检查概率值是否在 [0, 1] 范围内
        扫描所有数值字段，识别概率型字段（名称含prob/confidence/likelihood等）
        """
        violations = []
        corrections = []
        prob_keywords = {"prob", "probability", "confidence", "likelihood", "certainty", "score"}

        for key, value in proposal.items():
            # 检查是否为概率型字段
            is_prob_field = any(kw in key.lower() for kw in prob_keywords)

            if is_prob_field and isinstance(value, (int, float)):
                if value < 0.0 or value > 1.0:
                    violations.append({
                        "type": "probability_out_of_bounds",
                        "field": key,
                        "value": value,
                        "expected": "[0, 1]"
                    })
                    clamped = max(0.0, min(1.0, value))
                    corrections.append({
                        "field": key,
                        "original": value,
                        "corrected": clamped,
                        "action": "clamp_to_[0,1]"
                    })

        return {"violations": violations, "corrections": corrections}

    def _check_dangerous_patterns(self, proposal: Dict) -> Dict:
        """
        检查提案中是否包含危险模式
        递归扫描所有字符串值字段（包括嵌套结构）
        """
        violations = []
        corrections = []

        def scan_recursive(obj, path=""):
            """递归扫描所有字符串值"""
            if isinstance(obj, str):
                for i, pattern in enumerate(_DANGEROUS_COMPILED):
                    if pattern.search(obj):
                        violations.append({
                            "type": "dangerous_pattern",
                            "field": path,
                            "pattern_index": i,
                            "value_preview": obj[:50]
                        })
                        corrections.append({
                            "field": path,
                            "action": "block",
                            "reason": f"匹配危险模式 #{i}"
                        })
            elif isinstance(obj, dict):
                for k, v in obj.items():
                    scan_recursive(v, f"{path}.{k}" if path else k)
            elif isinstance(obj, list):
                for idx, item in enumerate(obj):
                    scan_recursive(item, f"{path}[{idx}]")

        scan_recursive(proposal)
        return {"violations": violations, "corrections": corrections}

    def _check_contradictions(self, proposal: Dict) -> Dict:
        """
        检查提案内部是否存在自相矛盾
        矛盾类型:
        1. 同一字段出现互斥值 (success=True 且 success=False)
        2. 数值范围矛盾 (min > max)
        3. 状态矛盾 (status=active 且 status=error)
        """
        violations = []
        corrections = []

        # 类型1: 同一字段名不同后缀表示相反含义
        # 如 enabled=True 且 disabled=True
        opposite_pairs = [
            ("enabled", "disabled"),
            ("success", "failure"),
            ("valid", "invalid"),
            ("safe", "unsafe"),
            ("allowed", "denied"),
        ]

        for a, b in opposite_pairs:
            if a in proposal and b in proposal:
                if proposal[a] and proposal[b]:
                    # 两者同时为真 → 矛盾
                    violations.append({
                        "type": "contradiction",
                        "fields": [a, b],
                        "values": [proposal[a], proposal[b]],
                        "reason": f"'{a}' 和 '{b}' 不能同时为真"
                    })
                    corrections.append({
                        "action": "resolve_contradiction",
                        "suggestion": f"保留 '{a}'，移除 '{b}'"
                    })

        # 类型2: 数值范围矛盾
        min_max_pairs = [
            ("min", "max"), ("minimum", "maximum"),
            ("lower", "upper"), ("floor", "ceiling"),
        ]

        for min_key, max_key in min_max_pairs:
            if min_key in proposal and max_key in proposal:
                try:
                    min_val = float(proposal[min_key])
                    max_val = float(proposal[max_key])
                    if min_val > max_val:
                        violations.append({
                            "type": "range_contradiction",
                            "fields": [min_key, max_key],
                            "values": [min_val, max_val],
                            "reason": f"{min_key}({min_val}) > {max_key}({max_val})"
                        })
                        corrections.append({
                            "action": "swap_range",
                            "suggestion": f"交换 {min_key} 和 {max_key} 的值"
                        })
                except (TypeError, ValueError):
                    pass

        return {"violations": violations, "corrections": corrections}

    def _check_rules(self, proposal: Dict, context: Dict) -> Dict:
        """
        慢逻辑: 用规则库验证提案
        匹配条件的规则，检查结论是否被违反
        """
        violations = []
        corrections = []
        confidence_factor = 1.0

        # 合并提案和上下文作为事实集
        facts = {**context, **proposal}

        for rid, rule in self._rules.items():
            condition = rule["condition"]
            consequence = rule["consequence"]

            # 检查条件是否匹配
            if self._match_condition(condition, facts):
                rule["fires_count"] += 1

                # 检查结论是否与提案一致
                for key, expected in consequence.items():
                    actual = proposal.get(key)
                    if actual is not None and actual != expected:
                        # 结论被违反
                        violations.append({
                            "type": "rule_violation",
                            "rule_id": rid,
                            "field": key,
                            "expected": expected,
                            "actual": actual,
                            "rule_priority": rule["priority"]
                        })
                        corrections.append({
                            "field": key,
                            "action": "enforce_rule",
                            "rule_id": rid,
                            "corrected": expected
                        })
                        # 按规则优先级影响置信度
                        confidence_factor *= max(0.1, 1.0 - rule["priority"] * 0.2)

        return {
            "violations": violations,
            "corrections": corrections,
            "confidence_factor": max(0.0, confidence_factor)
        }

    # ================================================================
    # 前向链式推理
    # ================================================================

    def deduce(self, facts: Dict) -> List[Dict]:
        """
        前向链式推理: 从已知事实出发，匹配规则条件，产生新结论
        最多3轮推理（防止无限循环）

        算法:
        1. 将facts与所有规则条件匹配
        2. 匹配的规则产出结论
        3. 新结论加入事实集
        4. 重复，直到无新结论或达到最大轮数

        返回: [新推导出的事实, ...]
        """
        self._total_deductions += 1

        all_derived = []
        current_facts = facts.copy()
        max_rounds = 3

        for round_num in range(max_rounds):
            new_derived = []

            for rid, rule in self._rules.items():
                condition = rule["condition"]
                consequence = rule["consequence"]

                # 检查条件是否匹配
                if self._match_condition(condition, current_facts):
                    rule["fires_count"] += 1

                    # 产出结论中尚未包含在当前事实集的部分
                    for key, value in consequence.items():
                        if key not in current_facts or current_facts[key] != value:
                            new_derived.append({
                                "key": key,
                                "value": value,
                                "derived_from": rid,
                                "round": round_num + 1
                            })
                            current_facts[key] = value

            if not new_derived:
                break  # 无新结论，推理终止

            all_derived.extend(new_derived)

        # 验证推导结果，发射 verified_fact
        if all_derived:
            derived_dict = {d["key"]: d["value"] for d in all_derived}
            verification = self.verify(derived_dict, facts)
            if verification["valid"]:
                self.signal.emit("symbolic", "verified_fact", {
                    "fact": derived_dict,
                    "confidence": verification["confidence"],
                    "verified_by": "symbolic_deduction",
                    "derived_from": facts,
                    "corrections": verification.get("corrections", [])
                }, strength=min(1.0, verification["confidence"]))
                self._facts_emitted += 1

        self._save_state()
        return all_derived

    # ================================================================
    # 冲突消解
    # ================================================================

    def resolve_conflict(self, proposals: List[Dict]) -> Dict:
        """
        基于特异性的冲突消解

        规则: 更具体的规则（条件键数更多）优先
        如果特异性相同，按优先级降序
        如果仍相同，按触发次数升序（经验少的先让步）

        参数:
        proposals: [{rule_id, condition, consequence, priority, ...}, ...]

        返回: 获胜的提案
        """
        self._total_conflicts_resolved += 1

        if not proposals:
            return {}

        if len(proposals) == 1:
            return proposals[0]

        # 按特异性排序（条件键数多的更具体）
        def specificity(proposal: Dict) -> int:
            condition = proposal.get("condition", {})
            return len(condition)

        # 按优先级排序
        def priority_val(proposal: Dict) -> float:
            return proposal.get("priority", 1.0)

        # 按触发次数排序（少的让步）
        def fires_count(proposal: Dict) -> int:
            rid = proposal.get("rule_id", "")
            if rid in self._rules:
                return self._rules[rid].get("fires_count", 0)
            return 0

        # 多级排序: 特异性降序 → 优先级降序 → 触发次数升序
        sorted_proposals = sorted(
            proposals,
            key=lambda p: (-specificity(p), -priority_val(p), fires_count(p))
        )

        winner = sorted_proposals[0]

        self._save_state()
        return winner

    # ================================================================
    # 查询接口
    # ================================================================

    def get_rules(self) -> List[Dict]:
        """获取所有规则列表"""
        result = []
        for rid, rule in self._rules.items():
            result.append({
                "rule_id": rid,
                "condition": rule["condition"],
                "consequence": rule["consequence"],
                "priority": rule["priority"],
                "fires_count": rule["fires_count"],
                "created_at": rule.get("created_at", 0),
                "specificity": len(rule["condition"])
            })

        # 按特异性降序、优先级降序排列
        result.sort(key=lambda r: (-r["specificity"], -r["priority"]))
        return result

    def get_summary(self) -> Dict:
        """返回符号推理模块概要"""
        # 规则触发分布
        fire_counts = [r["fires_count"] for r in self._rules.values()]
        active_rules = sum(1 for c in fire_counts if c > 0)

        # 条件键数分布（特异性）
        specificities = [len(r["condition"]) for r in self._rules.values()]

        return {
            "version": self.VERSION,
            "rules_count": len(self._rules),
            "active_rules": active_rules,
            "max_rules": self.max_rules,
            "verification_strictness": self.verification_strictness,
            "total_verifications": self._total_verifications,
            "total_deductions": self._total_deductions,
            "total_conflicts_resolved": self._total_conflicts_resolved,
            "blocked_dangerous": self._blocked_dangerous,
            "facts_emitted": self._facts_emitted,
            "avg_specificity": round(
                sum(specificities) / max(1, len(specificities)), 2
            ),
            "avg_fires_per_rule": round(
                sum(fire_counts) / max(1, len(fire_counts)), 2
            )
        }

    # ================================================================
    # 持久化
    # ================================================================

    def _save_state(self):
        """持久化符号推理状态"""
        self.persistence.save("symbolic", {
            "rules": self._rules,
            "rule_order": self._rule_order,
            "total_verifications": self._total_verifications,
            "total_deductions": self._total_deductions,
            "total_conflicts_resolved": self._total_conflicts_resolved,
            "blocked_dangerous": self._blocked_dangerous,
            "facts_emitted": self._facts_emitted
        })

    def _load_state(self):
        """从持久化加载符号推理状态"""
        data = self.persistence.load("symbolic")
        if not data:
            return

        # 恢复规则库
        self._rules = data.get("rules", {})
        self._rule_order = data.get("rule_order", [])

        # 验证 rule_order 中的规则是否仍存在
        self._rule_order = [rid for rid in self._rule_order if rid in self._rules]

        # 恢复统计
        self._total_verifications = data.get("total_verifications", 0)
        self._total_deductions = data.get("total_deductions", 0)
        self._total_conflicts_resolved = data.get("total_conflicts_resolved", 0)
        self._blocked_dangerous = data.get("blocked_dangerous", 0)
        self._facts_emitted = data.get("facts_emitted", 0)


# ================================================================
# 单例
# ================================================================

_symbolic_reasoning = None


def get_symbolic_reasoning() -> SymbolicReasoning:
    """获取符号推理单例"""
    global _symbolic_reasoning
    if _symbolic_reasoning is None:
        _symbolic_reasoning = SymbolicReasoning()
    return _symbolic_reasoning
