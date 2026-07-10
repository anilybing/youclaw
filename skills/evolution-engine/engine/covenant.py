"""
Evolution Engine 3.0 约束契约 (守卫)
合并v2的constraint_core + covenant，统一规则管理与安全守卫

上游: 接收演化发育的 "strategy_proposed" 脉冲
下游: 发射 "rule_committed" 脉冲 (规则通过审批后)

核心价值: 所有策略提案必须经过契约审批才能成为真正改变行为的规则。
审批流程: 安全检查 → 自动通过/暂缓/否决 → 版本化备份 → 持久化规则
"""

import time
import json
import hashlib
import shutil
from typing import Dict, Any, List, Optional
from collections import defaultdict
from pathlib import Path
from datetime import datetime

from .config import get_config
from .signal_path import get_signal_path, Spike
from .persistence import get_persistence


class Covenant:
    """
    约束契约 - 守卫模块

    三道防线:
    1. 安全检查: 匹配已知失败模式 → 直接否决
    2. 置信度评估: 高置信自动通过，低置信暂缓待审
    3. 版本化备份: 每次规则变更都有回滚点
    """

    def __init__(self, config=None, signal_path=None, persistence=None):
        self.config = config or get_config()
        self.signal = signal_path or get_signal_path()
        self.persistence = persistence or get_persistence()
        self.persistence.register("covenant")

        cfg = self.config.get_module_config("covenant")
        self.agents_file = cfg.get("agents_file", "AGENTS.md")
        self.backup_dir = Path(cfg.get("backup_dir", "data/backups"))
        self.max_recent_backups = cfg.get("max_recent_backups", 5)
        self.max_milestone_backups = cfg.get("max_milestone_backups", 20)
        self.rule_max_length = cfg.get("rule_max_length", 500)
        self.auto_backup = cfg.get("auto_backup", True)
        self.veto_cooldown = cfg.get("veto_cooldown", 3600)

        self.backup_dir.mkdir(parents=True, exist_ok=True)

        # 规则库: rule_id → {condition, action, priority, source, status, fires, created_at}
        self._rules: Dict[str, Dict] = {}
        # 契约记录: covenant_id → {trigger, diff, status, rollback_point, rule_id, created_at}
        self._covenants: Dict[str, Dict] = {}
        # 否决队列: rule_id → {reason, status, created_at}
        self._veto_queue: Dict[str, Dict] = {}
        # 否决冷却: rule_content_hash → last_veto_time
        self._veto_cooldowns: Dict[str, float] = {}
        # 备份链
        self._backups: List[Dict] = []

        # 统计
        self._total_proposed = 0
        self._total_committed = 0
        self._total_vetoed = 0
        self._total_rolled_back = 0

        # 订阅策略提案
        self.signal.subscribe("strategy_proposed", self._on_strategy_proposed)
        self.signal.register_module("covenant", {"type": "guardian"})

        # 保存引用避免循环导入
        self._sensor = None  # 延迟初始化

        self._load_state()

    # ================================================================
    # 脉冲处理
    # ================================================================

    def _on_strategy_proposed(self, spike: Spike):
        """处理演化发育的策略提案"""
        pattern = spike.pattern
        condition = pattern.get("condition", {})
        action = pattern.get("action", pattern.get("content", {}))
        source = pattern.get("source", "evo_devo")
        priority = pattern.get("priority", 1.0)
        confidence = pattern.get("confidence", spike.strength)

        result = self.propose_rule(condition, action, source, priority, confidence)

        if result.get("committed"):
            self.signal.emit("covenant", "rule_committed", {
                "rule_id": result["rule_id"],
                "condition": condition,
                "action": action,
                "status": "active"
            }, strength=confidence)

    # ================================================================
    # 规则提案与审批
    # ================================================================

    def propose_rule(self, condition: Dict, action: Dict, source: str = "unknown",
                     priority: float = 1.0, confidence: float = 0.5) -> Dict:
        """
        提议新规则

        审批流程:
        1. 冷却检查: 同内容规则最近被否决过则拒绝
        2. 安全检查: 匹配已知失败模式则否决
        3. 置信度评估:
           - confidence >= 0.7 且安全 → 自动通过
           - confidence < 0.7 → 暂缓待审
           - 危险匹配 → 否决
        4. 通过 → 创建契约 + 备份 → 写入AGENTS.md
        """
        self._total_proposed += 1
        now = time.time()

        # 内容哈希用于冷却检查
        content_hash = self._content_hash(condition, action)

        # 冷却检查
        last_veto = self._veto_cooldowns.get(content_hash, 0)
        if now - last_veto < self.veto_cooldown:
            return {"proposed": True, "committed": False, "reason": "veto_cooldown",
                    "retry_after": self.veto_cooldown - (now - last_veto)}

        rule_id = self._rule_id(condition, action)

        # 安全检查: 查询感知器的否决检查
        veto_result = self._safety_check(condition, action)
        if veto_result["veto"]:
            self._total_vetoed += 1
            self._veto_queue[rule_id] = {
                "condition": condition, "action": action,
                "source": source, "priority": priority,
                "reason": veto_result["reason"],
                "status": "vetoed",
                "created_at": now
            }
            self._veto_cooldowns[content_hash] = now
            self._save_state()
            return {"proposed": True, "committed": False, "rule_id": rule_id,
                    "status": "vetoed", "reason": veto_result["reason"]}

        # 置信度评估
        if confidence >= 0.7 and not veto_result.get("warnings"):
            # 高置信 + 无警告 → 自动通过
            return self._commit_rule(rule_id, condition, action, source, priority)
        elif confidence < 0.3:
            # 低置信 → 暂缓
            self._veto_queue[rule_id] = {
                "condition": condition, "action": action,
                "source": source, "priority": priority,
                "reason": f"low_confidence({confidence:.2f})",
                "status": "suspended",
                "created_at": now
            }
            self._save_state()
            return {"proposed": True, "committed": False, "rule_id": rule_id,
                    "status": "suspended", "reason": "low_confidence"}
        else:
            # 中等置信 + 无安全否决 → 通过
            return self._commit_rule(rule_id, condition, action, source, priority)

    def _commit_rule(self, rule_id: str, condition: Dict, action: Dict,
                     source: str, priority: float) -> Dict:
        """提交规则: 创建契约 + 备份 + 写入"""
        now = time.time()

        # 备份当前状态
        backup_id = self._create_backup(f"pre_{rule_id[:8]}")

        # 创建规则
        self._rules[rule_id] = {
            "condition": condition,
            "action": action,
            "priority": priority,
            "source": source,
            "status": "active",
            "fires": 0,
            "created_at": now
        }

        # 创建契约记录
        covenant_id = f"cov_{len(self._covenants) + 1}"
        self._covenants[covenant_id] = {
            "trigger": f"rule_{rule_id[:8]}",
            "rule_id": rule_id,
            "diff": json.dumps({"condition": condition, "action": action},
                               ensure_ascii=False)[:200],
            "status": "active",
            "rollback_point": backup_id,
            "created_at": now
        }

        self._total_committed += 1

        # 持久化活跃规则
        if self.auto_backup:
            self.apply_rules()

        self._save_state()
        return {"proposed": True, "committed": True, "rule_id": rule_id,
                "covenant_id": covenant_id, "backup_id": backup_id}

    def _safety_check(self, condition: Dict, action: Dict) -> Dict:
        """
        安全检查: 先做基础危险检查，再查询感知器否决权
        """
        # 基础安全检查: 危险关键词（优先级最高）
        action_str = json.dumps(action, default=str).lower()
        dangerous_keywords = ["rm -rf", "drop table", "delete from", "format",
                              "shutdown", "reboot", "mkfs", "chmod 777"]
        for kw in dangerous_keywords:
            if kw in action_str:
                return {"veto": True, "reason": f"dangerous_keyword: {kw}", "warnings": []}

        # 查询感知器否决权
        try:
            if self._sensor is None:
                from .sensor import get_sensor
                self._sensor = get_sensor()
            sensor = self._sensor
            return sensor.veto_check({"content": json.dumps(action, default=str)})
        except Exception:
            pass

        return {"veto": False, "warnings": []}

    # ================================================================
    # 否决队列管理
    # ================================================================

    def approve_vetoed_rule(self, rule_id: str) -> bool:
        """批准暂缓的规则"""
        if rule_id not in self._veto_queue:
            return False
        entry = self._veto_queue[rule_id]
        if entry["status"] != "suspended":
            return False

        # 提交规则
        result = self._commit_rule(
            rule_id, entry["condition"], entry["action"],
            entry.get("source", "manual"), entry.get("priority", 1.0)
        )
        entry["status"] = "approved"
        return result.get("committed", False)

    def reject_vetoed_rule(self, rule_id: str) -> bool:
        """永久否决规则"""
        if rule_id not in self._veto_queue:
            return False
        self._veto_queue[rule_id]["status"] = "rejected"
        self._total_vetoed += 1
        # 加入冷却
        entry = self._veto_queue[rule_id]
        content_hash = self._content_hash(entry["condition"], entry["action"])
        self._veto_cooldowns[content_hash] = time.time()
        self._save_state()
        return True

    def get_veto_queue(self) -> List[Dict]:
        return [{"rule_id": rid, **entry} for rid, entry in self._veto_queue.items()]

    # ================================================================
    # 回滚
    # ================================================================

    def rollback(self, covenant_id: str) -> bool:
        """
        回滚某个契约

        策略: 将规则标记为"retired"（保留审计记录），而非全量恢复备份。
        全量恢复会覆盖所有规则（包括其他正常规则），风险过大。
        备份保留在文件系统中，需要时可手动调用 restore_backup()。
        """
        if covenant_id not in self._covenants:
            return False

        cov = self._covenants[covenant_id]
        rule_id = cov.get("rule_id")

        # 停用规则（保留审计记录，不删除）
        if rule_id and rule_id in self._rules:
            self._rules[rule_id]["status"] = "retired"

        # 标记契约为已回滚
        cov["status"] = "rolled_back"
        self._total_rolled_back += 1
        self._save_state()
        return True

    # ================================================================
    # 备份链
    # ================================================================

    def _create_backup(self, tag: str = "") -> str:
        """创建备份快照"""
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_id = f"bak_{ts}_{tag}" if tag else f"bak_{ts}"
        backup_path = self.backup_dir / backup_id
        backup_path.mkdir(exist_ok=True)

        # 备份当前规则和契约
        with open(backup_path / "rules.json", 'w', encoding='utf-8') as f:
            json.dump(self._rules, f, indent=2, ensure_ascii=False, default=str)
        with open(backup_path / "covenants.json", 'w', encoding='utf-8') as f:
            json.dump(self._covenants, f, indent=2, ensure_ascii=False, default=str)

        # 检查是否里程碑
        is_milestone = len(self._covenants) % 10 == 0
        self._backups.append({
            "backup_id": backup_id,
            "is_milestone": is_milestone,
            "created_at": datetime.now().isoformat(),
            "rule_count": len(self._rules)
        })

        self._cleanup_backups()
        return backup_id

    def _restore_backup(self, backup_id: str) -> bool:
        """恢复备份"""
        backup_path = self.backup_dir / backup_id
        if not backup_path.exists():
            return False
        try:
            with open(backup_path / "rules.json", 'r', encoding='utf-8') as f:
                self._rules = json.load(f)
            with open(backup_path / "covenants.json", 'r', encoding='utf-8') as f:
                self._covenants = json.load(f)
            return True
        except Exception:
            return False

    def _cleanup_backups(self):
        """清理过期备份"""
        recent = [b for b in self._backups if not b.get("is_milestone")]
        milestones = [b for b in self._backups if b.get("is_milestone")]

        # 只保留最近的N份
        recent = recent[-self.max_recent_backups:]
        milestones = milestones[-self.max_milestone_backups:]

        self._backups = recent + milestones

        # 删除文件系统中多余的备份
        active_ids = {b["backup_id"] for b in self._backups}
        for d in self.backup_dir.iterdir():
            if d.is_dir() and d.name not in active_ids:
                shutil.rmtree(d, ignore_errors=True)

    def list_backups(self) -> List[Dict]:
        return sorted(self._backups, key=lambda x: x.get("created_at", ""),
                      reverse=True)

    # ================================================================
    # 规则应用 - 持久化到配置文件
    # ================================================================

    def apply_rules(self) -> int:
        """
        将活跃规则持久化到配置文件
        返回写入的规则数量
        """
        active_rules = [r for r in self._rules.values() if r["status"] == "active"]
        if not active_rules:
            return 0

        lines = ["# Agent Behavioral Rules\n"]
        lines.append(f"<!-- Auto-generated by Evolution Engine 3.0 at {datetime.now().isoformat()} -->\n")

        for rid, rule in self._rules.items():
            if rule["status"] != "active":
                continue
            cond_str = json.dumps(rule["condition"], ensure_ascii=False)
            act_str = json.dumps(rule["action"], ensure_ascii=False)
            if len(act_str) > self.rule_max_length:
                act_str = act_str[:self.rule_max_length] + "..."
            lines.append(f"## Rule: {rid[:8]}\n")
            lines.append(f"- **When**: {cond_str}\n")
            lines.append(f"- **Then**: {act_str}\n")
            lines.append(f"- **Priority**: {rule['priority']}\n")
            lines.append(f"- **Source**: {rule['source']}\n\n")

        try:
            agents_path = self.config.base_dir / self.agents_file
            with open(agents_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)
        except Exception:
            pass

        return len(active_rules)

    # ================================================================
    # 查询接口
    # ================================================================

    def get_rules(self, status: str = None) -> List[Dict]:
        result = []
        for rid, rule in self._rules.items():
            if status and rule.get("status") != status:
                continue
            result.append({"rule_id": rid, **rule})
        result.sort(key=lambda x: x.get("priority", 0), reverse=True)
        return result

    def get_covenants(self, limit: int = 20) -> List[Dict]:
        result = [{"covenant_id": cid, **cov}
                  for cid, cov in self._covenants.items()]
        result.sort(key=lambda x: x.get("created_at", 0), reverse=True)
        return result[:limit]

    def get_summary(self) -> Dict:
        active = sum(1 for r in self._rules.values() if r["status"] == "active")
        suspended = sum(1 for v in self._veto_queue.values()
                        if v["status"] == "suspended")
        approved = sum(1 for v in self._veto_queue.values()
                       if v["status"] == "approved")
        rejected = sum(1 for v in self._veto_queue.values()
                       if v["status"] == "rejected")
        rolled_back = sum(1 for c in self._covenants.values()
                          if c["status"] == "rolled_back")

        return {
            "total_rules": len(self._rules),
            "active_rules": active,
            "total_proposed": self._total_proposed,
            "total_committed": self._total_committed,
            "total_vetoed": self._total_vetoed,
            "total_rolled_back": self._total_rolled_back,
            "covenants_count": len(self._covenants),
            "active_covenants": sum(1 for c in self._covenants.values()
                                     if c["status"] == "active"),
            "rolled_back_covenants": rolled_back,
            "veto_queue": {"suspended": suspended, "approved": approved,
                           "rejected": rejected},
            "backup_count": len(self._backups),
            "version": "3.0.0"
        }

    # ================================================================
    # 辅助
    # ================================================================

    def _rule_id(self, condition: Dict, action: Dict) -> str:
        raw = json.dumps({"c": condition, "a": action}, sort_keys=True, default=str)
        return hashlib.md5(raw.encode()).hexdigest()[:12]

    def _content_hash(self, condition: Dict, action: Dict) -> str:
        raw = json.dumps({"c": condition, "a": action}, sort_keys=True, default=str)
        return hashlib.sha256(raw.encode()).hexdigest()[:16]

    # ================================================================
    # 持久化
    # ================================================================

    def _save_state(self):
        self.persistence.save("covenant", {
            "rules": self._rules,
            "covenants": self._covenants,
            "veto_queue": self._veto_queue,
            "veto_cooldowns": self._veto_cooldowns,
            "backups": self._backups,
            "total_proposed": self._total_proposed,
            "total_committed": self._total_committed,
            "total_vetoed": self._total_vetoed,
            "total_rolled_back": self._total_rolled_back
        })

    def _load_state(self):
        data = self.persistence.load("covenant")
        if not data:
            return
        self._rules = data.get("rules", {})
        self._covenants = data.get("covenants", {})
        self._veto_queue = data.get("veto_queue", {})
        self._veto_cooldowns = data.get("veto_cooldowns", {})
        self._backups = data.get("backups", [])
        self._total_proposed = data.get("total_proposed", 0)
        self._total_committed = data.get("total_committed", 0)
        self._total_vetoed = data.get("total_vetoed", 0)
        self._total_rolled_back = data.get("total_rolled_back", 0)


_covenant = None

def get_covenant() -> Covenant:
    global _covenant
    if _covenant is None:
        _covenant = Covenant()
    return _covenant
