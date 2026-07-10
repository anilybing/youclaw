"""
Evolution Engine 3.0 因果推理 (推理层)

上游: 接收 sensor 的 "observation" + "anomaly" 脉冲
下游: 发射 "causal_claim" 脉冲给 evo_devo / hypothesis
内部: 维护因果图(DAG)

核心价值: v2把"相关"当"因果"，导致学到的规则越来越偏。
因果推理区分"X和Y一起出现"(相关) vs "X导致Y"(因果)，
用do-演算简化版做干预推断。
"""

import time
import json
import hashlib
from typing import Dict, Any, List, Optional
from collections import defaultdict, deque
from datetime import datetime

from .config import get_config
from .signal_path import get_signal_path
from .persistence import get_persistence


class CausalReasoning:
    """
    因果推理 - 推理层

    三层因果阶梯 (Pearl 2009):
      L1 关联: X和Y一起出现 → 相关性
      L2 干预: 如果我们做X，Y会怎样 → do(X)
      L3 反事实: 如果当时不做A而做B，会怎样 → 反事实推理

    当前实现L1+L2，L3做简化版
    """

    def __init__(self, config=None, signal_path=None, persistence=None):
        self.config = config or get_config()
        self.signal = signal_path or get_signal_path()
        self.persistence = persistence or get_persistence()
        self.persistence.register("causal")

        cfg = self.config.get_module_config("causal")
        self.max_nodes = cfg.get("max_graph_nodes", 200)
        self.intervention_confidence = cfg.get("intervention_confidence", 0.7)
        self.counterfactual_samples = cfg.get("counterfactual_samples", 10)

        # 因果图: DAG
        # node_id → {variables: Dict, children: [node_id], parents: [node_id], strength: float}
        self._graph: Dict[str, Dict] = {}
        # 观察记录: (cause_vars, effect_vars) → {count, avg_strength}
        self._observations: Dict[str, Dict] = {}
        # 混杂因子候选: variable → set of potential confounders
        self._confounders: Dict[str, set] = defaultdict(set)

        # 批量保存优化：记录上次保存后的观察次数
        self._obs_since_save = 0

        # 订阅信号
        self.signal.register_module("causal", {"type": "reasoning"})
        self.signal.subscribe("observation", self._on_observation)
        self.signal.subscribe("anomaly", self._on_anomaly)

        self._load_state()

    # ================================================================
    # 因果图构建
    # ================================================================

    def add_observation(self, cause: Dict, effect: Dict, strength: float = 1.0):
        """
        添加因果观察

        关键: 不是所有共现都是因果。
        判断因果的三个条件 (Hill 1965):
        1. 时序性: 原因先于结果
        2. 一致性: 反复出现
        3. 剂量反应: 强度关联

        当前简化: 一致性(出现次数) + 强度关联(weighted avg)
        """
        cause_key = self._node_key(cause)
        effect_key = self._node_key(effect)

        if cause_key not in self._graph:
            self._graph[cause_key] = {
                "variables": cause, "children": [], "parents": [],
                "strength": 0.0, "observations": 0
            }
        if effect_key not in self._graph:
            self._graph[effect_key] = {
                "variables": effect, "children": [], "parents": [],
                "strength": 0.0, "observations": 0
            }

        # 记录观察
        obs_key = f"{cause_key}->{effect_key}"
        if obs_key not in self._observations:
            self._observations[obs_key] = {"count": 0, "avg_strength": 0.0}
        obs = self._observations[obs_key]
        obs["count"] += 1
        # EMA更新强度
        alpha = 0.3
        obs["avg_strength"] = obs["avg_strength"] * (1 - alpha) + strength * alpha

        # 只有观察次数足够且强度足够才建立因果边
        # 使用绝对值判断，让失败因果关系也能建立
        if obs["count"] >= 3 and abs(obs["avg_strength"]) >= 0.5:
            self._add_edge(cause_key, effect_key, obs["avg_strength"])

        # 检查容量
        if len(self._graph) > self.max_nodes:
            self._evict_nodes()

        # 批量保存：每 10 次观察保存一次
        self._obs_since_save += 1
        if self._obs_since_save >= 10:
            self._save_state()
            self._obs_since_save = 0

    def _add_edge(self, cause_key: str, effect_key: str, strength: float):
        """添加因果边（DAG，需检查无环）"""
        # 检查是否会形成环
        if self._would_create_cycle(cause_key, effect_key):
            return

        cause_node = self._graph[cause_key]
        effect_node = self._graph[effect_key]

        if effect_key not in cause_node["children"]:
            cause_node["children"].append(effect_key)
            cause_node["strength"] = strength
        if cause_key not in effect_node["parents"]:
            effect_node["parents"].append(cause_key)

        # 发射因果声明信号
        self.signal.emit("causal", "causal_claim", {
            "cause": self._graph[cause_key]["variables"],
            "effect": self._graph[effect_key]["variables"],
            "strength": strength
        }, strength=strength * 0.6)

    def _would_create_cycle(self, from_key: str, to_key: str) -> bool:
        """BFS检查添加边是否会产生环"""
        if from_key == to_key:
            return True
        visited = set()
        queue = deque([to_key])
        while queue:
            current = queue.popleft()
            if current == from_key:
                return True
            if current in visited:
                continue
            visited.add(current)
            node = self._graph.get(current)
            if node:
                for child in node["children"]:
                    queue.append(child)
        return False

    # ================================================================
    # 因果查询
    # ================================================================

    def query_cause(self, effect: Dict) -> List[Dict]:
        """
        查询某效果的可能原因

        在DAG中回溯: 找到所有指向effect节点的路径
        按路径强度排序
        """
        effect_key = self._node_key(effect)
        # 也搜索变量部分匹配的节点
        candidates = self._find_matching_nodes(effect)

        causes = []
        for node_key in candidates:
            node = self._graph.get(node_key)
            if not node:
                continue
            for parent_key in node["parents"]:
                parent = self._graph.get(parent_key)
                if parent:
                    obs_key = f"{parent_key}->{node_key}"
                    obs = self._observations.get(obs_key, {})
                    causes.append({
                        "cause": parent["variables"],
                        "strength": obs.get("avg_strength", 0),
                        "observations": obs.get("count", 0),
                        "confidence": min(obs.get("count", 0) / 10, 1.0) * obs.get("avg_strength", 0)
                    })

        causes.sort(key=lambda x: x["confidence"], reverse=True)
        return causes[:5]

    def intervene(self, do_variable: str, value: Any, context: Dict) -> Dict:
        """
        do-演算简化版 (Pearl L2)

        核心思想: do(X=x)不是"观察到X=x"，而是"我们设定X=x"
        区别: 观察时X的父节点可能影响结果; 干预时切断X的入边

        实现:
        1. 找到DAG中包含do_variable的节点
        2. 切断该节点的所有入边
        3. 设定该变量为指定值
        4. 沿DAG正向传播，计算各节点受影响的概率
        """
        # 找匹配节点
        target_nodes = [
            k for k, v in self._graph.items()
            if do_variable in v["variables"]
        ]

        if not target_nodes:
            return {
                "do_variable": do_variable, "value": value,
                "prediction": "unknown", "confidence": 0,
                "reason": "变量未在因果图中找到"
            }

        # 构建干预后的上下文
        intervened_context = dict(context)
        intervened_context[do_variable] = value

        # 从干预节点开始正向传播
        predictions = {}
        for node_key in target_nodes:
            node = self._graph[node_key]
            # 该节点的值由干预决定，不由父节点决定
            predictions[node_key] = {
                "variables": {**node["variables"], do_variable: value},
                "confidence": self.intervention_confidence,
                "intervened": True
            }
            # 沿子节点传播
            self._propagate(node_key, predictions, set())

        return {
            "do_variable": do_variable, "value": value,
            "context": context,
            "predictions": predictions,
            "confidence": self.intervention_confidence
        }

    def counterfactual(self, actual: Dict, alternative: Dict) -> Dict:
        """
        反事实推理简化版 (Pearl L3)

        "如果当时不做A而做B，会怎样？"
        实现: 用替代值重新运行DAG正向传播，与实际结果比较
        """
        # 找到actual中受影响的节点
        changed_vars = set(alternative.keys()) - set(actual.keys()) | \
                       {k for k in alternative if alternative.get(k) != actual.get(k)}

        # 用alternative值替换，重新传播
        counter_result = self.intervene(
            list(changed_vars)[0] if changed_vars else "unknown",
            list(alternative.values())[0] if alternative else None,
            alternative
        )

        return {
            "actual": actual,
            "alternative": alternative,
            "counterfactual_result": counter_result,
            "changed_variables": list(changed_vars),
            "confidence": self.intervention_confidence * 0.7  # 反事实置信度天然低于干预
        }

    def build_causal_graph(self) -> Dict:
        """返回当前因果图"""
        edges = []
        for node_key, node in self._graph.items():
            for child_key in node["children"]:
                obs_key = f"{node_key}->{child_key}"
                obs = self._observations.get(obs_key, {})
                edges.append({
                    "from": node["variables"],
                    "to": self._graph[child_key]["variables"],
                    "strength": obs.get("avg_strength", 0),
                    "observations": obs.get("count", 0)
                })
        return {
            "nodes": {k: v["variables"] for k, v in self._graph.items()},
            "edges": edges,
            "node_count": len(self._graph),
            "edge_count": len(edges)
        }

    # ================================================================
    # 信号处理
    # ================================================================

    def _on_observation(self, spike):
        """处理observation脉冲: 积累因果证据"""
        data = spike.pattern
        task_type = data.get("task_type")
        result = data.get("result")
        context = data.get("context", {})

        if not task_type or not result:
            return

        # 任务类型+做法+结果 → 构成因果
        cause = {"task_type": task_type, "result_before": result}
        cause.update({k: v for k, v in context.items()
                      if k in ("approach", "strategy", "language", "complexity")})
        effect = {"result": result}

        strength = 1.0 if result == "success" else -0.5
        self.add_observation(cause, effect, strength)

    def _on_anomaly(self, spike):
        """处理anomaly脉冲: 异常是因果推理的高价值输入"""
        data = spike.pattern
        pattern = data.get("pattern", {})
        # 异常本身就是效果，找原因
        self.add_observation(
            {"trigger": "anomaly"},
            {"anomaly": pattern},
            strength=0.8
        )

    # ================================================================
    # 辅助
    # ================================================================

    def _node_key(self, variables: Dict) -> str:
        return hashlib.md5(
            json.dumps(variables, sort_keys=True, default=str).encode()
        ).hexdigest()[:16]

    def _find_matching_nodes(self, variables: Dict) -> List[str]:
        """找到变量部分匹配的节点"""
        exact = self._node_key(variables)
        if exact in self._graph:
            return [exact]
        # 部分匹配
        matches = []
        for key, node in self._graph.items():
            common = set(variables.keys()) & set(node["variables"].keys())
            if common:
                overlap = sum(1 for k in common if variables.get(k) == node["variables"].get(k))
                if overlap / len(common) >= 0.5:
                    matches.append(key)
        return matches

    def _propagate(self, from_key: str, predictions: Dict, visited: set):
        """沿DAG正向传播"""
        if from_key in visited:
            return
        visited.add(from_key)
        node = self._graph.get(from_key)
        if not node:
            return
        for child_key in node["children"]:
            child = self._graph.get(child_key)
            if child and child_key not in predictions:
                obs_key = f"{from_key}->{child_key}"
                obs = self._observations.get(obs_key, {})
                confidence = predictions[from_key]["confidence"] * obs.get("avg_strength", 0.5) * 0.8
                if confidence > 0.05:
                    predictions[child_key] = {
                        "variables": child["variables"],
                        "confidence": confidence,
                        "intervened": False
                    }
                    self._propagate(child_key, predictions, visited)

    def _evict_nodes(self):
        """淘汰最不活跃的节点"""
        now = time.time()
        by_obs = [(v.get("observations", 0), k) for k, v in self._graph.items()]
        by_obs.sort()
        # 删除最不活跃的20%
        to_remove = max(1, len(self._graph) // 5)
        for _, key in by_obs[:to_remove]:
            self._remove_node(key)

    def _remove_node(self, key: str):
        node = self._graph.get(key)
        if not node:
            return
        for parent_key in node["parents"]:
            p = self._graph.get(parent_key)
            if p and key in p["children"]:
                p["children"].remove(key)
        for child_key in node["children"]:
            c = self._graph.get(child_key)
            if c and key in c["parents"]:
                c["parents"].remove(key)
        del self._graph[key]

    def get_summary(self) -> Dict:
        return {
            "node_count": len(self._graph),
            "edge_count": sum(len(n["children"]) for n in self._graph.values()),
            "observation_count": len(self._observations),
            "version": "3.0.0"
        }

    def _save_state(self):
        self.persistence.save("causal", {
            "graph": self._graph,
            "observations": self._observations
        })

    def _load_state(self):
        data = self.persistence.load("causal")
        if data:
            self._graph = data.get("graph", {})
            self._observations = data.get("observations", {})


_causal = None

def get_causal_reasoning() -> CausalReasoning:
    global _causal
    if _causal is None:
        _causal = CausalReasoning()
    return _causal
