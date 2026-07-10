"""
Evolution Engine 3.0 概念形成 (策略阶)
从具体经验中抽象可复用的概念

上游: 接收符号推理的 "verified_fact" 脉冲
下游: 发射 "concept_formed" 脉冲给演化发育

核心价值: 没有概念形成，系统只有case-by-case记忆；
有概念形成，系统可以举一反三，跨任务类型迁移知识。
"""

import time
import json
import hashlib
from typing import Dict, Any, List, Optional
from collections import defaultdict
from datetime import datetime

from .config import get_config
from .signal_path import get_signal_path, Spike
from .persistence import get_persistence


class Concept:
    """
    概念形成 - 策略阶模块

    工作流程:
    1. 积累验证过的事实 (verified facts)
    2. 相似事实聚类 (Jaccard + 值重叠度)
    3. 聚类达到阈值时抽象为概念
    4. 概念可跨任务类型迁移

    概念 = {条件 → 含义} 的抽象
    条件: 多个事实共享的上下文键
    含义: 多个事实共享的结果模式
    """

    def __init__(self, config=None, signal_path=None, persistence=None):
        self.config = config or get_config()
        self.signal = signal_path or get_signal_path()
        self.persistence = persistence or get_persistence()
        self.persistence.register("concept")

        cfg = self.config.get_module_config("concept")
        self.clustering_threshold = cfg.get("clustering_threshold", 0.6)
        self.max_concepts = cfg.get("max_concepts", 500)
        self.abstraction_min_examples = cfg.get("abstraction_min_examples", 3)
        self.transfer_threshold = cfg.get("transfer_threshold", 0.5)

        # 原始验证事实 (保留最近500条)
        self._facts: List[Dict] = []
        # 聚类: cluster_id → {facts, center, task_types, created}
        self._clusters: Dict[str, Dict] = {}
        # 概念: concept_id → {name, conditions, implications, confidence, example_count, created_at}
        self._concepts: Dict[str, Dict] = {}

        # 性能优化：task_type → cluster_ids 索引
        self._task_type_index: Dict[str, List[str]] = defaultdict(list)

        # 统计
        self._total_facts = 0
        self._total_concepts_formed = 0
        self._transfer_hits = 0

        # 订阅验证事实
        self.signal.subscribe("verified_fact", self._on_verified_fact)
        self.signal.register_module("concept", {"type": "strategic"})

        self._load_state()

    # ================================================================
    # 脉冲处理
    # ================================================================

    def _on_verified_fact(self, spike: Spike):
        """处理符号推理的 verified_fact 脉冲"""
        pattern = spike.pattern
        fact = pattern.get("fact", {})
        if not fact:
            return

        task_type = fact.get("task_type", "unknown")
        context = fact.get("context", {})
        result = fact.get("result", {})
        confidence = pattern.get("confidence", 0.5)

        self.add_fact(task_type, context, result, confidence)

    # ================================================================
    # 事实积累与聚类
    # ================================================================

    def add_fact(self, task_type: str, context: Dict, result: Dict,
                 confidence: float = 0.5) -> Dict:
        """
        添加一条验证事实

        流程: 事实 → 尝试匹配已有聚类 → 不匹配则新建聚类
              → 聚类达到阈值 → 抽象为概念 → 发射concept_formed脉冲
        """
        self._total_facts += 1
        now = time.time()

        fact_entry = {
            "task_type": task_type,
            "context": context,
            "result": result,
            "confidence": confidence,
            "timestamp": now
        }

        # 保留最近500条
        self._facts.append(fact_entry)
        if len(self._facts) > 500:
            self._facts = self._facts[-500:]

        # 尝试匹配已有聚类
        # 性能优化：先按 task_type 索引筛选，减少相似度计算
        best_cluster = None
        best_similarity = 0.0

        # 优先在同 task_type 的聚类中匹配
        candidate_ids = self._task_type_index.get(task_type, [])
        for cid in candidate_ids:
            if cid in self._clusters:
                cluster = self._clusters[cid]
                sim = self._compute_similarity(fact_entry, cluster.get("center", {}))
                if sim > best_similarity:
                    best_similarity = sim
                    best_cluster = cid

        # 若同类型无匹配，再尝试所有聚类（允许跨类型迁移）
        if best_similarity < self.clustering_threshold:
            for cid, cluster in self._clusters.items():
                if cid in candidate_ids:  # 已检查过
                    continue
                sim = self._compute_similarity(fact_entry, cluster.get("center", {}))
                if sim > best_similarity:
                    best_similarity = sim
                    best_cluster = cid

        if best_similarity >= self.clustering_threshold and best_cluster:
            # 加入已有聚类
            cluster = self._clusters[best_cluster]
            cluster["facts"].append(fact_entry)
            # 更新索引
            if task_type not in self._task_type_index:
                self._task_type_index[task_type].append(best_cluster)
            elif best_cluster not in self._task_type_index[task_type]:
                self._task_type_index[task_type].append(best_cluster)
            cluster["task_types"].add(task_type)
            # 更新聚类中心 (EMA)
            self._update_center(cluster, fact_entry)
        else:
            # 新建聚类
            cid = self._cluster_id(fact_entry)
            self._clusters[cid] = {
                "facts": [fact_entry],
                "center": fact_entry.copy(),
                "task_types": {task_type},
                "created": now
            }
            self._task_type_index[task_type].append(cid)
            best_cluster = cid

        # 检查是否达到抽象阈值
        cluster = self._clusters[best_cluster]
        formed_concept = None
        # 只在聚类尚未有概念时才创建新概念，避免重复创建
        already_has_concept = any(
            c.get("cluster_id") == best_cluster for c in self._concepts.values()
        )
        if len(cluster["facts"]) >= self.abstraction_min_examples and not already_has_concept:
            formed_concept = self._abstract_concept(best_cluster, cluster)

        # 概念数量上限
        if len(self._concepts) > self.max_concepts:
            self._evict_weakest_concept()

        self._save_state()
        return {"fact_added": True, "cluster": best_cluster,
                "concept_formed": formed_concept is not None,
                "concept_id": formed_concept}

    def _compute_similarity(self, fact: Dict, center: Dict) -> float:
        """
        计算事实与聚类中心的相似度
        = (共享上下文键 / 并集键) * 0.5 + (匹配值 / 比较值) * 0.5
        """
        ctx_a = fact.get("context", {})
        ctx_b = center.get("context", {})

        keys_a = set(ctx_a.keys())
        keys_b = set(ctx_b.keys())

        if not keys_a and not keys_b:
            # 都没有上下文，用task_type相似度
            return 1.0 if fact.get("task_type") == center.get("task_type") else 0.0

        # Jaccard on keys
        key_intersection = keys_a & keys_b
        key_union = keys_a | keys_b
        key_sim = len(key_intersection) / len(key_union) if key_union else 0.0

        # Value overlap on shared keys
        value_matches = 0
        value_comparisons = 0
        for k in key_intersection:
            value_comparisons += 1
            if ctx_a[k] == ctx_b[k]:
                value_matches += 1
            elif isinstance(ctx_a[k], (int, float)) and isinstance(ctx_b[k], (int, float)):
                # 数值相近度
                denom = max(abs(ctx_a[k]), abs(ctx_b[k]), 1.0)
                value_matches += max(0, 1.0 - abs(ctx_a[k] - ctx_b[k]) / denom)

        value_sim = value_matches / value_comparisons if value_comparisons else 0.0

        # 加权合并: 键相似度50% + 值相似度50%
        return key_sim * 0.5 + value_sim * 0.5

    def _update_center(self, cluster: Dict, new_fact: Dict):
        """EMA更新聚类中心"""
        alpha = 0.2
        center_ctx = cluster["center"].get("context", {})
        new_ctx = new_fact.get("context", {})

        # 合并所有键
        all_keys = set(center_ctx.keys()) | set(new_ctx.keys())
        merged = {}
        for k in all_keys:
            cv = center_ctx.get(k)
            nv = new_ctx.get(k)
            if cv is not None and nv is not None:
                if isinstance(cv, (int, float)) and isinstance(nv, (int, float)):
                    merged[k] = cv * (1 - alpha) + nv * alpha
                else:
                    # 非数值：新值覆盖（简单策略）
                    merged[k] = nv if nv is not None else cv
            else:
                merged[k] = cv if cv is not None else nv

        cluster["center"]["context"] = merged
        # task_type用众数
        if new_fact.get("task_type"):
            cluster["center"]["task_type"] = new_fact["task_type"]

    def _abstract_concept(self, cluster_id: str, cluster: Dict) -> Optional[str]:
        """
        从聚类中抽象出概念

        条件: 多个事实共享的上下文键
        含义: 多个事实共享的结果模式
        """
        facts = cluster["facts"]
        if len(facts) < self.abstraction_min_examples:
            return None

        # 提取共享条件: 所有事实都有的上下文键
        all_context_keys = [set(f.get("context", {}).keys()) for f in facts]
        if all_context_keys:
            shared_keys = all_context_keys[0]
            for ks in all_context_keys[1:]:
                shared_keys = shared_keys & ks
        else:
            shared_keys = set()

        # 提取共享结果: 结果字段中相同的键值对
        result_entries = [f.get("result", {}) for f in facts]
        shared_result = {}
        if result_entries:
            # 取所有结果都有的键
            result_keys = set(result_entries[0].keys())
            for r in result_entries[1:]:
                result_keys = result_keys & set(r.keys())
            # 取值一致的结果
            for k in result_keys:
                values = [r.get(k) for r in result_entries]
                if len(set(str(v) for v in values)) == 1:
                    shared_result[k] = values[0]

        # 生成概念名称
        task_types = cluster.get("task_types", set())
        dominant_task = max(task_types, key=lambda t: sum(
            1 for f in facts if f.get("task_type") == t
        )) if task_types else "general"
        concept_name = f"{dominant_task}_pattern_{self._total_concepts_formed + 1}"

        # 生成条件
        conditions = {k: facts[0].get("context", {}).get(k) for k in shared_keys}

        # 置信度: 事实数 × 平均事实置信度 / 阈值
        avg_confidence = sum(f.get("confidence", 0.5) for f in facts) / len(facts)
        confidence = min(1.0, avg_confidence * (len(facts) / self.abstraction_min_examples))

        concept_id = self._concept_id(concept_name, conditions)

        self._concepts[concept_id] = {
            "name": concept_name,
            "conditions": conditions,
            "implications": shared_result,
            "confidence": round(confidence, 4),
            "example_count": len(facts),
            "task_types": list(task_types),
            "created_at": time.time(),
            "cluster_id": cluster_id
        }

        self._total_concepts_formed += 1

        # 发射 concept_formed 脉冲
        self.signal.emit("concept", "concept_formed", {
            "concept_id": concept_id,
            "name": concept_name,
            "conditions": conditions,
            "implications": shared_result,
            "confidence": confidence,
            "example_count": len(facts),
            "task_types": list(task_types)
        }, strength=confidence)

        return concept_id

    # ================================================================
    # 概念迁移
    # ================================================================

    def suggest_for_task(self, task_type: str, context: Dict = None) -> List[Dict]:
        """
        为新任务推荐相关概念

        匹配逻辑: 条件键与当前上下文重叠度 >= transfer_threshold
        """
        ctx = context or {}
        suggestions = []

        for cid, concept in self._concepts.items():
            # 检查任务类型相关
            if task_type not in concept.get("task_types", []) and "general" not in concept.get("task_types", []):
                continue

            # 计算条件匹配度
            conditions = concept.get("conditions", {})
            if not conditions:
                # 无条件的宽泛概念，低优先级
                suggestions.append({**concept, "concept_id": cid, "match_score": concept["confidence"] * 0.3})
                continue

            cond_keys = set(conditions.keys())
            ctx_keys = set(ctx.keys())
            overlap = cond_keys & ctx_keys

            # 值匹配
            value_matches = sum(1 for k in overlap if str(ctx.get(k)) == str(conditions[k]))
            match_score = (len(overlap) / len(cond_keys)) * 0.6 + (value_matches / max(len(overlap), 1)) * 0.4

            if match_score >= self.transfer_threshold:
                suggestions.append({
                    **concept, "concept_id": cid,
                    "match_score": round(match_score * concept["confidence"], 4)
                })

        suggestions.sort(key=lambda x: x.get("match_score", 0), reverse=True)
        return suggestions[:5]

    def record_transfer(self, concept_id: str, success: bool):
        """记录概念迁移结果"""
        if concept_id in self._concepts:
            if success:
                self._concepts[concept_id]["confidence"] = min(
                    1.0, self._concepts[concept_id].get("confidence", 0.5) + 0.05
                )
                self._transfer_hits += 1
            else:
                self._concepts[concept_id]["confidence"] = max(
                    0.0, self._concepts[concept_id].get("confidence", 0.5) - 0.1
                )
            self._save_state()

    # ================================================================
    # 查询接口
    # ================================================================

    def get_concepts(self) -> List[Dict]:
        result = []
        for cid, c in self._concepts.items():
            result.append({"concept_id": cid, **c})
        result.sort(key=lambda x: x.get("confidence", 0), reverse=True)
        return result

    def get_clusters(self) -> List[Dict]:
        return [
            {"cluster_id": cid, "fact_count": len(c["facts"]),
             "task_types": list(c.get("task_types", set()))}
            for cid, c in self._clusters.items()
        ]

    def _evict_weakest_concept(self):
        """淘汰置信度最低且最久未用的概念"""
        if not self._concepts:
            return
        weakest = min(self._concepts.items(), key=lambda x: x[1].get("confidence", 0))
        del self._concepts[weakest[0]]

    def get_summary(self) -> Dict:
        return {
            "total_facts": self._total_facts,
            "active_clusters": len(self._clusters),
            "concepts_formed": self._total_concepts_formed,
            "active_concepts": len(self._concepts),
            "transfer_hits": self._transfer_hits,
            "version": "3.0.0"
        }

    # ================================================================
    # 辅助
    # ================================================================

    def _cluster_id(self, fact: Dict) -> str:
        raw = f"{fact.get('task_type', 'x')}|{sorted(fact.get('context', {}).keys())}"
        return hashlib.md5(raw.encode()).hexdigest()[:12]

    def _concept_id(self, name: str, conditions: Dict) -> str:
        raw = f"{name}|{json.dumps(conditions, sort_keys=True, default=str)}"
        return hashlib.md5(raw.encode()).hexdigest()[:12]

    # ================================================================
    # 持久化
    # ================================================================

    def _save_state(self):
        # 序列化clusters (facts可能很多，只保留元信息)
        clusters_plain = {}
        for cid, c in self._clusters.items():
            clusters_plain[cid] = {
                "facts": c["facts"][-20:],  # 每个聚类保留最近20条
                "center": c["center"],
                "task_types": list(c.get("task_types", set())),
                "created": c.get("created", 0)
            }
        self.persistence.save("concept", {
            "facts": self._facts[-100:],
            "clusters": clusters_plain,
            "concepts": self._concepts,
            "total_facts": self._total_facts,
            "total_concepts_formed": self._total_concepts_formed,
            "transfer_hits": self._transfer_hits
        })

    def _load_state(self):
        data = self.persistence.load("concept")
        if not data:
            return
        self._facts = data.get("facts", [])
        raw_clusters = data.get("clusters", {})
        self._clusters = {}
        self._task_type_index = defaultdict(list)
        for cid, c in raw_clusters.items():
            c["task_types"] = set(c.get("task_types", []))
            self._clusters[cid] = c
            # 重建 task_type → cluster_id 索引
            for tt in c.get("task_types", set()):
                if cid not in self._task_type_index[tt]:
                    self._task_type_index[tt].append(cid)
        self._concepts = data.get("concepts", {})
        self._total_facts = data.get("total_facts", 0)
        self._total_concepts_formed = data.get("total_concepts_formed", 0)
        self._transfer_hits = data.get("transfer_hits", 0)


_concept = None

def get_concept() -> Concept:
    global _concept
    if _concept is None:
        _concept = Concept()
    return _concept
