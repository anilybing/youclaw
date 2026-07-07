// @bun
// src/file-organizer/cli.ts
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { homedir } from "os";
var CATEGORY_BY_EXT = {
  ".doc": "\u6587\u6863",
  ".docx": "\u6587\u6863",
  ".pdf": "\u6587\u6863",
  ".txt": "\u6587\u6863",
  ".md": "\u6587\u6863",
  ".rtf": "\u6587\u6863",
  ".wps": "\u6587\u6863",
  ".xls": "\u8868\u683C",
  ".xlsx": "\u8868\u683C",
  ".csv": "\u8868\u683C",
  ".et": "\u8868\u683C",
  ".ppt": "\u6F14\u793A",
  ".pptx": "\u6F14\u793A",
  ".dps": "\u6F14\u793A",
  ".jpg": "\u56FE\u7247",
  ".jpeg": "\u56FE\u7247",
  ".png": "\u56FE\u7247",
  ".gif": "\u56FE\u7247",
  ".webp": "\u56FE\u7247",
  ".bmp": "\u56FE\u7247",
  ".svg": "\u56FE\u7247",
  ".mp3": "\u97F3\u89C6\u9891",
  ".wav": "\u97F3\u89C6\u9891",
  ".mp4": "\u97F3\u89C6\u9891",
  ".mov": "\u97F3\u89C6\u9891",
  ".avi": "\u97F3\u89C6\u9891",
  ".mkv": "\u97F3\u89C6\u9891",
  ".zip": "\u538B\u7F29\u5305",
  ".rar": "\u538B\u7F29\u5305",
  ".7z": "\u538B\u7F29\u5305",
  ".tar": "\u538B\u7F29\u5305",
  ".gz": "\u538B\u7F29\u5305",
  ".exe": "\u7A0B\u5E8F",
  ".msi": "\u7A0B\u5E8F",
  ".bat": "\u7A0B\u5E8F",
  ".ps1": "\u7A0B\u5E8F"
};
function fail(message) {
  console.error(message);
  process.exit(1);
}
function parseArgs(argv) {
  let dir = "";
  let rule = "";
  let apply = false;
  for (let i = 0;i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir")
      dir = argv[++i] ?? "";
    else if (arg === "--rule")
      rule = argv[++i] ?? "";
    else if (arg === "--apply")
      apply = true;
  }
  if (!dir)
    fail("\u7F3A\u5C11 --dir \u53C2\u6570\uFF08\u8981\u6574\u7406\u7684\u76EE\u5F55\uFF09");
  if (rule !== "bytype" && rule !== "bydate")
    fail("--rule \u5FC5\u987B\u4E3A bytype \u6216 bydate");
  return { dir: resolve(dir), rule, apply };
}
function assertSafeDir(dir) {
  if (!existsSync(dir))
    fail(`\u76EE\u5F55\u4E0D\u5B58\u5728: ${dir}`);
  if (!statSync(dir).isDirectory())
    fail(`\u4E0D\u662F\u76EE\u5F55: ${dir}`);
  if (/^[a-zA-Z]:[\\/]?$/.test(dir) || dir === "/")
    fail("\u5B89\u5168\u4FDD\u62A4\uFF1A\u4E0D\u5141\u8BB8\u6574\u7406\u78C1\u76D8\u6839\u76EE\u5F55");
  const home = resolve(homedir());
  if (resolve(dir) === home)
    fail("\u5B89\u5168\u4FDD\u62A4\uFF1A\u4E0D\u5141\u8BB8\u6574\u7406\u7528\u6237\u4E3B\u76EE\u5F55\u672C\u8EAB\uFF0C\u8BF7\u6307\u5B9A\u5176\u4E2D\u7684\u5B50\u76EE\u5F55");
  const lower = dir.toLowerCase();
  if (lower.includes("\\windows") || lower.includes("\\program files") || lower.includes("xiaojuclawdata\\tools")) {
    fail("\u5B89\u5168\u4FDD\u62A4\uFF1A\u7CFB\u7EDF\u76EE\u5F55\u6216\u5DE5\u5177\u76EE\u5F55\u4E0D\u5141\u8BB8\u6574\u7406");
  }
}
function categorize(file, rule, dir) {
  if (rule === "bytype") {
    return CATEGORY_BY_EXT[extname(file).toLowerCase()] ?? "\u5176\u4ED6";
  }
  const mtime = statSync(join(dir, file)).mtime;
  return `${mtime.getFullYear()}-${String(mtime.getMonth() + 1).padStart(2, "0")}`;
}
function buildPlan(dir, rule) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const plan = [];
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    if (entry.name.startsWith(".") || entry.name.toLowerCase() === "desktop.ini" || entry.name === "\u6574\u7406\u62A5\u544A.md")
      continue;
    const category = categorize(entry.name, rule, dir);
    plan.push({ from: join(dir, entry.name), to: join(dir, category, entry.name), category });
  }
  return plan;
}
function resolveConflict(target) {
  if (!existsSync(target))
    return target;
  const ext = extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let i = 1;i < 1000; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!existsSync(candidate))
      return candidate;
  }
  fail(`\u540C\u540D\u6587\u4EF6\u8FC7\u591A\uFF0C\u65E0\u6CD5\u5B89\u7F6E: ${basename(target)}`);
}
function applyPlan(dir, plan) {
  let moved = 0;
  const lines = ["# \u6574\u7406\u62A5\u544A", "", `- \u76EE\u5F55\uFF1A${dir}`, `- \u65F6\u95F4\uFF1A${new Date().toLocaleString("zh-CN")}`, ""];
  const byCategory = new Map;
  for (const item of plan) {
    mkdirSync(join(dir, item.category), { recursive: true });
    const target = resolveConflict(item.to);
    renameSync(item.from, target);
    moved += 1;
    const list = byCategory.get(item.category) ?? [];
    list.push(`${basename(item.from)}${target !== item.to ? `\uFF08\u91CD\u540D\uFF0C\u5B58\u4E3A ${basename(target)}\uFF09` : ""}`);
    byCategory.set(item.category, list);
  }
  for (const [category, files] of byCategory) {
    lines.push(`## ${category}\uFF08${files.length}\uFF09`, ...files.map((f) => `- ${f}`), "");
  }
  lines.push("> \u672C\u6B21\u6574\u7406\u53EA\u505A\u79FB\u52A8\uFF0C\u672A\u5220\u9664\u4EFB\u4F55\u6587\u4EF6\uFF1B\u5982\u9700\u64A4\u9500\uFF0C\u628A\u6587\u4EF6\u4ECE\u5206\u7C7B\u5B50\u76EE\u5F55\u79FB\u56DE\u5373\u53EF\u3002");
  const reportPath = join(dir, "\u6574\u7406\u62A5\u544A.md");
  writeFileSync(reportPath, lines.join(`
`), "utf8");
  return { moved, report: reportPath };
}
function main() {
  const { dir, rule, apply } = parseArgs(process.argv.slice(2));
  assertSafeDir(dir);
  const plan = buildPlan(dir, rule);
  if (!apply) {
    console.log(JSON.stringify({
      ok: true,
      dryRun: true,
      dir,
      rule,
      count: plan.length,
      moves: plan.map((p) => ({ from: basename(p.from), to: join(p.category, basename(p.from)) }))
    }));
    return;
  }
  const { moved, report } = applyPlan(dir, plan);
  console.log(JSON.stringify({ ok: true, dryRun: false, dir, rule, moved, report }));
}
main();
