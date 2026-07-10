/**
 * Shared test initialization
 *
 * All test files import this module to initialize environment, database, and logger.
 * Avoids duplicate initialization conflicts.
 */

import { Database } from 'bun:sqlite'

// Set test environment variables
process.env.MODEL_PROVIDER = 'anthropic'
process.env.MODEL_ID = 'claude-sonnet-4-6'
process.env.MODEL_API_KEY = 'test-key'
process.env.DATA_DIR = '/tmp/XiaoJuClaw-test-' + Date.now()
process.env.LOG_LEVEL = 'error'

import { loadEnv } from '../src/config/index.ts'
import { initLogger } from '../src/logger/index.ts'
import { initDatabase, getDatabase } from '../src/db/index.ts'

// Initialize
loadEnv()
// loadEnv intentionally lets the repository .env override model variables.
// Restore the test credential afterwards so runtime resolution tests remain
// isolated from the developer/release .env contents.
process.env.MODEL_API_KEY = 'test-key'
initLogger()
initDatabase()

/** Clear all data tables */
export function cleanAllTables() {
  const db = getDatabase()
  db.run('DELETE FROM agentops_spans')
  db.run('DELETE FROM agentops_traces')
  db.run('DELETE FROM workflow_runs')
  db.run('DELETE FROM workflows')
  db.run('DELETE FROM messages')
  db.run('DELETE FROM chats')
  db.run('DELETE FROM documents')
  db.run('DELETE FROM document_chunks')
  db.run('DELETE FROM scheduled_tasks')
  db.run('DELETE FROM task_run_logs')
  db.run('DELETE FROM sessions')
  db.run('DELETE FROM browser_profile_runtime')
  db.run('DELETE FROM chat_browser_state')
  db.run('DELETE FROM browser_profiles')
}

/** Clear specified tables */
export function cleanTables(...tables: string[]) {
  const db = getDatabase()
  for (const table of tables) {
    db.run(`DELETE FROM ${table}`)
  }
}

export { getDatabase }
