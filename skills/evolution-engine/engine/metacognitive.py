"""
Evolution Engine 3.0 元认知调控 (核心)
"思考自己的思考" — 监控全局学习过程，检测停滞，调节探索/利用平衡

上游: 接收 sensor 的 "anomaly" + "observation" 脉冲
下游: 发射 "meta_adjustment" 脉冲给所有模块 (全局广播)

核心价值: 无自我监控的系统可能陷入局部最优，
元认知调控让系统知道自己是否在进步。
"""

import time
import random
from typing import Dict, Any, List, Optional
from collections import deque

from .config import get_config
from .signal_path import get_signal_path, Spike
from .persistence import get_persistence


class Metacognitive:
    """元认知调控 - 核心模块"""

    def __init__(self, config=None, signal_path=None, persistence=None):
        self.config = config or get_config()
        self.signal = signal_path or get_signal_path()
        self.persistence = persistence or get_persistence()
        self.persistence.register("metacognitive")

        cfg = self.config.get_module_config("metacognitive")
        self.monitoring_window = cfg.get("monitoring_window", 50)
        self.adaptation_rate = cfg.get("adaptation_rate", 0.05)
        self.base_exploration_rate = cfg.get("exploration_rate", 0.1)
        self.stagnation_threshold = cfg.get("stagnation_threshold", 10)
        self.min_observations = cfg.get("min_observations_for_meta", 20)

        # 滑动窗口记录结果
        self._recent_outcomes: deque = deque(maxlen=self.monitoring_window)
        # 当前探索率
        self._exploration_rate: float = self.base_exploration_rate
        # 健康分数
        self._health_score: float = 0.5
        self._last_health_score: float = 0.5
        # 停滞计数
        self._stagnation_count: int = 0
        # 历史健康分数 (用于趋势检测)
        self._health_history: List[float] = []
        # 统计
        self._total_adjustments = 0
        self._anomalies_handled = 0
        self._total_observations = 0

        # 订阅信号
        self.signal.subscribe("anomaly", self._on_anomaly)
        self.signal.subscribe("observation", self._on_observation)
        self.signal.register_module("metacognitive", {"type": "core"})

        self._load_state()

    # ================================================================
    # 信号处理
    # ================================================================

    def _on_observation(self, spike: Spike):
        """处理观察脉冲: 积累结果，触发监控"""
        data = spike.pattern
        success = data.get("result") == "success"
        self._recent_outcomes.append({
            "success": success,
            "timestamp": time.time(),
            "task_type": data.get("task_type", "unknown")
        })
        self._total_observations += 1

        # 达到最小观察数后开始调控
        if self._total_observations >= self.min_observations:
            if self._total_observations % 5 == 0:
                self.adjust()

        if self._total_observations % 20 == 0:
            self._save_state()

    def _on_anomaly(self, spike: Spike):
        """处理异常脉冲: 异常是元认知的高优先级输入"""
        self._anomalies_handled += 1
        level = spike.pattern.get("level", "medium")

        # 异常直接影响健康分数
        impact = {"low": -0.02, "medium": -0.05, "high": -0.1, "critical": -0.2}
        self._health_score = max(0.0, self._health_score + impact.get(level, -0.05))

        # 严重异常立即发射调整
        if level in ("high", "critical"):
            self.signal.emit("metacognitive", "meta_adjustment", {
                "type": "anomaly_response",
                "level": level,
                "action": "increase_caution",
                "exploration_rate": min(1.0, self._exploration_rate + 0.1),
                "reason": f"检测到{level}级别异常"
            }, strength=0.8)
            self._exploration_rate = min(1.0, self._exploration_rate + 0.1)
            self._total_adjustments += 1

    # ================================================================
    # 监控与调控
    # ================================================================

    def monitor(self) -> Dict:
        """执行一次监控周期，返回健康评估"""
        self._last_health_score = self._health_score
        self._health_score = self._compute_health()

        # 检测趋势
        improving = self._health_score > self._last_health_score + 0.01
        declining = self._health_score < self._last_health_score - 0.01
        stagnant = abs(self._health_score - self._last_health_score) <= 0.01

        if stagnant:
            self._stagnation_count += 1
        else:
            self._stagnation_count = 0

        # 记录历史
        self._health_history.append(self._health_score)
        if len(self._health_history) > 100:
            self._health_history = self._health_history[-100:]

        return {
            "health_score": round(self._health_score, 4),
            "trend": "improving" if improving else ("declining" if declining else "stagnant"),
            "stagnation_count": self._stagnation_count,
            "exploration_rate": round(self._exploration_rate, 4),
            "success_rate": self._success_rate()
        }

    def adjust(self) -> Optional[Dict]:
        """评估并发射调控信号"""
        assessment = self.monitor()

        adjustment = None

        # 停滞检测
        if self._stagnation_count >= self.stagnation_threshold:
            self._exploration_rate = min(1.0, self._exploration_rate + self.adaptation_rate * 3)
            adjustment = {
                "type": "alert_stagnation",
                "action": "increase_exploration",
                "exploration_rate": self._exploration_rate,
                "stagnation_count": self._stagnation_count,
                "reason": f"停滞{self._stagnation_count}个周期，提升探索率"
            }

        # 成功率高 → 减少探索
        elif self._success_rate() > 0.8:
            self._exploration_rate = max(0.02, self._exploration_rate - self.adaptation_rate)
            adjustment = {
                "type": "decrease_exploration",
                "action": "exploit",
                "exploration_rate": self._exploration_rate,
                "reason": f"成功率{self._success_rate():.0%}，减少探索"
            }

        # 成功率低 → 增加探索
        elif self._success_rate() < 0.3 and self._total_observations > self.min_observations:
            self._exploration_rate = min(1.0, self._exploration_rate + self.adaptation_rate * 2)
            adjustment = {
                "type": "increase_exploration",
                "action": "explore",
                "exploration_rate": self._exploration_rate,
                "reason": f"成功率{self._success_rate():.0%}偏低，增加探索"
            }

        # 振荡检测 (健康分数来回波动)
        elif self._is_oscillating():
            adjustment = {
                "type": "adjust_learning_rate",
                "action": "slow_down",
                "exploration_rate": self._exploration_rate,
                "reason": "检测到振荡，建议降低学习速率"
            }

        if adjustment:
            self.signal.emit("metacognitive", "meta_adjustment", adjustment, strength=0.6)
            self._total_adjustments += 1

        self._save_state()
        return adjustment

    def should_explore(self) -> bool:
        """evo_devo查询是否应该探索"""
        return random.random() < self._exploration_rate  # noqa: needed here

    def get_health_score(self) -> float:
        return self._health_score

    def get_exploration_rate(self) -> float:
        return self._exploration_rate

    # ================================================================
    # 内部计算
    # ================================================================

    def _compute_health(self) -> float:
        """
        计算系统健康分数 = f(成功率, 多样性)
        成功率权重0.7, 策略多样性权重0.3
        """
        sr = self._success_rate()

        # 多样性: 从signal_path查询evo_devo的task_types数量
        diversity = 0.5  # 默认
        try:
            ed_state = self.signal.get_state("evo_devo")
            if ed_state and "data" in ed_state:
                task_types = ed_state["data"].get("task_types", {})
                diversity = min(1.0, len(task_types) / 5.0)  # 5种任务类型=满分
        except Exception:
            pass

        health = sr * 0.7 + diversity * 0.3
        return max(0.0, min(1.0, health))

    def _success_rate(self) -> float:
        """近期成功率"""
        if not self._recent_outcomes:
            return 0.5
        successes = sum(1 for o in self._recent_outcomes if o["success"])
        return successes / len(self._recent_outcomes)

    def _is_oscillating(self) -> bool:
        """检测健康分数是否振荡"""
        if len(self._health_history) < 6:
            return False
        recent = self._health_history[-6:]
        # 计算连续变化方向
        changes = [1 if recent[i+1] > recent[i] else -1 for i in range(len(recent)-1)]
        # 如果方向变化>=4次，认为在振荡
        direction_changes = sum(1 for i in range(len(changes)-1) if changes[i] != changes[i+1])
        return direction_changes >= 4

    # ================================================================
    # 查询
    # ================================================================

    def get_summary(self) -> Dict:
        return {
            "health_score": round(self._health_score, 4),
            "success_rate": round(self._success_rate(), 4),
            "exploration_rate": round(self._exploration_rate, 4),
            "stagnation_count": self._stagnation_count,
            "total_adjustments": self._total_adjustments,
            "anomalies_handled": self._anomalies_handled,
            "total_observations": self._total_observations,
            "recent_window_size": len(self._recent_outcomes),
            "version": "3.0.0"
        }

    # ================================================================
    # 持久化
    # ================================================================

    def _save_state(self):
        self.persistence.save("metacognitive", {
            "recent_outcomes": list(self._recent_outcomes),
            "exploration_rate": self._exploration_rate,
            "health_score": self._health_score,
            "last_health_score": self._last_health_score,
            "stagnation_count": self._stagnation_count,
            "health_history": self._health_history[-50:],
            "total_adjustments": self._total_adjustments,
            "anomalies_handled": self._anomalies_handled,
            "total_observations": self._total_observations
        })

    def _load_state(self):
        data = self.persistence.load("metacognitive")
        if not data:
            return
        self._recent_outcomes = deque(
            data.get("recent_outcomes", []), maxlen=self.monitoring_window
        )
        self._exploration_rate = data.get("exploration_rate", self.base_exploration_rate)
        self._health_score = data.get("health_score", 0.5)
        self._last_health_score = data.get("last_health_score", 0.5)
        self._stagnation_count = data.get("stagnation_count", 0)
        self._health_history = data.get("health_history", [])
        self._total_adjustments = data.get("total_adjustments", 0)
        self._anomalies_handled = data.get("anomalies_handled", 0)
        self._total_observations = data.get("total_observations", 0)


_metacognitive = None

def get_metacognitive() -> Metacognitive:
    global _metacognitive
    if _metacognitive is None:
        _metacognitive = Metacognitive()
    return _metacognitive
