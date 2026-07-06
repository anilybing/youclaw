// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
// @ts-nocheck
import path from "node:path";
import { getPaths, resolvePathInput } from "../../../../config/paths.ts";

/** Resolve the compatibility state directory under XiaoJuClaw's writable data root. */
export function resolveStateDir(): string {
  try {
    return path.join(getPaths().data, "openclaw-compat");
  } catch {
    const dataDir = process.env.DATA_DIR?.trim();
    return dataDir
      ? path.resolve(resolvePathInput(dataDir), "openclaw-compat")
      : path.resolve("/tmp", "XiaoJuClaw-openclaw-compat");
  }
}
