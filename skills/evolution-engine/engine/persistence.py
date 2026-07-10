"""
Evolution Engine 3.0 统一持久化
根治v2数据不持久化问题
"""

import json
import time
import shutil
from pathlib import Path
from typing import Any, Optional, List, Dict
from datetime import datetime


class CorruptedFileError(Exception):
    """文件损坏且无法恢复"""
    pass


class PersistenceManager:
    """
    统一持久化管理器
    - 原子写入（先写.tmp再rename）
    - 全量快照与恢复
    - 数据损坏自动恢复
    """

    def __init__(self, data_dir: Path):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.snapshot_dir = self.data_dir / "snapshots"
        self.snapshot_dir.mkdir(exist_ok=True)
        self._registered: set = set()

    def register(self, module_name: str):
        self._registered.add(module_name)

    def save(self, module_name: str, data: Any) -> bool:
        self._registered.add(module_name)
        file_path = self.data_dir / f"{module_name}.json"
        try:
            payload = {
                "module": module_name,
                "version": "3.0.0",
                "timestamp": time.time(),
                "saved_at": datetime.now().isoformat(),
                "data": data
            }
            tmp = file_path.with_suffix(".tmp")
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(payload, f, indent=2, ensure_ascii=False, default=str)
            tmp.replace(file_path)
            return True
        except Exception:
            return False

    def load(self, module_name: str, default: Any = None) -> Any:
        file_path = self.data_dir / f"{module_name}.json"
        if not file_path.exists():
            return default  # 文件不存在是正常情况
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                payload = json.load(f)
            return payload.get("data", default)
        except json.JSONDecodeError as e:
            # 文件损坏，尝试恢复
            recovered = self._try_recover(file_path)
            if recovered is not None:
                import logging
                logging.warning(f"Recovered corrupted file: {file_path}")
                return recovered
            # 恢复失败，抛出异常让调用方区分“损坏”与“不存在”
            raise CorruptedFileError(f"File corrupted and unrecoverable: {file_path}") from e
        except Exception:
            raise CorruptedFileError(f"Failed to load file: {file_path}")

    def _try_recover(self, path: Path) -> Any:
        try:
            content = path.read_text(encoding='utf-8')
            if not content.strip().endswith("}"):
                content = content.rsplit("}", 1)[0] + "}}"
            return json.loads(content).get("data")
        except Exception:
            return None

    def create_snapshot(self, tag: str = "") -> str:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        name = f"snap_{ts}_{tag}" if tag else f"snap_{ts}"
        snap = self.snapshot_dir / name
        snap.mkdir(exist_ok=True)
        for f in self.data_dir.glob("*.json"):
            if f.name != "config.json":
                shutil.copy2(f, snap / f.name)
        return name

    def restore_snapshot(self, name: str) -> bool:
        snap = self.snapshot_dir / name
        if not snap.exists():
            return False
        for f in snap.glob("*.json"):
            shutil.copy2(f, self.data_dir / f.name)
        return True

    def list_snapshots(self) -> List[Dict]:
        result = []
        for d in sorted(self.snapshot_dir.iterdir()):
            if d.is_dir() and d.name.startswith("snap_"):
                result.append({
                    "name": d.name,
                    "files": len(list(d.glob("*.json"))),
                    "created": datetime.fromtimestamp(d.stat().st_mtime).isoformat()
                })
        return result

    def get_stats(self) -> Dict:
        modules = []
        for name in self._registered:
            f = self.data_dir / f"{name}.json"
            if f.exists():
                modules.append({"module": name, "size": f.stat().st_size})
        return {"registered": len(self._registered), "saved": len(modules), "modules": modules}


_persistence = None

def get_persistence(data_dir: Optional[str] = None) -> PersistenceManager:
    global _persistence
    if _persistence is None:
        from .config import get_config
        cfg = get_config()
        _persistence = PersistenceManager(Path(data_dir) if data_dir else cfg.data_dir)
    return _persistence
