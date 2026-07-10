"""
Evolution Engine 3.0 信号通路
替代v2的GlobalWorkspace，解决事件风暴(498条/record)
节流 + 权重过滤 + 脉冲分发

三阶八柱信令契约:
  感知阶 → 推理阶:
    observation:   sensor → world_model, causal
    anomaly:       sensor → metacognitive

  推理阶 → 策略阶:
    prediction:    world_model → symbolic
    causal_claim:  causal → evo_devo
    verified_fact: symbolic → concept

  策略阶 → 守卫:
    concept_formed:    concept → evo_devo
    strategy_proposed: evo_devo → covenant
    rule_committed:    covenant → (持久化规则)

  核心 → 全局:
    meta_adjustment: metacognitive → 所有模块
"""

import time
from typing import Dict, Any, List, Optional, Callable
from collections import defaultdict, deque
from dataclasses import dataclass

from .config import get_config
from .persistence import get_persistence


@dataclass
class Spike:
    """脉冲 - 带时序和强度的信息单元"""
    source: str
    spike_type: str       # alert / observation / prediction / causal_claim / rule_proposal / meta_adjustment
    pattern: Dict[str, Any]
    strength: float       # [0, 1]
    timestamp: float = 0.0
    ttl: float = 300.0

    def __post_init__(self):
        if self.timestamp == 0.0:
            self.timestamp = time.time()
        self.strength = max(0.0, min(1.0, self.strength))

    @property
    def expired(self) -> bool:
        return time.time() - self.timestamp > self.ttl


class SignalPath:
    """
    信号通路 - 三阶八柱的基础设施层
    
    所有模块通过 emit() 发射脉冲，通过 subscribe() 接收脉冲。
    脉冲沿认知循环流动: 感知 → 推理 → 策略 → 守卫
    元认知调控作为核心横切关注点，向全局发射 meta_adjustment。
    """

    def __init__(self, config=None, persistence=None):
        self.config = config or get_config()
        self.persistence = persistence or get_persistence()
        self.persistence.register("signal_path")

        sig_cfg = self.config.get_module_config("signal")
        self.throttle_window = sig_cfg.get("throttle_window_ms", 100) / 1000.0
        self.default_ttl = sig_cfg.get("spike_ttl", 300)
        self.max_queue = sig_cfg.get("max_queue", 1000)

        # 订阅者: spike_type → [callback, ...]
        self._subscribers: Dict[str, List[Callable]] = defaultdict(list)
        # 节流: source:type → last_emit_time
        self._throttle_log: Dict[str, float] = {}
        # 全局状态 (兼容v2 workspace查询)
        self._module_states: Dict[str, Dict] = {}
        self._alerts: List[Dict] = []
        self._counters: Dict[str, int] = {}
        # 统计
        self._emit_count = 0
        self._throttle_count = 0

    # 认知流信号类型 - 这些是核心认知循环的信号，不应被节流
    _COGNITIVE_SPIKE_TYPES = {
        "observation", "anomaly", "prediction", "causal_claim",
        "verified_fact", "concept_formed", "strategy_proposed",
        "meta_adjustment", "rule_committed"
    }

    def emit(self, source: str, spike_type: str, pattern: Dict,
             strength: float = 0.5) -> Optional[Spike]:
        """发射脉冲 - 核心方法"""
        # 节流: 同源同类脉冲在窗口内合并
        # 但认知流信号(observation/anomaly等)不节流，确保学习数据完整
        key = f"{source}:{spike_type}"
        now = time.time()
        if spike_type not in self._COGNITIVE_SPIKE_TYPES:
            last = self._throttle_log.get(key, 0)
            if now - last < self.throttle_window:
                self._throttle_count += 1
                return None
        self._throttle_log[key] = now

        spike = Spike(source=source, spike_type=spike_type,
                      pattern=pattern, strength=strength, ttl=self.default_ttl)
        self._emit_count += 1

        # 更新全局状态
        self._module_states[source] = {
            "status": "active", "last_update": now, "data": pattern
        }

        # 分发给订阅者
        for cb in self._subscribers.get(spike_type, []):
            try:
                cb(spike)
            except Exception:
                pass
        for cb in self._subscribers.get("all", []):
            try:
                cb(spike)
            except Exception:
                pass

        # alert 特殊处理：额外记录
        if spike_type == "alert":
            self._alerts.append({
                "level": pattern.get("level", "info"),
                "message": pattern.get("message", ""),
                "source": source,
                "timestamp": now
            })
            # 保留最近100条
            if len(self._alerts) > 100:
                self._alerts = self._alerts[-100:]

        return spike

    def subscribe(self, spike_type: str, callback: Callable):
        """订阅脉冲类型"""
        self._subscribers[spike_type].append(callback)

    # === 兼容v2 GlobalWorkspace接口 ===

    def register_module(self, name: str, info: Optional[Dict] = None):
        self._module_states[name] = {
            "status": "active", "last_update": time.time(),
            "data": info or {}
        }

    def sync(self, module_name: str, state: Dict) -> bool:
        """v2兼容: 模块状态同步"""
        self.emit(module_name, "state_sync", state, strength=0.2)
        self._module_states[module_name] = {
            "status": "active", "last_update": time.time(), "data": state
        }
        return True

    def broadcast_alert(self, level: str, message: str, source: str,
                        data: Optional[Dict] = None) -> Dict:
        """v2兼容: 广播告警"""
        strength_map = {"info": 0.2, "warning": 0.4, "error": 0.7, "critical": 0.9}
        spike = self.emit(source, "alert",
                          {"level": level, "message": message, "data": data or {}},
                          strength=strength_map.get(level, 0.3))
        return spike.pattern if spike else {"level": level, "message": message}

    def get_state(self, module_name: Optional[str] = None) -> Dict:
        if module_name:
            return self._module_states.get(module_name, {})
        return {"modules": self._module_states, "version": "3.0.0"}

    def query(self, module_name: str, key: str, default: Any = None) -> Any:
        state = self._module_states.get(module_name, {}).get("data", {})
        return state.get(key, default)

    def update_counter(self, name: str, delta: int = 1) -> int:
        self._counters[name] = self._counters.get(name, 0) + delta
        return self._counters[name]

    def get_counter(self, name: str) -> int:
        return self._counters.get(name, 0)

    def get_summary(self) -> Dict:
        active = sum(1 for s in self._module_states.values()
                     if time.time() - s.get("last_update", 0) < 300)
        return {
            "modules_count": len(self._module_states),
            "active_modules": active,
            "total_emits": self._emit_count,
            "throttled_emits": self._throttle_count,
            "alerts_count": len(self._alerts),
            "version": "3.0.0"
        }


_signal_path = None

def get_signal_path() -> SignalPath:
    global _signal_path
    if _signal_path is None:
        _signal_path = SignalPath()
    return _signal_path
