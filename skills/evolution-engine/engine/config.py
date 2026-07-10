"""
Evolution Engine 3.0 配置管理
三阶八柱架构全局配置

三阶: 感知阶 → 推理阶 → 策略阶
八柱: 感知器 | 世界模型 | 因果推理 | 符号推理 | 概念形成 | 演化发育 | 元认知调控 | 约束契约
"""

import json
from pathlib import Path
from typing import Dict, Any, Optional


class Config:
    """配置管理 - 三阶八柱所有模块参数"""

    VERSION = "3.0.0"

    def __init__(self, base_dir: Optional[str] = None):
        self.base_dir = Path(base_dir) if base_dir else Path(__file__).parent.parent
        self.data_dir = self.base_dir / "data"
        self.data_dir.mkdir(exist_ok=True)
        self.config = self._defaults()
        self._load()

    def _defaults(self) -> Dict[str, Any]:
        return {
            # === 感知阶 (Perceptual Order) ===
            "sensor": {
                "max_retries": 3,
                "retry_delay": 1.0,
                "anomaly_threshold": 0.7,
                "pattern_max_age": 86400,
                "failure_threshold": 3,
                "threat_cooldown": 300
            },

            # === 推理阶 (Rational Order) ===
            "world_model": {
                "max_states": 5000,
                "simulation_depth": 3,
                "transition_decay": 0.95,
                "min_sample_size": 3
            },
            "causal": {
                "max_graph_nodes": 200,
                "intervention_confidence": 0.7,
                "counterfactual_samples": 10
            },
            "symbolic": {
                "max_rules": 200,
                "verification_strictness": 0.8
            },

            # === 策略阶 (Strategic Order) ===
            "concept": {
                "clustering_threshold": 0.6,
                "max_concepts": 500,
                "abstraction_min_examples": 3,
                "transfer_threshold": 0.5
            },
            "evo_devo": {
                "population_size": 50,
                "crossover_rate": 0.5,
                "mutation_rate": 0.3,
                "elite_ratio": 0.2,
                "developmental_stages": ["embryonic", "juvenile", "mature", "expert"],
                "stage_thresholds": [3, 10, 30],  # 成功次数阈值
                "max_strategies": 1000,
                "weight_decay": 0.95,
                "min_weight": 0.1
            },

            # === 元认知调控 (核心) ===
            "metacognitive": {
                "monitoring_window": 50,
                "adaptation_rate": 0.05,
                "exploration_rate": 0.1,
                "stagnation_threshold": 10,
                "min_observations_for_meta": 20
            },

            # === 约束契约 (守卫) ===
            "covenant": {
                "agents_file": "AGENTS.md",
                "backup_dir": "data/backups",
                "max_recent_backups": 5,
                "max_milestone_backups": 20,
                "rule_max_length": 500,
                "auto_backup": True,
                "veto_cooldown": 3600
            },

            # === 基础设施 ===
            "signal": {
                "spike_ttl": 300,
                "throttle_window_ms": 100,
                "max_queue": 1000
            },
            "persistence": {
                "auto_save": True,
                "save_interval": 60
            },
            "heartbeat": {
                "interval_minutes": 30,
                "auto_analyze": True,
                "min_confidence": 0.6
            }
        }

    def _load(self):
        f = self.data_dir / "config.json"
        if f.exists():
            try:
                with open(f, 'r', encoding='utf-8') as fh:
                    self._deep_update(self.config, json.load(fh))
            except Exception:
                pass

    def _deep_update(self, base: Dict, update: Dict):
        for k, v in update.items():
            if k in base and isinstance(base[k], dict) and isinstance(v, dict):
                self._deep_update(base[k], v)
            else:
                base[k] = v

    def save(self):
        with open(self.data_dir / "config.json", 'w', encoding='utf-8') as f:
            json.dump(self.config, f, indent=2, ensure_ascii=False)

    def get(self, key: str, default: Any = None) -> Any:
        parts = key.split(".")
        val = self.config
        for p in parts:
            if isinstance(val, dict):
                val = val.get(p)
                if val is None:
                    return default
            else:
                return default
        return val

    def set(self, key: str, value: Any):
        parts = key.split(".")
        cfg = self.config
        for p in parts[:-1]:
            cfg = cfg.setdefault(p, {})
        cfg[parts[-1]] = value

    def get_module_config(self, module: str) -> Dict:
        return self.config.get(module, {})


_config = None

def get_config(base_dir: Optional[str] = None) -> Config:
    global _config
    if _config is None:
        _config = Config(base_dir=base_dir)
    return _config
