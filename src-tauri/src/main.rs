// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    XiaoJuClaw_lib::run()
}
