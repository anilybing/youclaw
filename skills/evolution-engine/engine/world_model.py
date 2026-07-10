"""
Evolution Engine 3.0 世界模型 (推理层)
替代v2的Predictor，用概率状态机实现环境动力学

上游: 接收 sensor 的 "observation" 脉冲
下游: 发射 "prediction" 脉冲给 symbolic reasoning
内部: 维护状态转移概率表 P(S'|S,A)

信令契约:
  subscribe("observation")   ← sensor
  emit("prediction")         → symbolic reasoning
"""

import time
import hashlib
import json
import math
from typing import Dict, Any, List, Optional
from collections import defaultdict

from .config import get_config
from .signal_path import get_signal_path, Spike
from .persistence import get_persistence


# ================================================================
# 状态离散化
# ================================================================

def _discretize_state(task_type: str, context: Dict) -> str:
    """
    将连续状态离散化为 StateKey (16字符十六进制)
    hash(task_type + sorted context keys)
    只用key不用value，避免状态空间爆炸
    """
    keys_sorted = json.dumps(sorted(context.keys()))
    raw = f"{task_type}|{keys_sorted}"
    return hashlib.md5(raw.encode()).hexdigest()[:16]


# ================================================================
# 启发式提示 (数据不足时的后备方案)
# ================================================================

_FALLBACK_HINTS: Dict[str, str] = {
    "code_generation": "建议从接口定义开始，逐步实现，每步验证",
    "bug_fix": "建议先复现问题，定位根因，再修复并回归测试",
    "refactoring": "建议小步重构，每次只改一个关注点，保持测试通过",
    "test_writing": "建议先写失败用例，再写实现使其通过",
    "documentation": "建议从使用者视角编写，先接口后细节",
    "deployment": "建议先在staging环境验证，再逐步推广到production",
    "debugging": "建议用二分法缩小范围，检查日志和状态变化",
    "optimization": "建议先度量瓶颈，再针对性优化，避免过早优化",
    "design": "建议先明确需求约束，再探索方案空间，最后决策",
    "analysis": "建议从数据和事实出发，逐步推理，避免先入为主",
}


def _fallback_hint(task_type: str) -> str:
    """无数据时返回启发式提示"""
    # 精确匹配
    if task_type in _FALLBACK_HINTS:
        return _FALLBACK_HINTS[task_type]
    # 模糊匹配：task_type 包含已知关键词
    for key, hint in _FALLBACK_HINTS.items():
        if key in task_type or task_type in key:
            return hint
    return "数据不足，建议谨慎尝试并记录结果以积累经验"


# ================================================================
# WorldModel 核心
# ================================================================

class WorldModel:
    """
    世界模型 - 推理层核心模块

    用概率状态机替代v2的Predictor：
    - 在线学习状态转移 P(S'|S,A)
    - 心理模拟向前推演N步
    - Beam search 向目标规划

    不使用神经网络，纯粹的概率表格 + 启发式搜索
    """

    VERSION = "3.0.0"

    def __init__(self, config=None, signal_path=None, persistence=None):
        self.config = config or get_config()
        self.signal = signal_path or get_signal_path()
        self.persistence = persistence or get_persistence()
        self.persistence.register("world_model")

        # 读取配置
        cfg = self.config.get_module_config("world_model")
        self.max_states = cfg.get("max_states", 5000)
        self.simulation_depth = cfg.get("simulation_depth", 3)
        self.transition_decay = cfg.get("transition_decay", 0.95)
        self.min_sample_size = cfg.get("min_sample_size", 3)
        self.confidence_decay = 0.8  # 模拟中每步置信衰减

        # === 核心数据结构 ===

        # 转移表: StateKey → {action → {StateKey → {count, total_reward}}}
        self._transitions: Dict[str, Dict[str, Dict[str, Dict]]] = defaultdict(
            lambda: defaultdict(lambda: defaultdict(lambda: {"count": 0, "total_reward": 0.0}))
        )

        # 奖励表: StateKey → {action → avg_reward}
        self._rewards: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))

        # 状态元信息: StateKey → {task_type, context_keys, sample_count, last_seen}
        self._state_meta: Dict[str, Dict] = {}

        # 记录总数（用于控制状态空间大小）
        self._total_updates = 0

        # 前次observation状态: 用于将连续observation构建成转移对
        self._last_obs_state: Optional[str] = None
        self._last_obs_task_type: Optional[str] = None

        # 订阅 observation 脉冲
        self.signal.subscribe("observation", self._on_observation)

        # 注册到信号通路
        self.signal.register_module("world_model", {"type": "reasoning"})

        # 加载持久化数据
        self._load_state()

    # ================================================================
    # 脉冲处理
    # ================================================================

    def _on_observation(self, spike: Spike):
        """
        处理 sensor 的 observation 脉冲
        格式: {task_type, result, context}
        result="success" → reward=1.0, result="failure" → reward=-1.0

        连续的observation自动构建转移对:
        前次状态 --(result)--> 当前状态
        这样通过sensor.record()积累的数据也能产生可预测的转移表。
        """
        pattern = spike.pattern
        task_type = pattern.get("task_type", "unknown")
        result = pattern.get("result", "success")
        context = pattern.get("context", {})

        # 将 result 映射为 reward
        if result == "success":
            reward = 1.0
        elif result == "failure":
            reward = -1.0
        else:
            reward = 0.0

        # 离散化当前状态
        state_key = _discretize_state(task_type, context)

        # 更新状态元信息
        self._update_state_meta(state_key, task_type, context)

        # 更新reward表（已禁用）
        # observation 脉冲中没有 action 信息，用 result 当 action 会导致语义混乱
        # reward 更新由 update() 方法处理，该方法接收明确的 action 参数
        # self._update_reward(state_key, result, reward)

        # 构建转移对: 前次状态 --(result)--> 当前状态
        if self._last_obs_state is not None and self._last_obs_task_type == task_type:
            # 同一task_type的连续observation，构建转移
            prev_key = self._last_obs_state
            trans = self._transitions[prev_key][result][state_key]
            trans["count"] += 1
            trans["total_reward"] += reward

        # 记住当前状态供下次使用
        self._last_obs_state = state_key
        self._last_obs_task_type = task_type

        # 数据足够时发射 prediction 脉冲（基于结果分布，不依赖action）
        if self._state_meta.get(state_key, {}).get("sample_count", 0) >= self.min_sample_size:
            # 生成基于结果分布的预测
            transitions = self._transitions.get(state_key, {})
            if transitions:
                pred_results = []
                for result_key, targets in transitions.items():
                    total_count = sum(t["count"] for t in targets.values())
                    if total_count > 0:
                        prob = total_count / sum(
                            sum(t["count"] for t in ts.values())
                            for ts in transitions.values()
                        )
                        avg_reward = sum(
                            t["total_reward"] / t["count"]
                            for t in targets.values() if t["count"] > 0
                        ) / len([t for t in targets.values() if t["count"] > 0]) if any(t["count"] > 0 for t in targets.values()) else 0.0
                        pred_results.append({
                            "result": result_key,
                            "prob": prob,
                            "avg_reward": avg_reward
                        })
                if pred_results:
                    confidence = min(1.0, self._state_meta[state_key]["sample_count"] / 20.0)
                    self.signal.emit("world_model", "prediction", {
                        "task_type": task_type,
                        "source_state": state_key,
                        "predictions": pred_results,
                        "confidence": confidence
                    }, strength=confidence)

        # 定期持久化
        self._total_updates += 1
        if self._total_updates % 10 == 0:
            self._save_state()

    # ================================================================
    # 在线学习
    # ================================================================

    def update(self, state: Dict, action: str, next_state: Dict, reward: float):
        """
        在线学习状态转移
        state: {task_type, context} 当前状态
        action: 执行的动作
        next_state: {task_type, context} 转移后的状态
        reward: 即时奖励

        学得越多，预测越准；数据不足时退回启发式
        """
        s_task = state.get("task_type", "unknown")
        s_ctx = state.get("context", {})
        ns_task = next_state.get("task_type", s_task)
        ns_ctx = next_state.get("context", {})

        s_key = _discretize_state(s_task, s_ctx)
        ns_key = _discretize_state(ns_task, ns_ctx)

        # 更新转移表
        trans = self._transitions[s_key][action][ns_key]
        trans["count"] += 1
        trans["total_reward"] += reward

        # 更新奖励表（增量平均）
        self._update_reward(s_key, action, reward)

        # 更新状态元信息
        self._update_state_meta(s_key, s_task, s_ctx)
        self._update_state_meta(ns_key, ns_task, ns_ctx)

        # 状态空间控制：超出上限时淘汰最久未访问的状态
        self._evict_if_needed()

        # 持久化
        self._total_updates += 1
        if self._total_updates % 5 == 0:
            self._save_state()

        # 数据充足后发射 prediction
        if self._state_meta.get(s_key, {}).get("sample_count", 0) >= self.min_sample_size:
            predictions = self.predict(s_task, s_ctx)
            if predictions:
                self.signal.emit("world_model", "prediction", {
                    "task_type": s_task,
                    "source_state": s_key,
                    "action_taken": action,
                    "predictions": predictions[:5],
                    "confidence": predictions[0].get("confidence", 0.0) if predictions else 0.0
                }, strength=min(1.0, predictions[0].get("confidence", 0.0) * 1.2))

    def _update_reward(self, state_key: str, action: str, reward: float):
        """增量更新奖励表 (EMA)"""
        alpha = 0.3  # 学习率
        old = self._rewards[state_key].get(action, 0.0)
        self._rewards[state_key][action] = old * (1 - alpha) + reward * alpha

    def _update_state_meta(self, state_key: str, task_type: str, context: Dict):
        """更新状态元信息"""
        if state_key not in self._state_meta:
            self._state_meta[state_key] = {
                "task_type": task_type,
                "context_keys": sorted(context.keys()),
                "sample_count": 0,
                "first_seen": time.time(),
                "last_seen": time.time(),
            }
        meta = self._state_meta[state_key]
        meta["sample_count"] += 1
        meta["last_seen"] = time.time()

    def _evict_if_needed(self):
        """状态空间超出上限时，淘汰最久未访问的状态"""
        if len(self._state_meta) <= self.max_states:
            return

        # 淘汰数量：超出部分 + 10%冗余空间，确保不会反复触发
        excess = len(self._state_meta) - self.max_states
        n_evict = max(1, excess + len(self._state_meta) // 10)
        sorted_keys = sorted(
            self._state_meta.keys(),
            key=lambda k: self._state_meta[k]["last_seen"]
        )
        for key in sorted_keys[:n_evict]:
            self._transitions.pop(key, None)
            self._rewards.pop(key, None)
            # 清除指向该状态的转移（作为目标状态）
            for s_actions in self._transitions.values():
                for a_targets in s_actions.values():
                    a_targets.pop(key, None)
            del self._state_meta[key]

    # ================================================================
    # 转移概率计算
    # ================================================================

    def _get_transition_probs(self, state_key: str, action: str) -> List[Dict]:
        """
        获取 P(S'|S,A) 排序列表
        返回: [{"next_state": key, "prob": float, "avg_reward": float}, ...]
        """
        targets = self._transitions.get(state_key, {}).get(action, {})
        if not targets:
            return []

        total_count = sum(t["count"] for t in targets.values())
        if total_count < self.min_sample_size:
            return []

        results = []
        for ns_key, info in targets.items():
            prob = info["count"] / total_count
            avg_reward = info["total_reward"] / info["count"] if info["count"] > 0 else 0.0
            results.append({
                "next_state": ns_key,
                "prob": prob,
                "avg_reward": avg_reward
            })

        results.sort(key=lambda x: x["prob"], reverse=True)
        return results

    def _best_action(self, state_key: str) -> Optional[str]:
        """贪心选择当前状态下的最佳动作"""
        rewards = self._rewards.get(state_key, {})
        if not rewards:
            return None
        # 选择平均奖励最高的动作
        return max(rewards.keys(), key=lambda a: rewards[a])

    # ================================================================
    # 心理模拟
    # ================================================================

    def simulate(self, state: Dict, action: str, steps: int = 3) -> List[Dict]:
        """
        心理模拟：从当前状态执行动作，向前推演N步
        每步贪心选择最佳动作，置信度按0.8衰减

        返回: [{"state": key, "action": str, "confidence": float, "prob": float}, ...]
        """
        task_type = state.get("task_type", "unknown")
        ctx = state.get("context", {})
        current_key = _discretize_state(task_type, ctx)

        # 无此状态数据 → 空模拟
        if current_key not in self._state_meta:
            return []

        results = []
        confidence = 1.0
        visited = set()  # 避免环路

        for step in range(steps):
            if current_key in visited:
                break  # 检测到循环，停止
            visited.add(current_key)

            # 获取转移概率
            probs = self._get_transition_probs(current_key, action)
            if not probs:
                break

            # 取概率最高的转移
            best = probs[0]
            ns_key = best["next_state"]

            results.append({
                "step": step + 1,
                "state": ns_key,
                "action": action,
                "confidence": round(confidence, 4),
                "prob": round(best["prob"], 4),
                "avg_reward": round(best["avg_reward"], 4)
            })

            # 衰减置信度
            confidence *= self.confidence_decay

            # 下一步：贪心选动作
            current_key = ns_key
            next_action = self._best_action(current_key)
            if next_action is None:
                break
            action = next_action

        return results

    # ================================================================
    # 预测
    # ================================================================

    def predict(self, task_type: str, context: Dict = None) -> List[Dict]:
        """
        返回排序后的预测列表（含置信度）
        每条: {"action": str, "next_state": str, "confidence": float, "prob": float}

        置信度 = P(S'|S,A) × 样本充分度 × 转移衰减
        """
        ctx = context or {}
        state_key = _discretize_state(task_type, ctx)

        if state_key not in self._state_meta:
            return []

        # 收集所有动作的转移
        all_predictions = []
        for action in self._transitions.get(state_key, {}):
            probs = self._get_transition_probs(state_key, action)
            for p in probs:
                # 样本充分度: 对数缩放，min_sample_size 时为 0.5，趋于1.0
                total_count = sum(
                    t["count"] for t in self._transitions[state_key][action].values()
                )
                sample_factor = 1.0 - math.exp(-total_count / (self.min_sample_size * 3))

                # 综合置信度: 概率 × 充分度 × 衰减 × 奖励加权
                # reward_factor: 正奖励提升置信度，负奖励降低
                reward_factor = 1.0 + max(-0.9, min(0.9, p["avg_reward"] * 0.5))
                confidence = p["prob"] * sample_factor * self.transition_decay * reward_factor
                confidence = max(0.0, min(1.0, confidence))

                all_predictions.append({
                    "action": action,
                    "next_state": p["next_state"],
                    "confidence": round(confidence, 4),
                    "prob": round(p["prob"], 4),
                    "avg_reward": round(p["avg_reward"], 4)
                })

        # 按置信度降序排列，同置信度时按平均奖励降序
        all_predictions.sort(key=lambda x: (x["confidence"], x["avg_reward"]), reverse=True)
        return all_predictions

    # ================================================================
    # 启发式提示 (v2兼容)
    # ================================================================

    def get_hint(self, task_type: str, context: Dict = None) -> str:
        """
        返回人类可读的提示
        有数据时基于最优动作生成，无数据时退回启发式
        """
        ctx = context or {}

        # 优先精确匹配（用给定context生成的key）
        state_key = _discretize_state(task_type, ctx)
        target_key = None
        if state_key in self._state_meta:
            target_key = state_key

        # 若精确key无数据，搜索同一task_type下样本最多的状态
        if target_key is None:
            candidates = {
                k: v for k, v in self._state_meta.items()
                if v.get("task_type") == task_type
            }
            if candidates:
                target_key = max(candidates, key=lambda k: candidates[k].get("sample_count", 0))

        # 有足够数据 → 生成提示
        if target_key and target_key in self._state_meta:
            meta = self._state_meta[target_key]
            if meta["sample_count"] >= self.min_sample_size:
                best_action = self._best_action(target_key)

                # 有明确最佳动作 → 基于动作生成提示
                if best_action:
                    reward = self._rewards.get(target_key, {}).get(best_action, 0.0)
                    sims = self.simulate(
                        {"task_type": task_type, "context": ctx},
                        best_action, steps=2
                    )
                    hint_parts = [f"基于{meta['sample_count']}次经验，推荐动作: {best_action}"]
                    if reward > 0:
                        hint_parts.append(f"（历史平均奖励: +{reward:.2f}）")
                    elif reward < 0:
                        hint_parts.append(f"（历史平均奖励: {reward:.2f}，需谨慎）")
                    if sims:
                        hint_parts.append(f"模拟{len(sims)}步后置信度{sims[-1]['confidence']:.0%}")
                    return "，".join(hint_parts)

                # 无最佳动作但有多条转移 → 基于转移概率生成提示
                transitions = self._transitions.get(target_key, {})
                if transitions:
                    all_probs = []
                    for action, targets in transitions.items():
                        total = sum(t["count"] for t in targets.values())
                        avg_r = sum(t["total_reward"] for t in targets.values()) / max(total, 1)
                        all_probs.append({"action": action, "prob": total, "avg_reward": avg_r})
                    all_probs.sort(key=lambda x: x["avg_reward"], reverse=True)
                    if all_probs:
                        best = all_probs[0]
                        hint_parts = [f"基于{meta['sample_count']}次经验"]
                        if best["avg_reward"] > 0:
                            hint_parts.append(f"结果\"{best['action']}\"历史表现最好（平均奖励: +{best['avg_reward']:.2f}）")
                        else:
                            hint_parts.append(f"所有结果均为负收益，建议谨慎尝试新方案")
                        return "，".join(hint_parts)

        # 无数据 → 启发式后备
        return _fallback_hint(task_type)

    # ================================================================
    # 规划 (Beam Search)
    # ================================================================

    def plan(self, goal: Dict) -> List[Dict]:
        """
        Beam search 通过转移表向目标规划

        goal: {task_type, context, target_reward?}
        返回: [{"step", "state", "action", "confidence", "cumulative_reward"}, ...]

        算法:
        1. 从所有已知状态出发
        2. 每步扩展 beam_width 个最优候选
        3. 评估与目标的匹配度 (context keys 重叠 + reward)
        4. 返回得分最高的路径
        """
        goal_task = goal.get("task_type", "unknown")
        goal_ctx = goal.get("context", {})
        target_reward = goal.get("target_reward", 0.5)

        goal_key = _discretize_state(goal_task, goal_ctx)

        # 如果目标状态已知，从反向查找
        # 否则从前向 beam search

        # 候选路径: [(path, score)]
        # path: [{"step", "state", "action", "confidence", "cumulative_reward"}]
        beam_width = 5
        max_depth = self.simulation_depth + 2  # 允许比默认模拟多1-2步

        # 初始候选：所有匹配 task_type 的状态
        candidates = []
        for s_key, meta in self._state_meta.items():
            if meta.get("task_type") == goal_task or not goal_task:
                candidates.append(([], s_key, 0.0, 1.0))  # (path, state, cum_reward, confidence)

        if not candidates:
            # 没有任何匹配状态，无法规划
            return []

        # 检查目标是否直接可达（反向查找）
        reverse_paths = self._reverse_search(goal_key, max_depth)
        if reverse_paths:
            return reverse_paths[0]  # 返回最短路径

        # 前向 beam search
        best_paths = []

        for depth in range(max_depth):
            next_candidates = []

            for path, s_key, cum_reward, confidence in candidates:
                # 检查是否到达目标
                if s_key == goal_key:
                    scored_path = path.copy()
                    best_paths.append((scored_path, cum_reward * confidence))
                    continue

                # 扩展所有可能动作
                for action in self._transitions.get(s_key, {}):
                    probs = self._get_transition_probs(s_key, action)
                    for p in probs[:3]:  # 每个动作取top3转移
                        ns_key = p["next_state"]
                        new_conf = confidence * self.confidence_decay * p["prob"]
                        new_reward = cum_reward + p["avg_reward"]

                        step_entry = {
                            "step": depth + 1,
                            "state": ns_key,
                            "action": action,
                            "confidence": round(new_conf, 4),
                            "cumulative_reward": round(new_reward, 4)
                        }
                        new_path = path + [step_entry]
                        next_candidates.append((new_path, ns_key, new_reward, new_conf))

            if not next_candidates:
                break

            # 保留 top beam_width 候选（按累积奖励 × 置信度排序）
            next_candidates.sort(
                key=lambda x: x[2] * x[3], reverse=True
            )
            candidates = next_candidates[:beam_width]

        # 从所有完整路径中选最优
        # 也考虑未到达目标但最接近的路径
        for path, s_key, cum_reward, confidence in candidates:
            # 评估与目标的相似度
            similarity = self._goal_similarity(s_key, goal_key, goal_ctx)
            score = cum_reward * confidence * (1 + similarity)
            best_paths.append((path, score))

        if not best_paths:
            return []

        best_paths.sort(key=lambda x: x[1], reverse=True)
        return best_paths[0][0]

    def _reverse_search(self, goal_key: str, max_depth: int) -> List[List[Dict]]:
        """
        反向搜索：从目标状态回溯找前驱
        返回候选路径列表（按长度排序，短的优先）
        """
        paths = []
        visited = {goal_key}
        # BFS 队列: (current_key, path_so_far, depth)
        queue = [(goal_key, [], 0)]

        while queue:
            current, path, depth = queue.pop(0)
            if depth >= max_depth:
                continue

            # 查找所有指向 current 的转移
            for s_key, actions in self._transitions.items():
                for action, targets in actions.items():
                    if current in targets and targets[current]["count"] >= 1:
                        # 找到前驱 (s_key, action) → current
                        probs = self._get_transition_probs(s_key, action)
                        prob = 0.0
                        for p in probs:
                            if p["next_state"] == current:
                                prob = p["prob"]
                                break

                        step_entry = {
                            "step": depth + 1,
                            "state": current,
                            "action": action,
                            "confidence": round(self.confidence_decay ** (depth + 1), 4),
                            "prob": round(prob, 4)
                        }
                        new_path = [step_entry] + path

                        if s_key not in visited:
                            visited.add(s_key)
                            queue.append((s_key, new_path, depth + 1))

                            # 如果前驱状态有足够样本，记录路径
                            if self._state_meta.get(s_key, {}).get("sample_count", 0) >= self.min_sample_size:
                                paths.append(new_path)

        paths.sort(key=len)
        return paths[:3]  # 返回最多3条候选路径

    def _goal_similarity(self, state_key: str, goal_key: str, goal_ctx: Dict) -> float:
        """
        评估状态与目标的相似度
        基于 context keys 的 Jaccard 相似度
        """
        if state_key == goal_key:
            return 1.0

        meta = self._state_meta.get(state_key, {})
        goal_keys_set = set(goal_ctx.keys())
        state_keys_set = set(meta.get("context_keys", []))

        if not goal_keys_set and not state_keys_set:
            return 0.5  # 都为空，中性

        intersection = goal_keys_set & state_keys_set
        union = goal_keys_set | state_keys_set
        return len(intersection) / len(union) if union else 0.0

    # ================================================================
    # 转移衰减
    # ================================================================

    def apply_decay(self):
        """
        对转移计数施加衰减，淘汰过时经验
        定期调用（如心跳时）
        """
        decay = self.transition_decay
        for s_key in list(self._transitions.keys()):
            for action in list(self._transitions[s_key].keys()):
                for ns_key in list(self._transitions[s_key][action].keys()):
                    info = self._transitions[s_key][action][ns_key]
                    info["count"] *= decay
                    info["total_reward"] *= decay
                    # 低于阈值则删除
                    if info["count"] < 0.5:
                        del self._transitions[s_key][action][ns_key]
                # 动作下无转移则删除
                if not self._transitions[s_key][action]:
                    del self._transitions[s_key][action]
            # 状态下无动作则删除
            if not self._transitions[s_key]:
                del self._transitions[s_key]
                self._state_meta.pop(s_key, None)
                self._rewards.pop(s_key, None)

    # ================================================================
    # 摘要
    # ================================================================

    def get_summary(self) -> Dict:
        """返回世界模型概要信息"""
        total_transitions = 0
        total_actions = 0
        for s_key, actions in self._transitions.items():
            for action, targets in actions.items():
                total_actions += 1
                total_transitions += len(targets)

        # 计算平均置信度
        confidences = []
        for s_key, actions in self._transitions.items():
            for action in actions:
                probs = self._get_transition_probs(s_key, action)
                for p in probs[:1]:  # 只看top1
                    confidences.append(p["prob"])

        avg_confidence = sum(confidences) / len(confidences) if confidences else 0.0

        # 按task_type统计
        task_counts: Dict[str, int] = defaultdict(int)
        for meta in self._state_meta.values():
            task_counts[meta.get("task_type", "unknown")] += 1

        return {
            "version": self.VERSION,
            "states_count": len(self._state_meta),
            "actions_count": total_actions,
            "transitions_count": total_transitions,
            "avg_confidence": round(avg_confidence, 4),
            "total_updates": self._total_updates,
            "task_distribution": dict(task_counts),
            "max_states": self.max_states,
            "simulation_depth": self.simulation_depth
        }

    # ================================================================
    # 持久化
    # ================================================================

    def _save_state(self):
        """持久化世界模型状态"""
        # 将 defaultdict 转为普通 dict 以便序列化
        transitions_plain = {}
        for s_key, actions in self._transitions.items():
            transitions_plain[s_key] = {}
            for action, targets in actions.items():
                transitions_plain[s_key][action] = {}
                for ns_key, info in targets.items():
                    transitions_plain[s_key][action][ns_key] = {
                        "count": round(info["count"], 2),
                        "total_reward": round(info["total_reward"], 4)
                    }

        rewards_plain = {}
        for s_key, actions in self._rewards.items():
            rewards_plain[s_key] = {a: round(r, 4) for a, r in actions.items()}

        self.persistence.save("world_model", {
            "transitions": transitions_plain,
            "rewards": rewards_plain,
            "state_meta": self._state_meta,
            "total_updates": self._total_updates,
            "last_obs_state": self._last_obs_state,
            "last_obs_task_type": self._last_obs_task_type
        })

    def _load_state(self):
        """从持久化加载世界模型状态"""
        data = self.persistence.load("world_model")
        if not data:
            return

        # 恢复转移表
        raw_transitions = data.get("transitions", {})
        self._transitions = defaultdict(
            lambda: defaultdict(lambda: defaultdict(lambda: {"count": 0, "total_reward": 0.0}))
        )
        for s_key, actions in raw_transitions.items():
            for action, targets in actions.items():
                for ns_key, info in targets.items():
                    self._transitions[s_key][action][ns_key] = {
                        "count": info.get("count", 0),
                        "total_reward": info.get("total_reward", 0.0)
                    }

        # 恢复奖励表
        raw_rewards = data.get("rewards", {})
        self._rewards = defaultdict(lambda: defaultdict(float))
        for s_key, actions in raw_rewards.items():
            for action, reward in actions.items():
                self._rewards[s_key][action] = reward

        # 恢复状态元信息
        self._state_meta = data.get("state_meta", {})

        # 恢复计数
        self._total_updates = data.get("total_updates", 0)

        # 恢复前次observation状态
        self._last_obs_state = data.get("last_obs_state")
        self._last_obs_task_type = data.get("last_obs_task_type")


# ================================================================
# 单例
# ================================================================

_world_model = None


def get_world_model() -> WorldModel:
    """获取世界模型单例"""
    global _world_model
    if _world_model is None:
        _world_model = WorldModel()
    return _world_model
