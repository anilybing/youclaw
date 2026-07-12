// [XJC] 本地智能 Python 脚本源（内嵌为 TS 字符串，运行时物料化到 pytools/scripts/）
//
// 为什么内嵌而不是独立 .py 资源文件：sidecar 以 bun 编译为单文件二进制，源码内字符串
// 随二进制走、零打包改动；物料化按内容哈希幂等重写，应用升级自动带新脚本（同 evolution 引擎思路）。
//
// 两个脚本都遵守同一约定：
// - 依赖来自 `pip install --target <site-packages>`（不用 venv——venv 的 pyvenv.cfg 锁绝对路径，
//   U 盘换盘符即废；--target 目录天然可搬运），脚本开头从 XJC_PYTOOLS_SITE 环境变量注入 sys.path
//   （Windows 嵌入式 Python 的 ._pth 会忽略 PYTHONPATH，脚本内 sys.path.insert 不受影响）。
// - stdout 只输出协议 JSON（最后一行为准），诊断信息走 stderr。

/** OCR 一次性 CLI：`python ocr_cli.py <imagePath>` → 单行 JSON（lines: [{text, score}]） */
export const OCR_CLI_PY = `\
import json
import os
import sys
import time

site = os.environ.get("XJC_PYTOOLS_SITE")
if site and site not in sys.path:
    sys.path.insert(0, site)


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "usage: ocr_cli.py <image_path>"})
        return 2
    path = sys.argv[1]
    if not os.path.isfile(path):
        emit({"ok": False, "error": "image file not found"})
        return 1
    t0 = time.time()
    try:
        try:
            from rapidocr_onnxruntime import RapidOCR  # rapidocr 1.x
        except ImportError:
            from rapidocr import RapidOCR  # rapidocr 2.x

        engine = RapidOCR()
        result = engine(path)
        lines = []
        if isinstance(result, tuple):
            items = result[0] or []
            for item in items:
                try:
                    lines.append({"text": str(item[1]), "score": round(float(item[2]), 4)})
                except Exception:
                    continue
        else:
            texts = list(getattr(result, "txts", None) or [])
            scores = list(getattr(result, "scores", None) or [])
            for i, t in enumerate(texts):
                s = float(scores[i]) if i < len(scores) else 0.0
                lines.append({"text": str(t), "score": round(s, 4)})
        emit({"ok": True, "lines": lines, "elapsed_ms": int((time.time() - t0) * 1000)})
        return 0
    except Exception as e:
        emit({"ok": False, "error": str(e)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
`

/**
 * Embedding 常驻 worker：`python embed_worker.py <modelDir>`，stdin/stdout JSONL。
 * 请求 {"id":n,"op":"ping"|"embed"|"shutdown","texts":[...]}
 * 响应 {"id":n,"ok":true,"vectors":[[...]]}（BGE：CLS pooling + L2 归一化，向量已归一化可用点积当余弦）
 */
export const EMBED_WORKER_PY = `\
import json
import os
import sys

site = os.environ.get("XJC_PYTOOLS_SITE")
if site and site not in sys.path:
    sys.path.insert(0, site)


def reply(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        reply({"id": None, "ok": False, "error": "usage: embed_worker.py <model_dir>"})
        return 2
    model_dir = sys.argv[1]
    try:
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        tok = Tokenizer.from_file(os.path.join(model_dir, "tokenizer.json"))
        tok.enable_truncation(max_length=512)
        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
        sess = ort.InferenceSession(
            os.path.join(model_dir, "model.onnx"), sess_options=so, providers=["CPUExecutionProvider"]
        )
        input_names = set(i.name for i in sess.get_inputs())
    except Exception as e:
        reply({"id": None, "ok": False, "error": "init failed: " + str(e)})
        return 1

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        op = req.get("op")
        if op == "ping":
            reply({"id": rid, "ok": True})
            continue
        if op == "shutdown":
            reply({"id": rid, "ok": True})
            break
        if op != "embed":
            reply({"id": rid, "ok": False, "error": "unknown op"})
            continue
        texts = req.get("texts") or []
        if not isinstance(texts, list) or len(texts) == 0:
            reply({"id": rid, "ok": True, "vectors": []})
            continue
        try:
            import numpy as np

            encs = [tok.encode(str(t)) for t in texts]
            maxlen = max(len(e.ids) for e in encs)
            ids = np.zeros((len(encs), maxlen), dtype=np.int64)
            mask = np.zeros((len(encs), maxlen), dtype=np.int64)
            for i, e in enumerate(encs):
                ids[i, : len(e.ids)] = e.ids
                mask[i, : len(e.ids)] = 1
            feeds = {"input_ids": ids, "attention_mask": mask}
            if "token_type_ids" in input_names:
                feeds["token_type_ids"] = np.zeros((len(encs), maxlen), dtype=np.int64)
            out = sess.run(None, feeds)[0]
            cls = out[:, 0]
            norm = np.linalg.norm(cls, axis=1, keepdims=True)
            norm[norm == 0] = 1.0
            vecs = cls / norm
            reply({
                "id": rid,
                "ok": True,
                "vectors": [[round(float(x), 6) for x in v] for v in vecs],
            })
        except Exception as e:
            reply({"id": rid, "ok": False, "error": str(e)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
`
