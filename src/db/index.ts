// [XJC-PATCH] modified from upstream v0.0.178 — 详见 doc/侵入点清单.md
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getPaths } from '../config/index.ts'
import { getLogger } from '../logger/index.ts'

let _db: Database | null = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT NOT NULL,
  is_from_me INTEGER DEFAULT 0,
  is_bot_message INTEGER DEFAULT 0,
  tool_use_json TEXT,
  session_id TEXT,
  turn_id TEXT,
  error_code TEXT,
  PRIMARY KEY (id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, timestamp);

CREATE TABLE IF NOT EXISTS chats (
  chat_id TEXT PRIMARY KEY,
  name TEXT,
  agent_id TEXT,
  channel TEXT,
  is_group INTEGER DEFAULT 0,
  last_message_time TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_file TEXT,
  PRIMARY KEY (agent_id, chat_id)
);

CREATE TABLE IF NOT EXISTS kv_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  next_run TEXT,
  last_run TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_runs ON task_run_logs(task_id, run_at);

CREATE TABLE IF NOT EXISTS browser_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  driver TEXT NOT NULL DEFAULT 'managed',
  is_default INTEGER NOT NULL DEFAULT 0,
  executable_path TEXT,
  user_data_dir TEXT,
  cdp_port INTEGER,
  cdp_url TEXT,
  headless INTEGER NOT NULL DEFAULT 0,
  no_sandbox INTEGER NOT NULL DEFAULT 0,
  attach_only INTEGER NOT NULL DEFAULT 0,
  launch_args_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS browser_profile_runtime (
  profile_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  pid INTEGER,
  ws_endpoint TEXT,
  last_error TEXT,
  last_started_at TEXT,
  heartbeat_at TEXT
);

CREATE TABLE IF NOT EXISTS chat_browser_state (
  chat_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  active_target_id TEXT,
  active_page_url TEXT,
  active_page_title TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  label TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  source_type TEXT NOT NULL,
  status TEXT NOT NULL,
  source_path TEXT NOT NULL,
  markdown_path TEXT,
  json_path TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_documents_chat_status ON documents(chat_id, status, updated_at);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  page INTEGER,
  sheet TEXT,
  slide INTEGER,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_document_ordinal ON document_chunks(document_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_document_chunks_chat_document ON document_chunks(chat_id, document_id);

CREATE TABLE IF NOT EXISTS message_feedback (
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  agent_id TEXT,
  rating TEXT NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_feedback_agent_rating ON message_feedback(agent_id, rating);

CREATE TABLE IF NOT EXISTS chat_plans (
  chat_id TEXT PRIMARY KEY,
  agent_id TEXT,
  goal TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fulfillment_skus (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  title TEXT NOT NULL,
  delivery_template TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fulfillment_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  order_ref TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fulfillment_cards_sku_status ON fulfillment_cards(sku_id, status);

CREATE TABLE IF NOT EXISTS fulfillment_deliveries (
  order_ref TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL,
  card_id INTEGER NOT NULL,
  delivered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  agent_id TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  inputs_json TEXT NOT NULL DEFAULT '[]',
  budgets_json TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  run_count INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  current_step INTEGER NOT NULL DEFAULT 0,
  inputs_json TEXT NOT NULL DEFAULT '{}',
  outputs_json TEXT NOT NULL DEFAULT '[]',
  foreach_checkpoint_json TEXT,
  budgets_json TEXT,
  usage_json TEXT NOT NULL DEFAULT '{}',
  trace_id TEXT,
  chat_id TEXT NOT NULL,
  error TEXT,
  error_code TEXT,
  stop_reason TEXT,
  active_duration_ms INTEGER NOT NULL DEFAULT 0,
  active_started_at TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_wf ON workflow_runs(workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agentops_traces (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  agent_id TEXT,
  chat_id TEXT,
  turn_id TEXT,
  workflow_id TEXT,
  workflow_run_id TEXT,
  model_provider TEXT,
  model_id TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  unknown_cost_calls INTEGER NOT NULL DEFAULT 0,
  model_latency_ms INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  executed_steps INTEGER NOT NULL DEFAULT 0,
  skipped_steps INTEGER NOT NULL DEFAULT 0,
  active_duration_ms INTEGER NOT NULL DEFAULT 0,
  tool_names_json TEXT NOT NULL DEFAULT '[]',
  effect_classes_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  stop_reason TEXT,
  coverage TEXT NOT NULL DEFAULT 'partial',
  coverage_notes_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agentops_traces_started ON agentops_traces(started_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_agentops_traces_chat_turn ON agentops_traces(chat_id, turn_id);
CREATE INDEX IF NOT EXISTS idx_agentops_traces_workflow ON agentops_traces(workflow_id, workflow_run_id);

CREATE TABLE IF NOT EXISTS agentops_spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  parent_span_id TEXT,
  kind TEXT NOT NULL,
  name TEXT,
  status TEXT NOT NULL,
  agent_id TEXT,
  turn_id TEXT,
  workflow_step_id TEXT,
  workflow_step_index INTEGER,
  workflow_item_index INTEGER,
  model_provider TEXT,
  model_id TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  unknown_cost_calls INTEGER NOT NULL DEFAULT 0,
  model_latency_ms INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  executed_steps INTEGER NOT NULL DEFAULT 0,
  skipped_steps INTEGER NOT NULL DEFAULT 0,
  active_duration_ms INTEGER NOT NULL DEFAULT 0,
  tool_names_json TEXT NOT NULL DEFAULT '[]',
  effect_classes_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  stop_reason TEXT,
  coverage TEXT NOT NULL DEFAULT 'partial',
  coverage_notes_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agentops_spans_trace ON agentops_spans(trace_id, started_at, id);
`

// bun:sqlite query result type helpers
type SQLValue = string | number | boolean | null
function queryAll<T>(db: Database, sql: string, ...params: SQLValue[]): T[] {
  return db.query(sql).all(...params) as T[]
}

function queryGet<T>(db: Database, sql: string, ...params: SQLValue[]): T | null {
  const row = db.query(sql).get(...params)
  return (row as T) ?? null
}

export function initDatabase(): Database {
  if (_db) return _db

  const paths = getPaths()
  mkdirSync(dirname(paths.db), { recursive: true })

  // Windows: stale WAL/SHM files from a force-killed previous session can cause
  // "database is locked" or corruption errors. If the main .db exists but we can't
  // open it, remove the WAL/SHM files and retry.
  let retried = false
  const tryOpen = (): Database => {
    try {
      const db = new Database(paths.db)
      db.exec('PRAGMA journal_mode = WAL')
      return db
    } catch (err) {
      if (retried || process.platform !== 'win32') throw err

      // Clean up stale WAL/SHM lock files and retry once
      retried = true
      for (const suffix of ['-wal', '-shm']) {
        const lockFile = paths.db + suffix
        if (existsSync(lockFile)) {
          try {
            unlinkSync(lockFile)
            getLogger().warn({ file: lockFile }, 'Removed stale SQLite lock file')
          } catch {
            // File may be locked by another process
          }
        }
      }
      const db = new Database(paths.db)
      db.exec('PRAGMA journal_mode = WAL')
      return db
    }
  }

  _db = tryOpen()
  _db.exec('PRAGMA foreign_keys = ON')
  _db.exec(SCHEMA)

  // Migration: persist item-level progress for resumable workflow forEach steps
  try { _db.exec('ALTER TABLE workflow_runs ADD COLUMN foreach_checkpoint_json TEXT') } catch {}
  try { _db.exec('ALTER TABLE workflows ADD COLUMN budgets_json TEXT') } catch {}
  try { _db.exec('ALTER TABLE workflow_runs ADD COLUMN budgets_json TEXT') } catch {}
  try { _db.exec("ALTER TABLE workflow_runs ADD COLUMN usage_json TEXT NOT NULL DEFAULT '{}'") } catch {}
  try { _db.exec('ALTER TABLE workflow_runs ADD COLUMN trace_id TEXT') } catch {}
  try { _db.exec('ALTER TABLE workflow_runs ADD COLUMN error_code TEXT') } catch {}
  try { _db.exec('ALTER TABLE workflow_runs ADD COLUMN stop_reason TEXT') } catch {}
  try { _db.exec('ALTER TABLE workflow_runs ADD COLUMN active_duration_ms INTEGER NOT NULL DEFAULT 0') } catch {}
  try { _db.exec('ALTER TABLE workflow_runs ADD COLUMN active_started_at TEXT') } catch {}

  // Migration: add name and description columns
  try { _db.exec('ALTER TABLE scheduled_tasks ADD COLUMN name TEXT') } catch {}
  try { _db.exec('ALTER TABLE scheduled_tasks ADD COLUMN description TEXT') } catch {}

  // Migration: add concurrency guard, backoff, timezone, and last result columns
  try { _db.exec('ALTER TABLE scheduled_tasks ADD COLUMN running_since TEXT') } catch {}
  try { _db.exec('ALTER TABLE scheduled_tasks ADD COLUMN consecutive_failures INTEGER DEFAULT 0') } catch {}
  try { _db.exec('ALTER TABLE scheduled_tasks ADD COLUMN timezone TEXT') } catch {}
  try { _db.exec('ALTER TABLE scheduled_tasks ADD COLUMN last_result TEXT') } catch {}

  // Migration: add delivery config columns
  try { _db.exec("ALTER TABLE scheduled_tasks ADD COLUMN delivery_mode TEXT DEFAULT 'none'") } catch {}
  try { _db.exec('ALTER TABLE scheduled_tasks ADD COLUMN delivery_target TEXT') } catch {}

  // Migration: add delivery status column to run logs
  try { _db.exec('ALTER TABLE task_run_logs ADD COLUMN delivery_status TEXT') } catch {}

  // Query indexes for task filtering and scheduler scans
  _db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent_created_at ON scheduled_tasks(agent_id, created_at DESC)')
  _db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent_chat_name ON scheduled_tasks(agent_id, chat_id, name)')
  _db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status_next_run ON scheduled_tasks(status, next_run)')
  _db.exec('CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_running_since ON scheduled_tasks(running_since)')

  // Migration: add attachments column
  try { _db.exec('ALTER TABLE messages ADD COLUMN attachments TEXT') } catch {}
  try { _db.exec('ALTER TABLE messages ADD COLUMN tool_use_json TEXT') } catch {}
  try { _db.exec('ALTER TABLE messages ADD COLUMN session_id TEXT') } catch {}
  try { _db.exec('ALTER TABLE messages ADD COLUMN turn_id TEXT') } catch {}
  try { _db.exec('ALTER TABLE messages ADD COLUMN error_code TEXT') } catch {}

  // Migration: add chat avatar column
  try { _db.exec('ALTER TABLE chats ADD COLUMN avatar TEXT') } catch {}

  // Migration: persist pi session file path for reliable resume
  try { _db.exec('ALTER TABLE sessions ADD COLUMN session_file TEXT') } catch {}

  // Browser profile migrations
  try { _db.exec("ALTER TABLE browser_profiles ADD COLUMN driver TEXT NOT NULL DEFAULT 'managed'") } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN executable_path TEXT') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN user_data_dir TEXT') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN cdp_port INTEGER') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN cdp_url TEXT') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN headless INTEGER NOT NULL DEFAULT 0') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN no_sandbox INTEGER NOT NULL DEFAULT 0') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN attach_only INTEGER NOT NULL DEFAULT 0') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN launch_args_json TEXT') } catch {}
  try { _db.exec('ALTER TABLE browser_profiles ADD COLUMN updated_at TEXT') } catch {}

  getLogger().info({ path: paths.db }, 'Database initialized')
  return _db
}

export function getDatabase(): Database {
  if (!_db) throw new Error('Database not initialized')
  return _db
}

// ===== Message Operations =====

export function saveMessage(msg: {
  id: string
  chatId: string
  sender: string
  senderName: string
  content: string
  timestamp: string
  isFromMe: boolean
  isBotMessage: boolean
  attachments?: string
  toolUse?: string
  sessionId?: string
  turnId?: string
  errorCode?: string
}) {
  const db = getDatabase()
  db.run(
    `INSERT OR REPLACE INTO messages (
       id, chat_id, sender, sender_name, content, timestamp,
       is_from_me, is_bot_message, attachments, tool_use_json,
       session_id, turn_id, error_code
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      msg.id,
      msg.chatId,
      msg.sender,
      msg.senderName,
      msg.content,
      msg.timestamp,
      msg.isFromMe ? 1 : 0,
      msg.isBotMessage ? 1 : 0,
      msg.attachments ?? null,
      msg.toolUse ?? null,
      msg.sessionId ?? null,
      msg.turnId ?? null,
      msg.errorCode ?? null,
    ]
  )
}

export function getMessages(chatId: string, limit = 50, before?: string): Array<{
  id: string; chat_id: string; sender: string; sender_name: string
  content: string; timestamp: string; is_from_me: number; is_bot_message: number
  attachments: string | null; tool_use_json: string | null; session_id: string | null
  turn_id: string | null; error_code: string | null
}> {
  const db = getDatabase()
  if (before) {
    return queryAll(db,
      `SELECT * FROM messages WHERE chat_id = ? AND timestamp < ? ORDER BY timestamp DESC LIMIT ?`,
      chatId, before, limit)
  }
  return queryAll(db,
    `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`,
    chatId, limit)
}

// ===== Chat Operations =====

export function upsertChat(chatId: string, agentId: string, name?: string, channel = 'web') {
  const db = getDatabase()
  const avatar = `gradient:${Math.floor(Math.random() * 8)}`
  const explicitName = name ?? null
  db.run(
    `INSERT INTO chats (chat_id, name, agent_id, channel, last_message_time, avatar)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       name = CASE WHEN ? IS NULL THEN chats.name ELSE excluded.name END,
       last_message_time = excluded.last_message_time`,
    [
      chatId,
      name ?? chatId,
      agentId,
      channel,
      new Date().toISOString(),
      avatar,
      explicitName,
    ]
  )
}

export function getChats(): Array<{
  chat_id: string; name: string; agent_id: string; channel: string;
  last_message_time: string; last_message: string | null; avatar: string | null
}> {
  const db = getDatabase()
  return queryAll(db, `
    SELECT c.chat_id, c.name, c.agent_id, c.channel, c.last_message_time, c.avatar,
           (SELECT m.content FROM messages m WHERE m.chat_id = c.chat_id ORDER BY m.timestamp DESC LIMIT 1) AS last_message
    FROM chats c
    ORDER BY c.last_message_time DESC
  `)
}

export function updateChatFields(chatId: string, updates: { name?: string; avatar?: string }) {
  const db = getDatabase()
  const fields: string[] = []
  const values: (string | null)[] = []

  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
  if (updates.avatar !== undefined) { fields.push('avatar = ?'); values.push(updates.avatar) }

  if (fields.length === 0) return

  values.push(chatId)
  db.run(`UPDATE chats SET ${fields.join(', ')} WHERE chat_id = ?`, values)
}

export function deleteChat(chatId: string) {
  const db = getDatabase()
  db.run('DELETE FROM messages WHERE chat_id = ?', [chatId])
  db.run('DELETE FROM chats WHERE chat_id = ?', [chatId])
}

// ===== Session Operations =====

export function getSessionEntry(agentId: string, chatId: string): {
  sessionId: string
  sessionFile: string | null
} | null {
  const db = getDatabase()
  const row = queryGet<{ session_id: string; session_file: string | null }>(
    db,
    'SELECT session_id, session_file FROM sessions WHERE agent_id = ? AND chat_id = ?',
    agentId,
    chatId,
  )
  if (!row) return null
  return {
    sessionId: row.session_id,
    sessionFile: row.session_file ?? null,
  }
}

export function getSession(agentId: string, chatId: string): string | null {
  return getSessionEntry(agentId, chatId)?.sessionId ?? null
}

export function saveSession(agentId: string, chatId: string, sessionId: string, sessionFile?: string | null) {
  const db = getDatabase()
  db.run(
    `INSERT OR REPLACE INTO sessions (agent_id, chat_id, session_id, session_file) VALUES (?, ?, ?, ?)`,
    [agentId, chatId, sessionId, sessionFile ?? null]
  )
}

export function deleteSession(agentId: string, chatId: string) {
  const db = getDatabase()
  db.run('DELETE FROM sessions WHERE agent_id = ? AND chat_id = ?', [agentId, chatId])
}

// ===== Scheduled Task Operations =====

export interface ScheduledTask {
  id: string
  agent_id: string
  chat_id: string
  prompt: string
  schedule_type: string
  schedule_value: string
  next_run: string | null
  last_run: string | null
  status: string
  created_at: string
  name: string | null
  description: string | null
  running_since: string | null
  consecutive_failures: number
  timezone: string | null
  last_result: string | null
  delivery_mode: string | null
  delivery_target: string | null
}

export interface TaskRunLog {
  id: number
  task_id: string
  run_at: string
  duration_ms: number
  status: string
  result: string | null
  error: string | null
  delivery_status: string | null
}

export function createTask(task: {
  id: string
  agentId: string
  chatId: string
  prompt: string
  scheduleType: string
  scheduleValue: string
  nextRun: string
  name?: string
  description?: string
  timezone?: string
  deliveryMode?: string
  deliveryTarget?: string
}): void {
  const db = getDatabase()
  db.run(
    `INSERT INTO scheduled_tasks (id, agent_id, chat_id, prompt, schedule_type, schedule_value, next_run, created_at, name, description, timezone, delivery_mode, delivery_target)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [task.id, task.agentId, task.chatId, task.prompt, task.scheduleType, task.scheduleValue, task.nextRun, new Date().toISOString(), task.name ?? null, task.description ?? null, task.timezone ?? null, task.deliveryMode ?? 'none', task.deliveryTarget ?? null]
  )
}

export function getTasks(): ScheduledTask[] {
  const db = getDatabase()
  return queryAll<ScheduledTask>(db, 'SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
}

export function getTask(id: string): ScheduledTask | null {
  const db = getDatabase()
  return queryGet<ScheduledTask>(db, 'SELECT * FROM scheduled_tasks WHERE id = ?', id)
}

export function updateTask(id: string, updates: Partial<{
  prompt: string
  scheduleType: string
  scheduleValue: string
  status: string
  nextRun: string | null
  lastRun: string
  name: string | null
  description: string
  runningSince: string | null
  consecutiveFailures: number
  timezone: string | null
  lastResult: string | null
  deliveryMode: string
  deliveryTarget: string | null
}>): void {
  const db = getDatabase()
  const fields: string[] = []
  const values: (string | number | null)[] = []

  if (updates.prompt !== undefined) { fields.push('prompt = ?'); values.push(updates.prompt) }
  if (updates.scheduleType !== undefined) { fields.push('schedule_type = ?'); values.push(updates.scheduleType) }
  if (updates.scheduleValue !== undefined) { fields.push('schedule_value = ?'); values.push(updates.scheduleValue) }
  if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status) }
  if (updates.nextRun !== undefined) { fields.push('next_run = ?'); values.push(updates.nextRun) }
  if (updates.lastRun !== undefined) { fields.push('last_run = ?'); values.push(updates.lastRun) }
  if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
  if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description) }
  if (updates.runningSince !== undefined) { fields.push('running_since = ?'); values.push(updates.runningSince) }
  if (updates.consecutiveFailures !== undefined) { fields.push('consecutive_failures = ?'); values.push(updates.consecutiveFailures) }
  if (updates.timezone !== undefined) { fields.push('timezone = ?'); values.push(updates.timezone) }
  if (updates.lastResult !== undefined) { fields.push('last_result = ?'); values.push(updates.lastResult) }
  if (updates.deliveryMode !== undefined) { fields.push('delivery_mode = ?'); values.push(updates.deliveryMode) }
  if (updates.deliveryTarget !== undefined) { fields.push('delivery_target = ?'); values.push(updates.deliveryTarget) }

  if (fields.length === 0) return

  values.push(id)
  db.run(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`, values)
}

export function deleteTask(id: string): void {
  const db = getDatabase()
  db.run('DELETE FROM scheduled_tasks WHERE id = ?', [id])
  db.run('DELETE FROM task_run_logs WHERE task_id = ?', [id])
}

export function getTasksDueBy(time: string): ScheduledTask[] {
  const db = getDatabase()
  return queryAll<ScheduledTask>(db,
    `SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ? AND running_since IS NULL`,
    time)
}

/** Query stuck tasks (running_since before the threshold) */
export function getStuckTasks(cutoffIso: string): ScheduledTask[] {
  const db = getDatabase()
  return queryAll<ScheduledTask>(db,
    `SELECT * FROM scheduled_tasks WHERE running_since IS NOT NULL AND running_since <= ?`,
    cutoffIso)
}

/** Prune expired run logs */
export function pruneOldTaskRunLogs(retainDays: number): number {
  const db = getDatabase()
  const cutoff = new Date(Date.now() - retainDays * 24 * 60 * 60 * 1000).toISOString()
  const result = db.run('DELETE FROM task_run_logs WHERE run_at < ?', [cutoff])
  return result.changes
}

// ===== Run Logs =====

export function saveTaskRunLog(log: {
  taskId: string
  runAt: string
  durationMs: number
  status: string
  result?: string
  error?: string
  deliveryStatus?: string
}): void {
  const db = getDatabase()
  db.run(
    `INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error, delivery_status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [log.taskId, log.runAt, log.durationMs, log.status, log.result ?? null, log.error ?? null, log.deliveryStatus ?? null]
  )
}

export function getTaskRunLogs(taskId: string, limit = 50): TaskRunLog[] {
  const db = getDatabase()
  return queryAll<TaskRunLog>(db,
    'SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?',
    taskId, limit)
}

// ===== Browser Profile Operations =====

export interface BrowserProfile {
  id: string
  name: string
  driver?: string
  is_default?: number
  executable_path?: string | null
  user_data_dir?: string | null
  cdp_port?: number | null
  cdp_url?: string | null
  headless?: number
  no_sandbox?: number
  attach_only?: number
  launch_args_json?: string | null
  created_at: string
  updated_at?: string | null
}

export function createBrowserProfile(profile: { id: string; name: string }): void {
  const db = getDatabase()
  const now = new Date().toISOString()
  const userDataDir = resolve(getPaths().browserProfiles, profile.id)
  db.run(
    `INSERT INTO browser_profiles (
      id, name, driver, is_default, executable_path, user_data_dir, cdp_port, cdp_url,
      headless, no_sandbox, attach_only, launch_args_json, created_at, updated_at
    ) VALUES (?, ?, 'managed', 0, NULL, ?, NULL, NULL, 0, 0, 0, '[]', ?, ?)`,
    [profile.id, profile.name, userDataDir, now, now]
  )
}

export function getBrowserProfiles(): BrowserProfile[] {
  const db = getDatabase()
  return queryAll<BrowserProfile>(db, 'SELECT * FROM browser_profiles ORDER BY created_at DESC')
}

export function getBrowserProfile(id: string): BrowserProfile | null {
  const db = getDatabase()
  return queryGet<BrowserProfile>(db, 'SELECT * FROM browser_profiles WHERE id = ?', id)
}

export function deleteBrowserProfile(id: string): void {
  const db = getDatabase()
  db.run('DELETE FROM browser_profiles WHERE id = ?', [id])
}

// ===== Channel Operations =====

export interface ChannelRecord {
  id: string
  type: string
  label: string
  config: string        // JSON string
  enabled: number       // 0 | 1
  created_at: string
  updated_at: string
}

export function createChannelRecord(record: {
  id: string
  type: string
  label: string
  config: string
  enabled?: boolean
}): ChannelRecord {
  const db = getDatabase()
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO channels (id, type, label, config, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [record.id, record.type, record.label, record.config, record.enabled === false ? 0 : 1, now, now]
  )
  return getChannelRecord(record.id)!
}

export function getChannelRecords(): ChannelRecord[] {
  const db = getDatabase()
  return queryAll<ChannelRecord>(db, 'SELECT * FROM channels ORDER BY created_at ASC')
}

export function getChannelRecord(id: string): ChannelRecord | null {
  const db = getDatabase()
  return queryGet<ChannelRecord>(db, 'SELECT * FROM channels WHERE id = ?', id)
}

export function updateChannelRecord(id: string, updates: Partial<{
  label: string
  config: string
  enabled: boolean
}>): ChannelRecord | null {
  const db = getDatabase()
  const fields: string[] = []
  const values: (string | number)[] = []

  if (updates.label !== undefined) { fields.push('label = ?'); values.push(updates.label) }
  if (updates.config !== undefined) { fields.push('config = ?'); values.push(updates.config) }
  if (updates.enabled !== undefined) { fields.push('enabled = ?'); values.push(updates.enabled ? 1 : 0) }

  if (fields.length === 0) return getChannelRecord(id)

  fields.push('updated_at = ?')
  values.push(new Date().toISOString())
  values.push(id)

  db.run(`UPDATE channels SET ${fields.join(', ')} WHERE id = ?`, values)
  return getChannelRecord(id)
}

export function deleteChannelRecord(id: string): void {
  const db = getDatabase()
  db.run('DELETE FROM channels WHERE id = ?', [id])
}

// ===== Skill Settings =====

export type SkillSettings = Record<string, { enabled: boolean }>

export function getSkillSettings(): SkillSettings {
  const db = getDatabase()
  const row = queryGet<{ value: string }>(db, "SELECT value FROM kv_state WHERE key = 'skill_settings'")
  if (!row) return {}
  try {
    return JSON.parse(row.value) as SkillSettings
  } catch {
    return {}
  }
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  const db = getDatabase()
  const settings = getSkillSettings()
  settings[name] = { enabled }
  db.run(
    "INSERT OR REPLACE INTO kv_state (key, value) VALUES ('skill_settings', ?)",
    [JSON.stringify(settings)]
  )
}
