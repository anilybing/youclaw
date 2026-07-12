# 一次性转换：BAAI/bge-small-zh-v1.5 (safetensors) -> ONNX -> int8 动态量化
# 产物: out/model.onnx (量化) + 语义 sanity 验证
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "pylibs"))

import numpy as np
import torch
from transformers import AutoModel

OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)
FP32 = os.path.join(OUT, "model_fp32.onnx")
INT8 = os.path.join(OUT, "model.onnx")

print("[1/4] loading model ...")
model = AutoModel.from_pretrained(HERE)
model.eval()

print("[2/4] exporting ONNX (opset 14) ...")


class Wrapper(torch.nn.Module):
    def __init__(self, inner):
        super().__init__()
        self.inner = inner

    def forward(self, input_ids, attention_mask, token_type_ids):
        out = self.inner(
            input_ids=input_ids,
            attention_mask=attention_mask,
            token_type_ids=token_type_ids,
            return_dict=True,
        )
        return out.last_hidden_state


wrapped = Wrapper(model)
wrapped.eval()
ids = torch.ones(2, 16, dtype=torch.long)
mask = torch.ones(2, 16, dtype=torch.long)
tt = torch.zeros(2, 16, dtype=torch.long)
torch.onnx.export(
    wrapped,
    (ids, mask, tt),
    FP32,
    input_names=["input_ids", "attention_mask", "token_type_ids"],
    output_names=["last_hidden_state"],
    dynamic_axes={
        "input_ids": {0: "batch", 1: "seq"},
        "attention_mask": {0: "batch", 1: "seq"},
        "token_type_ids": {0: "batch", 1: "seq"},
        "last_hidden_state": {0: "batch", 1: "seq"},
    },
    opset_version=14,
    dynamo=False,
)
print("  fp32 size: %.1f MB" % (os.path.getsize(FP32) / 1e6))

print("[3/4] dynamic int8 quantization ...")
from onnxruntime.quantization import QuantType, quantize_dynamic

quantize_dynamic(FP32, INT8, weight_type=QuantType.QInt8)
print("  int8 size: %.1f MB" % (os.path.getsize(INT8) / 1e6))

print("[4/4] semantic sanity with onnxruntime + tokenizers ...")
import onnxruntime as ort
from tokenizers import Tokenizer

tok = Tokenizer.from_file(os.path.join(HERE, "tokenizer.json"))
sess = ort.InferenceSession(INT8, providers=["CPUExecutionProvider"])
input_names = set(i.name for i in sess.get_inputs())


def embed(texts):
    encs = [tok.encode(t) for t in texts]
    maxlen = max(len(e.ids) for e in encs)
    ids = np.zeros((len(encs), maxlen), dtype=np.int64)
    mask = np.zeros((len(encs), maxlen), dtype=np.int64)
    for i, e in enumerate(encs):
        ids[i, : len(e.ids)] = e.ids
        mask[i, : len(e.ids)] = 1
    feeds = {"input_ids": ids, "attention_mask": mask}
    if "token_type_ids" in input_names:
        feeds["token_type_ids"] = np.zeros_like(ids)
    out = sess.run(None, feeds)[0]
    cls = out[:, 0]
    return cls / np.linalg.norm(cls, axis=1, keepdims=True)


v = embed(["发票", "这个月的报销单据在哪里", "一只可爱的小猫在晒太阳", "开具增值税发票"])
sim = v @ v.T
print("  sim(发票, 报销单据)   = %.4f" % sim[0, 1])
print("  sim(发票, 小猫晒太阳) = %.4f" % sim[0, 2])
print("  sim(发票, 开增值税票) = %.4f" % sim[0, 3])
assert sim[0, 1] > sim[0, 2] + 0.05, "semantic ordering failed"
assert sim[0, 3] > sim[0, 2] + 0.05, "semantic ordering failed"
print("SANITY OK")
