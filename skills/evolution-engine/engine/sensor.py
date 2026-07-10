"""
Evolution Engine 3.0 感知器 (感知层)
合并v2的隔离膜+免疫系统，增加环境感知能力

上游: 外部事件(用户操作/心跳) → 感知器
下游: 感知器 →[observation]→ 世界模型、因果推理
       感知器 →[anomaly]→ 元认知调控、认知中枢

信令契约:
  emit("observation", {task_type, result, context})  → 推理层
  emit("anomaly", {level, pattern, count})           → 策略层元认知
"""

import time
import traceback
import hashlib
import json
import logging
from typing import Dict, Any, List, Optional, Callable
from dataclasses import dataclass, field
from collections import defaultdict
from datetime import datetime

logger = logging.getLogger(__name__)

from .config import get_config
from .signal_path import get_signal_path, Spike
from .persistence import get_persistence


@dataclass
class IsolationResult:
    """隔离执行结果 (v2兼容)"""
    success: bool
    result: Any = None
    error: Optional[str] = None
    error_type: Optional[str] = None
    traceback: Optional[str] = None
    retry_count: int = 0
    execution_time: float = 0.0


class Sensor:
    """
    感知器 - 感知层唯一模块

    职责:
    1. 记录经验 (成功/失败事件)
    2. 检测异常 (失败模式积累)
    3. 隔离执行 (错误捕获+重试)
    4. 环境感知 (能力边界追踪)
    5. 免疫记忆 (威胁识别+否决权)

    这些功能为什么在同一个模块？
    因为它们都处理"原始输入"——无论是成功/失败事件、异常信号、
    还是执行错误，都是"系统感知到的东西"，属于观察(O)阶段。
    """

    def __init__(self, config=None, signal_path=None, persistence=None):
        self.config = config or get_config()
        self.signal = signal_path or get_signal_path()
        self.persistence = persistence or get_persistence()
        self.persistence.register("sensor")

        cfg = self.config.get_module_config("sensor")
        self.max_retries = cfg.get("max_retries", 3)
        self.retry_delay = cfg.get("retry_delay", 1.0)
        self.anomaly_threshold = cfg.get("anomaly_threshold", 0.7)
        self.pattern_max_age = cfg.get("pattern_max_age", 86400)
        self.failure_threshold = cfg.get("failure_threshold", 3)
        self.threat_cooldown = cfg.get("threat_cooldown", 300)

        # 经验记录
        self._records: List[Dict] = []
        self._record_index = 0

        # 免疫记忆: pattern_key → {pattern, count, first_seen, last_seen, contexts}
        self._failure_patterns: Dict[str, Dict] = {}
        self._threat_history: List[Dict] = []
        self._threat_blacklist: set = set()

        # 环境感知: 能力边界
        self._capability_bounds: Dict[str, Dict] = {}

        # 统计
        self._total_success = 0
        self._total_failure = 0

        # 注册到信号通路
        self.signal.register_module("sensor", {"type": "perception"})

        # 加载持久化数据
        self._load_state()

    # ================================================================
    # 经验记录
    # ================================================================

    def record(self, task_type: str, result: str, context: Optional[Dict] = None) -> Dict:
        """
        记录经验 - 感知器的核心入口
        所有外部事件(成功/失败)都通过这里进入系统
        """
        ctx = context or {}
        now = time.time()
        rec = {
            "id": f"rec_{self._record_index}",
            "task_type": task_type,
            "result": result,
            "context": ctx,
            "timestamp": now,
            "created_at": datetime.now().isoformat()
        }
        self._record_index += 1
        self._records.append(rec)

        if result == "success":
            self._total_success += 1
        elif result == "failure":
            self._total_failure += 1
            self._record_failure_pattern({"task_type": task_type}, ctx)

        # 发射observation信号 → 推理层
        self.signal.emit("sensor", "observation", {
            "task_type": task_type, "result": result, "context": ctx
        }, strength=0.5 if result == "success" else 0.8)

        # 持久化
        self._save_state()

        return {"record_id": rec["id"], "recorded": True}

    def get_records(self, limit: int = 100) -> List[Dict]:
        return self._records[-limit:]

    # ================================================================
    # 隔离执行 (v2 Isolation兼容)
    # ================================================================

    def wrap(self, func: Callable, *args, **kwargs) -> IsolationResult:
        """包装函数执行，捕获异常，失败时记录免疫记忆"""
        start = time.time()
        retries = 0
        last_error = None
        last_error_type = None
        last_traceback = None
        while retries < self.max_retries:
            try:
                result = func(*args, **kwargs)
                return IsolationResult(
                    success=True, result=result,
                    retry_count=retries,
                    execution_time=time.time() - start
                )
            except Exception as e:
                retries += 1
                last_error = str(e)
                last_error_type = type(e).__name__
                last_traceback = traceback.format_exc()
                self._record_failure_pattern(
                    {"function": func.__name__, "error_type": type(e).__name__},
                    {"error": str(e)}
                )
                if retries < self.max_retries:
                    import time as _t
                    _t.sleep(self.retry_delay * retries)
        return IsolationResult(
            success=False, error=last_error or "Max retries exceeded",
            error_type=last_error_type,
            traceback=last_traceback,
            retry_count=retries,
            execution_time=time.time() - start
        )

    def execute_safely(self, func: Callable, *args,
                       fallback: Any = None, **kwargs) -> Any:
        """安全执行，失败返回默认值"""
        result = self.wrap(func, *args, **kwargs)
        return result.result if result.success else fallback

    # ================================================================
    # 免疫记忆 (v2 ImmuneSystem核心功能)
    # ================================================================

    def _record_failure_pattern(self, pattern: Dict, context: Optional[Dict] = None):
        """记录失败模式"""
        key = self._pattern_key(pattern)
        now = time.time()

        if key not in self._failure_patterns:
            self._failure_patterns[key] = {
                "pattern": pattern, "count": 0,
                "first_seen": now, "last_seen": now, "contexts": []
            }

        fp = self._failure_patterns[key]
        fp["count"] += 1
        fp["last_seen"] = now
        if context:
            fp["contexts"].append({"context": context, "timestamp": now})

        # 达到阈值 → 发射anomaly信号
        if fp["count"] >= self.failure_threshold:
            level = self._threat_level(fp["count"])
            self.signal.emit("sensor", "anomaly", {
                "level": level, "pattern": pattern,
                "count": fp["count"], "key": key
            }, strength={"low": 0.2, "medium": 0.5, "high": 0.7, "critical": 0.9}.get(level, 0.3))

            self._threat_history.append({
                "key": key, "pattern": pattern,
                "count": fp["count"], "level": level,
                "timestamp": now
            })

            # 威胁级别达到 critical → 自动加入黑名单
            if level == "critical":
                self._threat_blacklist.add(key)
                logger.warning(f"威胁已加入黑名单: {key}")

    def check_threat(self, context: Dict) -> bool:
        """检查上下文是否匹配已知威胁"""
        for key, fp in self._failure_patterns.items():
            if fp["count"] >= self.failure_threshold:
                if self._is_similar(context, fp["pattern"]):
                    return True
        ctx_key = self._pattern_key(context)
        return ctx_key in self._threat_blacklist

    def veto_check(self, rule: Dict) -> Dict:
        """否决权: 检查规则是否与已知失败模式冲突"""
        matched = []
        content = rule.get("content", "")
        for key, fp in self._failure_patterns.items():
            if fp["count"] >= self.failure_threshold:
                if self._rule_matches_pattern(content, fp["pattern"]):
                    matched.append({"key": key, "count": fp["count"],
                                    "level": self._threat_level(fp["count"])})

        if rule.get("source", "") in self._threat_blacklist:
            matched.append({"key": "blacklist", "count": -1, "level": "high"})

        veto = len(matched) > 0
        reason = (f"规则与 {len(matched)} 个失败模式冲突" if veto
                  else "规则未匹配已知失败模式")
        return {"veto": veto, "reason": reason, "matched": matched}

    def get_known_patterns(self) -> List[Dict]:
        self._cleanup_patterns()
        return [
            {"key": k, "pattern": v["pattern"], "count": v["count"],
             "level": self._threat_level(v["count"])}
            for k, v in self._failure_patterns.items()
        ]

    def clear_pattern(self, key: str):
        self._failure_patterns.pop(key, None)

    def clear_all_patterns(self):
        self._failure_patterns.clear()
        self._threat_blacklist.clear()
        self._threat_history.clear()

    # ================================================================
    # 环境感知: 能力边界追踪
    # ================================================================

    def record_boundary(self, action: str, result: str, cost: Optional[Dict] = None):
        """记录能力边界事件"""
        if action not in self._capability_bounds:
            self._capability_bounds[action] = {
                "attempts": 0, "successes": 0, "failures": 0,
                "avg_cost": 0, "last_result": None
            }
        b = self._capability_bounds[action]
        b["attempts"] += 1
        b["last_result"] = result
        if result == "success":
            b["successes"] += 1
        else:
            b["failures"] += 1
        if cost:
            # EMA更新平均成本
            alpha = 0.3
            for k, v in cost.items():
                if isinstance(v, (int, float)):
                    prev = b["avg_cost"] if isinstance(b["avg_cost"], (int, float)) else 0
                    b["avg_cost"] = prev * (1 - alpha) + v * alpha
        self._save_state()

    def can_execute(self, action: str) -> bool:
        """检查当前环境能否执行某动作"""
        b = self._capability_bounds.get(action)
        if not b or b["attempts"] < 2:
            return True  # 未知动作默认可执行
        success_rate = b["successes"] / b["attempts"]
        return success_rate > 0.2  # 成功率低于20%认为不可行

    def get_capabilities(self) -> Dict:
        return {k: {"success_rate": v["successes"] / max(v["attempts"], 1),
                     "attempts": v["attempts"]}
                for k, v in self._capability_bounds.items()}

    # ================================================================
    # 辅助方法
    # ================================================================

    def _pattern_key(self, pattern: Dict) -> str:
        return hashlib.md5(json.dumps(pattern, sort_keys=True).encode()).hexdigest()[:16]

    def _is_similar(self, a: Dict, b: Dict) -> bool:
        common = set(a.keys()) & set(b.keys())
        if not common:
            return False
        matches = sum(1 for k in common if a.get(k) == b.get(k))
        return matches / len(common) >= 0.7

    def _rule_matches_pattern(self, content: str, pattern: Dict) -> bool:
        import re
        p_words = set()
        for v in pattern.values():
            if isinstance(v, str):
                p_words.update(w for w in re.split(r'[\s_\-.,;:!?]+', v.lower()) if len(w) > 2)
        c_words = set(w for w in re.split(r'[\s_\-.,;:!?]+', content.lower()) if len(w) > 2)
        if not p_words or not c_words:
            return False
        overlap = p_words & c_words
        return len(overlap) / min(len(p_words), len(c_words)) >= 0.5

    def _threat_level(self, count: int) -> str:
        if count >= self.failure_threshold * 3:
            return "critical"
        elif count >= self.failure_threshold * 2:
            return "high"
        elif count >= self.failure_threshold:
            return "medium"
        return "low"

    def _cleanup_patterns(self):
        now = time.time()
        expired = [k for k, v in self._failure_patterns.items()
                   if now - v["last_seen"] > self.pattern_max_age]
        for k in expired:
            del self._failure_patterns[k]

    def get_summary(self) -> Dict:
        self._cleanup_patterns()
        levels = defaultdict(int)
        for v in self._failure_patterns.values():
            levels[self._threat_level(v["count"])] += 1
        return {
            "records_count": len(self._records),
            "total_success": self._total_success,
            "total_failure": self._total_failure,
            "failure_patterns": len(self._failure_patterns),
            "threat_levels": dict(levels),
            "capabilities_tracked": len(self._capability_bounds)
        }

    # ================================================================
    # 持久化
    # ================================================================

    def _save_state(self):
        self.persistence.save("sensor", {
            "records": self._records[-100:],  # 保留最近100条
            "record_index": self._record_index,
            "failure_patterns": self._failure_patterns,
            "threat_blacklist": list(self._threat_blacklist),
            "capability_bounds": self._capability_bounds,
            "total_success": self._total_success,
            "total_failure": self._total_failure
        })

    def _load_state(self):
        data = self.persistence.load("sensor")
        if data:
            self._records = data.get("records", [])
            self._record_index = data.get("record_index", 0)
            self._failure_patterns = data.get("failure_patterns", {})
            self._threat_blacklist = set(data.get("threat_blacklist", []))
            self._capability_bounds = data.get("capability_bounds", {})
            self._total_success = data.get("total_success", 0)
            self._total_failure = data.get("total_failure", 0)


_sensor = None

def get_sensor() -> Sensor:
    global _sensor
    if _sensor is None:
        _sensor = Sensor()
    return _sensor
