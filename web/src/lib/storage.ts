// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
// Unified storage layer: Tauri -> Store (settings.json), Web -> localStorage

import type { StateStorage } from 'zustand/middleware'
import { deletePortableSetting, getPortableSetting, isTauri, savePortableSetting } from "@/api/transport"

const STORAGE_PREFIX = "XiaoJuClaw-"

export async function getItem(key: string): Promise<string | null> {
  if (isTauri) {
    return getPortableSetting(STORAGE_PREFIX + key)
  }
  return localStorage.getItem(STORAGE_PREFIX + key)
}

export async function setItem(key: string, value: string): Promise<void> {
  if (isTauri) {
    await savePortableSetting(STORAGE_PREFIX + key, value)
    return
  }
  localStorage.setItem(STORAGE_PREFIX + key, value)
}

export async function removeItem(key: string): Promise<void> {
  if (isTauri) {
    await deletePortableSetting(STORAGE_PREFIX + key)
    return
  }
  localStorage.removeItem(STORAGE_PREFIX + key)
}

export function createStateStorage(): StateStorage {
  return {
    getItem: async (name: string) => getItem(name),
    setItem: async (name: string, value: string) => setItem(name, value),
    removeItem: async (name: string) => removeItem(name),
  }
}
