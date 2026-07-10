"""
Evolution Engine 3.0 演化发育 (策略阶)
融合v2的策略池+变态发育+假设检验

上游: 接收 concept 的 "concept_formed" + causal 的 "causal_claim" + sensor 的 "observation"
下游: 发射 "strategy_proposed" 脉冲给 covenant

核心: 遗传算法精简版(选择+交叉+变异) + 发育阶段跃迁
"""

import time
import json
import hashlib
import random
from typing import Dict, Any, List, Optional
from collections import defaultdict

from .config import get_config
from .signal_path import get_signal_path, Spike
from .persistence import get_persistence


class EvoDevo:
    """演化发育 - 策略阶核心模块"""

    def __init__(self, config=None, signal_path=None, persistence=None):
        self.config = config or get_config()
        self.signal = signal_path or get_signal_path()
        self.persistence = persistence or get_persistence()
        self.persistence.register("evo_devo")

        cfg = self.config.get_module_config("evo_devo")
        self.population_size = cfg.get("population_size", 50)
        self.crossover_rate = cfg.get("crossover_rate", 0.5)
        self.mutation_rate = cfg.get("mutation_rate", 0.3)
        self.elite_ratio = cfg.get("elite_ratio", 0.2)
        self.max_strategies = cfg.get("max_strategies", 1000)
        self.weight_decay = cfg.get("weight_decay", 0.95)
        self.min_weight = cfg.get("min_weight", 0.1)
        self.stage_thresholds = cfg.get("stage_thresholds", [3, 10, 30])
        self.dev_stages = cfg.get("developmental_stages", ["embryonic", "juvenile", "mature", "expert"])

        # 策略种群: strategy_id → {content, task_type, weight, origin, generation, success_count, failure_count, created_at}
        self._strategies: Dict[str, Dict] = {}
        # 按task_type索引
        self._task_index: Dict[str, List[str]] = defaultdict(list)
        # 精英策略集合（避免污染策略数据）
        self._elite_ids: set = set()
        # 代数
        self._generation = 0
        # 全局成功/失败计数
        self._total_success = 0
        self._total_failure = 0
        # 统计
        self._evolutions_run = 0
        self._strategies_proposed = 0

        # 订阅信号
        self.signal.subscribe("concept_formed", self._on_concept_formed)
        self.signal.subscribe("causal_claim", self._on_causal_claim)
        self.signal.subscribe("observation", self._on_observation)
        self.signal.register_module("evo_devo", {"type": "strategic"})

        self._load_state()

    # ================================================================
    # 发育阶段
    # ================================================================

    def get_stage(self) -> str:
        """当前发育阶段，基于全局成功次数"""
        s = self._total_success
        for i, threshold in enumerate(self.stage_thresholds):
            if s < threshold:
                return self.dev_stages[i]
        return self.dev_stages[-1]

    def get_capabilities(self) -> List[str]:
        """当前阶段解锁的能力"""
        stage = self.get_stage()
        caps = ["record"]  # 最基础
        if stage in ("juvenile", "mature", "expert"):
            caps.extend(["predict", "suggest"])
        if stage in ("mature", "expert"):
            caps.extend(["evolve", "crossover", "mutate"])
        if stage == "expert":
            caps.extend(["transfer", "propose_rule"])
        return caps

    # ================================================================
    # 策略管理
    # ================================================================

    def add_strategy(self, task_type: str, content: str, weight: float = 0.5,
                     origin: str = "imported") -> str:
        """添加策略到种群"""
        sid = self._strategy_id(task_type, content)
        if sid in self._strategies:
            # 已存在则更新权重
            self._strategies[sid]["weight"] = max(self._strategies[sid]["weight"], weight)
            return sid

        # 超出上限则淘汰最弱
        if len(self._strategies) >= self.max_strategies:
            self._cull_weakest()

        self._strategies[sid] = {
            "content": content,
            "task_type": task_type,
            "weight": max(0.0, min(1.0, weight)),
            "origin": origin,
            "generation": self._generation,
            "success_count": 0,
            "failure_count": 0,
            "created_at": time.time()
        }
        self._task_index[task_type].append(sid)
        self._save_state()
        return sid

    def record_outcome(self, strategy_id: str, success: bool) -> Dict:
        """记录策略执行结果，更新权重"""
        if strategy_id not in self._strategies:
            return {"updated": False, "reason": "not_found"}

        s = self._strategies[strategy_id]
        if success:
            s["success_count"] += 1
            s["weight"] = min(1.0, s["weight"] + 0.05)
            self._total_success += 1
        else:
            s["failure_count"] += 1
            s["weight"] = max(0.0, s["weight"] - 0.1)
            self._total_failure += 1

        # 权重低于阈值则淘汰
        if s["weight"] < self.min_weight:
            self._remove_strategy(strategy_id)
            return {"updated": True, "culled": True}

        self._save_state()
        return {"updated": True, "new_weight": s["weight"]}

    def suggest_strategy(self, task_type: str, context: Dict = None) -> Optional[Dict]:
        """为任务推荐最佳策略"""
        candidates = self._get_candidates(task_type)
        if not candidates:
            return None

        # 按权重排序，取最高的
        candidates.sort(key=lambda sid: self._strategies[sid]["weight"], reverse=True)
        best_id = candidates[0]
        s = self._strategies[best_id]
        return {"strategy_id": best_id, "content": s["content"],
                "weight": s["weight"], "task_type": s["task_type"]}

    def get_strategies(self, task_type: str = None) -> List[Dict]:
        """获取策略列表"""
        if task_type:
            sids = self._task_index.get(task_type, [])
        else:
            sids = list(self._strategies.keys())
        result = []
        for sid in sids:
            if sid in self._strategies:
                s = self._strategies[sid]
                result.append({"strategy_id": sid, **s})
        result.sort(key=lambda x: x.get("weight", 0), reverse=True)
        return result

    # ================================================================
    # 演化操作
    # ================================================================

    def evolve(self, task_type: str = None) -> List[Dict]:
        """
        执行一代演化: 选择 → 交叉 → 变异 → 提案
        juvenile 及以上阶段可执行基本变异，mature+ 可交叉+变异
        """
        stage = self.get_stage()
        if stage == "embryonic":
            return []

        self._generation += 1
        self._evolutions_run += 1
        proposed = []

        # 选择: 对每个task_type运行
        task_types = [task_type] if task_type else list(self._task_index.keys())
        for tt in task_types:
            candidates = self._get_candidates(tt)
            if not candidates:
                continue

            # 交叉 (mature+ 阶段才允许交叉，需要至少2个候选)
            if stage in ("mature", "expert") and len(candidates) >= 2 and random.random() < self.crossover_rate:
                parent1, parent2 = random.sample(candidates, 2)
                child_content = self._crossover(
                    self._strategies[parent1]["content"],
                    self._strategies[parent2]["content"]
                )
                child_id = self.add_strategy(tt, child_content, weight=0.4, origin="crossover")
                proposed.append({"strategy_id": child_id, "origin": "crossover", "task_type": tt})

            # 变异 (juvenile+ 阶段就允许变异，只需1个候选)
            if random.random() < self.mutation_rate:
                parent_id = random.choice(candidates)
                child_content = self._mutate(self._strategies[parent_id]["content"])
                child_id = self.add_strategy(tt, child_content, weight=0.3, origin="mutated")
                proposed.append({"strategy_id": child_id, "origin": "mutated", "task_type": tt})

        # 精英保留: 保留top elite_ratio
        self._elite_preserve(task_type)

        # 对proposed策略发射 strategy_proposed
        for p in proposed:
            s = self._strategies.get(p["strategy_id"])
            if s:
                self.signal.emit("evo_devo", "strategy_proposed", {
                    "strategy_id": p["strategy_id"],
                    "content": s["content"],
                    "task_type": s["task_type"],
                    "weight": s["weight"],
                    "origin": s["origin"],
                    "generation": s["generation"]
                }, strength=s["weight"])
                self._strategies_proposed += 1

        # 全局权重衰减
        self._apply_decay()
        self._save_state()
        return proposed

    def _crossover(self, content1: str, content2: str) -> str:
        """简单交叉: 取两个策略的前半+后半"""
        mid1 = len(content1) // 2
        mid2 = len(content2) // 2
        return content1[:mid1] + content2[mid2:]

    def _mutate(self, content: str) -> str:
        """简单变异: 在末尾附加变异标记"""
        variations = ["[v2]", "[alt]", "[refined]", "[adjusted]", "[optimized]"]
        return content + " " + random.choice(variations)

    def _elite_preserve(self, task_type: str = None):
        """精英保留: 保护top策略不被淘汰"""
        sids = list(self._strategies.keys())
        sids.sort(key=lambda sid: self._strategies[sid]["weight"], reverse=True)
        elite_count = max(1, int(len(sids) * self.elite_ratio))
        self._elite_ids.clear()  # 重置精英列表
        self._elite_ids.update(sids[:elite_count])

    def _apply_decay(self):
        """全局权重衰减"""
        to_remove = []
        for sid, s in self._strategies.items():
            if sid in self._elite_ids:  # 使用独立集合，不污染策略数据
                continue
            s["weight"] *= self.weight_decay
            if s["weight"] < self.min_weight:
                to_remove.append(sid)
        for sid in to_remove:
            self._remove_strategy(sid)
            self._elite_ids.discard(sid)  # 从精英集合移除

    # ================================================================
    # 信号处理
    # ================================================================

    def _on_concept_formed(self, spike: Spike):
        """概念形成 → 可能产生新策略 → 发射 strategy_proposed"""
        data = spike.pattern
        task_types = data.get("task_types", [])
        implications = data.get("implications", {})
        confidence = data.get("confidence", 0.5)

        for tt in task_types:
            content = f"概念迁移: {data.get('name', 'unknown')}"
            if implications:
                content += f" → {json.dumps(implications, ensure_ascii=False)}"
            sid = self.add_strategy(tt, content, weight=confidence * 0.7, origin="concept")
            # 概念驱动的策略也需要通知 covenant 审批
            s = self._strategies.get(sid)
            if s:
                self.signal.emit("evo_devo", "strategy_proposed", {
                    "strategy_id": sid,
                    "content": s["content"],
                    "task_type": s["task_type"],
                    "weight": s["weight"],
                    "origin": s["origin"],
                    "generation": s["generation"]
                }, strength=s["weight"])
                self._strategies_proposed += 1

    def _on_causal_claim(self, spike: Spike):
        """因果声明 → 可能产生新策略 → 发射 strategy_proposed"""
        data = spike.pattern
        cause = data.get("cause", {})
        effect = data.get("effect", {})
        strength = data.get("strength", 0.5)
        task_type = cause.get("task_type", "general")
        content = f"因果策略: {json.dumps(cause, ensure_ascii=False)} → {json.dumps(effect, ensure_ascii=False)}"
        sid = self.add_strategy(task_type, content, weight=strength * 0.5, origin="causal")
        # 因果驱动的策略也需要通知 covenant 审批
        s = self._strategies.get(sid)
        if s:
            self.signal.emit("evo_devo", "strategy_proposed", {
                "strategy_id": sid,
                "content": s["content"],
                "task_type": s["task_type"],
                "weight": s["weight"],
                "origin": s["origin"],
                "generation": s["generation"]
            }, strength=s["weight"])
            self._strategies_proposed += 1

    def _on_observation(self, spike: Spike):
        """观察结果 → 更新策略权重 + 触发条件性演化"""
        data = spike.pattern
        task_type = data.get("task_type")
        result = data.get("result")
        context = data.get("context", {})

        # 只在有匹配策略时才计入全局成功/失败计数
        candidates = self._get_candidates(task_type)
        if candidates:
            if result == "success":
                self._total_success += 1
            elif result == "failure":
                self._total_failure += 1

        # 更新匹配策略的权重
        for sid in candidates[:2]:
            if sid in self._strategies:
                if result == "success":
                    self._strategies[sid]["success_count"] += 1
                    self._strategies[sid]["weight"] = min(1.0, self._strategies[sid]["weight"] + 0.03)
                elif result == "failure":
                    self._strategies[sid]["failure_count"] += 1
                    self._strategies[sid]["weight"] = max(0.0, self._strategies[sid]["weight"] - 0.05)

        self._save_state()

    # ================================================================
    # 辅助
    # ================================================================

    def _get_candidates(self, task_type: str) -> List[str]:
        sids = self._task_index.get(task_type, [])
        return [sid for sid in sids if sid in self._strategies]

    def _cull_weakest(self):
        if not self._strategies:
            return
        weakest = min(self._strategies.items(), key=lambda x: x[1]["weight"])
        self._remove_strategy(weakest[0])

    def _remove_strategy(self, sid: str):
        s = self._strategies.pop(sid, None)
        if s:
            tt = s.get("task_type")
            if tt in self._task_index and sid in self._task_index[tt]:
                self._task_index[tt].remove(sid)

    def _strategy_id(self, task_type: str, content: str) -> str:
        raw = f"{task_type}|{content}"
        return hashlib.md5(raw.encode()).hexdigest()[:12]

    def get_summary(self) -> Dict:
        task_counts = defaultdict(int)
        for s in self._strategies.values():
            task_counts[s["task_type"]] += 1
        return {
            "stage": self.get_stage(),
            "capabilities": self.get_capabilities(),
            "active_strategies": len(self._strategies),
            "total_strategies": len(self._strategies),
            "total_successes": self._total_success,
            "total_failures": self._total_failure,
            "next_stage_threshold": self.stage_thresholds[
                self.dev_stages.index(self.get_stage())
            ] if self.get_stage() != self.dev_stages[-1] else None,
            "task_types": dict(task_counts),
            "generation": self._generation,
            "evolutions_run": self._evolutions_run,
            "strategies_proposed": self._strategies_proposed,
            "version": "3.0.0"
        }

    # ================================================================
    # 持久化
    # ================================================================

    def _save_state(self):
        self.persistence.save("evo_devo", {
            "strategies": self._strategies,
            "task_index": {k: v for k, v in self._task_index.items()},
            "generation": self._generation,
            "total_success": self._total_success,
            "total_failure": self._total_failure,
            "evolutions_run": self._evolutions_run,
            "strategies_proposed": self._strategies_proposed,
            "elite_ids": list(self._elite_ids)  # 持久化精英集合
        })

    def _load_state(self):
        data = self.persistence.load("evo_devo")
        if not data:
            return
        self._strategies = data.get("strategies", {})
        raw_index = data.get("task_index", {})
        self._task_index = defaultdict(list)
        for k, v in raw_index.items():
            self._task_index[k] = [sid for sid in v if sid in self._strategies]
        self._generation = data.get("generation", 0)
        self._total_success = data.get("total_success", 0)
        self._total_failure = data.get("total_failure", 0)
        self._evolutions_run = data.get("evolutions_run", 0)
        self._strategies_proposed = data.get("strategies_proposed", 0)
        self._elite_ids = set(data.get("elite_ids", []))  # 恢复精英集合


_evo_devo = None

def get_evo_devo() -> EvoDevo:
    global _evo_devo
    if _evo_devo is None:
        _evo_devo = EvoDevo()
    return _evo_devo
