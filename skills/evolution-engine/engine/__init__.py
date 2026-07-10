"""
Evolution Engine 3.0 - 三阶八柱架构

三阶: 感知阶(Perceptual) → 推理阶(Rational) → 策略阶(Strategic)
八柱: 感知器 | 世界模型 | 因果推理 | 符号推理 | 概念形成 | 演化发育 | 元认知调控 | 约束契约
"""

__version__ = "3.0.1"

from .config import get_config
from .persistence import get_persistence
from .signal_path import get_signal_path
from .sensor import get_sensor, Sensor
from .world_model import get_world_model, WorldModel
from .causal import get_causal_reasoning, CausalReasoning
from .symbolic import get_symbolic_reasoning, SymbolicReasoning
from .concept import get_concept, Concept
from .evo_devo import get_evo_devo, EvoDevo
from .metacognitive import get_metacognitive, Metacognitive
from .covenant import get_covenant, Covenant


def get_all_modules() -> dict:
    """获取所有模块实例"""
    return {
        "sensor": get_sensor(),
        "world_model": get_world_model(),
        "causal": get_causal_reasoning(),
        "symbolic": get_symbolic_reasoning(),
        "concept": get_concept(),
        "evo_devo": get_evo_devo(),
        "metacognitive": get_metacognitive(),
        "covenant": get_covenant(),
        "signal_path": get_signal_path(),
    }


def init_engine(base_dir: str = None):
    """初始化引擎（确保所有模块加载并注册信号订阅）"""
    cfg = get_config(base_dir)
    modules = get_all_modules()
    return {"version": __version__, "modules": list(modules.keys())}


def flush_all():
    """
    强制所有模块持久化状态

    CLI 独立进程模式下，信号在内存中同步传递，
    但进程退出后内存数据丢失。
    必须在每次写入操作后调用 flush_all()，
    确保信号驱动的状态变更被写入磁盘。

    调用时机: record / evolve 等写入命令执行完毕后
    """
    import logging
    logger = logging.getLogger("engine.flush")
    modules = get_all_modules()
    saved = []
    for name, mod in modules.items():
        if hasattr(mod, '_save_state'):
            try:
                mod._save_state()
                saved.append(name)
            except Exception as e:
                saved.append(f"{name}(ERROR: {e})")
                logger.error(f"Failed to flush {name}: {e}")
    logger.debug(f"Flushed modules: {saved}")
    return saved
