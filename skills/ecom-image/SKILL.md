---
name: ecom-image
description: "电商主图批量处理：白底方图、裁剪到平台规格、压缩瘦身、加图片水印/logo、格式转换，支持整个文件夹批量。当用户要处理商品图/主图、做白底图、批量改尺寸、压缩图片、加水印、转格式时使用。Batch-process e-commerce product images locally: white-background square, fit/crop to platform size, compress, image watermark/logo overlay, format conversion. Runs offline with no API key. NOT for AI background removal or image generation."
tags:
  - ecommerce
  - image
  - batch
priority: normal
---

# 电商主图批量处理（ecom-image）

对本地商品图做确定性批量处理，输出到新目录。脚本为预打包单文件，只需 bun，**离线运行、无需任何 API Key、图片不出本机**。适合上架前把一堆产品图统一成平台规格。

## 能力与不能

**能**（本地确定性处理）：白底方图、缩放/裁剪到目标尺寸、压缩瘦身、叠加图片水印/logo、jpg⇄png 转换、整文件夹批量。

**不能**（需要 AI/联网，属后续能力）：智能抠图去杂色背景、AI 放大、文生图。本技能的"白底"是**把透明背景或留白铺成白底**，不是从复杂照片里抠出主体。

## 支持格式

输入/输出仅 `.jpg` / `.png`（webp 暂不支持）。

## 工作流

1. 跟用户确认：处理哪个模式、目标尺寸/参数、输入是单张还是整个文件夹。
2. 执行脚本（`--input` 可传单张图或一个目录；目录只处理第一层）：

```bash
bun scripts/image.mjs --mode <fit|compress|watermark|convert> --input <图片或目录> --outdir <输出目录> [选项] [--overwrite]
```

3. 解析 stdout 单行 JSON，把 `outdir` 与产物数量告知用户；产物统一写到「电商产出」目录下的子目录。

## 四种模式

### fit（缩放到平台规格 / 白底方图）

```bash
bun scripts/image.mjs --mode fit --input ./raw --outdir ./out --width 800 --height 800 --fit contain --bg #FFFFFF
```

- `--fit contain`（默认）：等比缩放不裁剪，四周用 `--bg`（默认白）补齐到精确尺寸 → **白底方图**（淘宝/京东主图常用 800×800、1000×1000、1200×1200）。
- `--fit cover`：等比缩放后居中裁剪填满，无留白（会裁掉超出部分）。

### compress（压缩瘦身）

```bash
bun scripts/image.mjs --mode compress --input ./out --outdir ./small --quality 75 --max 1600
```

- `--quality 1~100`（默认 80，仅对 jpg 生效）；`--max` 限制最长边像素（超出则等比缩小）。
- 想同时转 jpg 减小体积可加 `--format jpg`。

### watermark（图片水印 / logo）

```bash
bun scripts/image.mjs --mode watermark --input ./out --outdir ./wm --wm ./logo.png --pos bottom-right --opacity 0.5 --scale 0.2 --margin 16
```

- `--wm` 水印图（png 带透明更佳）；`--scale` 水印宽占主图宽的比例（默认 0.2）；`--opacity` 0~1（默认 0.5）。
- `--pos` 九宫格位置：`top-left|top-center|top-right|center-left|center|center-right|bottom-left|bottom-center|bottom-right`（默认 `bottom-right`）。
- **中文文字水印**做不了（纯图形库无中文字体）：请把文字先做成透明 png 当水印图传入。

### convert（格式转换）

```bash
bun scripts/image.mjs --mode convert --input ./raw --outdir ./png --format png
```

- `--format jpg|png`（必填）。

## 输出契约

- 成功：stdout 单行 JSON，退出码 0：

```json
{"ok":true,"mode":"fit","count":12,"outdir":"D:\\path\\out","outputs":["a.jpg","b.jpg"]}
```

- 失败：stderr 人类可读原因，退出码 1（stdout 同时给 `{"ok":false,"error":"..."}`）。

## 红线（必须遵守）

- **不覆盖原图**：只写 `--outdir`；输出与原图同路径或 `--outdir` 下已有同名文件时报错，需 `--overwrite` 才覆盖。
- 图片不出本机，零网络请求。
- 批量前建议先用 1 张图试跑确认参数，再整目录处理。
