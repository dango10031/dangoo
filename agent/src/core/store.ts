import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AgentEvent, Message, Run, Selection, Session, ToolResult, WaitRequest } from '../contracts/index.js';
import type { Checkpoint, ResultPage, StoreRunInput, StoreSessionInput, StoredJob, StoredOperation, StoredPendingCall } from './types.js';

type Sqlite = Database.Database;
type Row = Record<string, unknown>;

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parse<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function optionalString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function rowToSession(row: Row): Session {
  return {
    id: String(row.id),
    scope: { ownerId: String(row.owner_id), canvasId: String(row.canvas_id) },
    createdAt: Number(row.created_at),
    providerId: String(row.provider_id),
    model: String(row.model),
  };
}

function rowToRun(row: Row): Run {
  const run: Run = {
    id: String(row.id),
    sessionId: String(row.session_id),
    turnId: String(row.turn_id),
    state: String(row.state) as Run['state'],
    providerId: String(row.provider_id),
    model: String(row.model),
    providerRevision: String(row.provider_revision),
    toolRevision: String(row.tool_revision),
    skillRevision: String(row.skill_revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  const wait = parse<WaitRequest | undefined>(row.wait_json, undefined);
  if (wait) run.wait = wait;
  const error = optionalString(row.error);
  if (error) run.error = error;
  return run;
}

function rowToMessage(row: Row): Message {
  const message: Message = {
    id: String(row.id),
    role: String(row.role) as Message['role'],
    content: parse<Message['content']>(row.content_json, []),
    createdAt: Number(row.created_at),
  };
  const calls = parse<Message['toolCalls']>(row.tool_calls_json, undefined);
  if (calls) message.toolCalls = calls;
  const callId = optionalString(row.call_id);
  if (callId) message.callId = callId;
  return message;
}

export type CreateSessionRecord = StoreSessionInput;

export interface CreateRunRecord extends StoreRunInput {
  requestId?: string;
  selection?: unknown;
  skillNames?: string[];
  snapshot?: unknown;
}

export interface AppendEventInput {
  sessionId: string;
  runId?: string;
  turnId?: string;
  type: string;
  data: Record<string, unknown>;
  createdAt?: number;
  sequence?: number;
}

export interface SaveOperationInput {
  operationId: string;
  sessionId: string;
  runId?: string;
  callId?: string;
  toolName: string;
  effect: StoredOperation['effect'];
  fingerprint: string;
  state: StoredOperation['state'];
  arguments: unknown;
  result?: ToolResult;
  error?: StoredOperation['error'];
  createdAt?: number;
  updatedAt?: number;
}

export interface SaveJobInput extends Omit<StoredJob, 'updatedAt'> {
  updatedAt?: number;
}

/**
 * Small durable store for the Agent kernel. Every externally observable event,
 * model message, operation and job is persisted before the runtime publishes it.
 * The store intentionally contains references and snapshots only; canvas files
 * and business records stay behind the injected gateways.
 */
export class SqliteStore {
  readonly path: string;
  private readonly db: Sqlite;

  constructor(path = ':memory:') {
    this.path = path;
    if (path !== ':memory:' && path !== '') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path || ':memory:');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_scope ON agent_sessions(owner_id, canvas_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_canvas_sessions (
        owner_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id),
        PRIMARY KEY(owner_id, canvas_id)
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL,
        state TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_revision TEXT NOT NULL,
        tool_revision TEXT NOT NULL,
        skill_revision TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        wait_json TEXT,
        error TEXT,
        stop_requested INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session ON agent_runs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_active ON agent_runs(state);
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        tool_calls_json TEXT,
        call_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(session_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON agent_messages(session_id, ordinal);
      CREATE TABLE IF NOT EXISTS agent_events (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        run_id TEXT,
        turn_id TEXT,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON agent_events(run_id, sequence);
      CREATE TABLE IF NOT EXISTS agent_operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        call_id TEXT,
        tool_name TEXT NOT NULL,
        effect TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        arguments_json TEXT NOT NULL,
        result_json TEXT,
        error_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operations_run ON agent_operations(run_id, created_at);
      CREATE TABLE IF NOT EXISTS agent_jobs (
        id TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL REFERENCES agent_operations(operation_id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        node_id TEXT NOT NULL,
        state TEXT NOT NULL,
        remote_id TEXT,
        results_json TEXT NOT NULL,
        storage_state TEXT NOT NULL,
        apply_state TEXT NOT NULL,
        error TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_run ON agent_jobs(run_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_state ON agent_jobs(state);
      CREATE TABLE IF NOT EXISTS agent_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        state_json TEXT NOT NULL,
        summary_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_message_ordinal INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON agent_checkpoints(session_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS agent_results (
        ref TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        operation_id TEXT,
        value_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_requests (
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS agent_run_inputs (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        selection_json TEXT,
        skill_names_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_pending_calls (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        call_json TEXT NOT NULL,
        selection_json TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, position)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_calls_session ON agent_pending_calls(session_id, run_id, position);
      CREATE TABLE IF NOT EXISTS agent_run_snapshots (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        snapshot_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_pending_waits (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        wait_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    // Keep databases created by an earlier development build readable while
    // switching checkpoint recovery from wall-clock timestamps to message
    // ordinals (clock skew and same-millisecond writes must not resurrect old
    // compacted messages).
    const checkpointColumns = this.db.prepare(`PRAGMA table_info(agent_checkpoints)`).all() as Array<{ name?: string }>;
    if (!checkpointColumns.some((column) => column.name === 'last_message_ordinal')) this.db.exec(`ALTER TABLE agent_checkpoints ADD COLUMN last_message_ordinal INTEGER NOT NULL DEFAULT 0`);
    this.db.prepare(`INSERT OR IGNORE INTO schema_meta(key,value) VALUES('version','1')`).run();
  }

  close(): void {
    if (this.db.open) this.db.close();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  createSession(input: CreateSessionRecord): Session {
    // The write lock covers legacy selection and insertion across connections.
    // Existing duplicate histories remain addressable; the oldest is canonical.
    return this.db.transaction(() => {
      const mapped = this.db.prepare('SELECT session_id FROM agent_canvas_sessions WHERE owner_id = ? AND canvas_id = ?')
        .get(input.ownerId, input.canvasId) as Row | undefined;
      if (mapped) return this.getSession(String(mapped.session_id))!;
      const existing = this.db.prepare('SELECT * FROM agent_sessions WHERE owner_id = ? AND canvas_id = ? ORDER BY created_at ASC, id ASC LIMIT 1')
        .get(input.ownerId, input.canvasId) as Row | undefined;
      if (!existing) this.db.prepare(`INSERT INTO agent_sessions(id,owner_id,canvas_id,created_at,provider_id,model) VALUES(?,?,?,?,?,?)`)
        .run(input.id, input.ownerId, input.canvasId, input.createdAt, input.providerId, input.model);
      const session = existing ? rowToSession(existing) : this.getSession(input.id)!;
      this.db.prepare('INSERT INTO agent_canvas_sessions(owner_id,canvas_id,session_id) VALUES(?,?,?)')
        .run(input.ownerId, input.canvasId, session.id);
      return session;
    }).immediate();
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToSession(row) : undefined;
  }

  setSessionProvider(id: string, providerId: string, model: string): void {
    this.db.prepare('UPDATE agent_sessions SET provider_id = ?, model = ? WHERE id = ?').run(providerId, model, id);
  }

  listSessions(scope?: { ownerId?: string; canvasId?: string }): Session[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (scope?.ownerId !== undefined) { clauses.push('owner_id = ?'); params.push(scope.ownerId); }
    if (scope?.canvasId !== undefined) { clauses.push('canvas_id = ?'); params.push(scope.canvasId); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM agent_sessions ${where} ORDER BY created_at DESC`).all(...params) as Row[];
    return rows.map(rowToSession);
  }

  createRun(input: CreateRunRecord): Run {
    const insert = this.db.transaction(() => {
      const wait = input.wait ? json(input.wait) : null;
      this.db.prepare(`INSERT INTO agent_runs(id,session_id,turn_id,state,provider_id,model,provider_revision,tool_revision,skill_revision,created_at,updated_at,wait_json,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(input.id, input.sessionId, input.turnId, input.state, input.providerId, input.model, input.providerRevision,
          input.toolRevision, input.skillRevision, input.createdAt, input.updatedAt, wait, input.error ?? null);
      if (input.requestId) this.db.prepare(`INSERT INTO agent_requests(session_id,request_id,run_id,created_at) VALUES(?,?,?,?)`)
        .run(input.sessionId, input.requestId, input.id, input.createdAt);
      this.db.prepare(`INSERT INTO agent_run_inputs(run_id,selection_json,skill_names_json) VALUES(?,?,?)`)
        .run(input.id, input.selection === undefined ? null : json(input.selection), json(input.skillNames ?? []) ?? '[]');
      if (input.snapshot !== undefined) this.db.prepare(`INSERT INTO agent_run_snapshots(run_id,snapshot_json,updated_at) VALUES(?,?,?)`)
        .run(input.id, json(input.snapshot) ?? '{}', Date.now());
    });
    insert();
    return this.getRun(input.id)!;
  }

  /** Associate a client request with an already active run for durable
   * idempotency. INSERT OR IGNORE keeps a concurrent process from rebinding a
   * request key to a different turn. */
  attachRequest(sessionId: string, requestId: string, runId: string, createdAt = Date.now()): Run | undefined {
    this.db.prepare(`INSERT OR IGNORE INTO agent_requests(session_id,request_id,run_id,created_at) VALUES(?,?,?,?)`)
      .run(sessionId, requestId, runId, createdAt);
    return this.findRequest(sessionId, requestId);
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  listRuns(sessionId: string, limit = 100): Run[] {
    const rows = this.db.prepare(`SELECT * FROM agent_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`).all(sessionId, limit) as Row[];
    return rows.map(rowToRun);
  }

  getActiveRun(sessionId: string): Run | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE session_id = ? AND state IN ('queued','running','waiting_user','waiting_jobs','compacting') ORDER BY created_at DESC LIMIT 1`).get(sessionId) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  updateRun(id: string, patch: Partial<Pick<Run, 'state' | 'wait' | 'error'>> & { wait?: WaitRequest | null; error?: string | null; stopRequested?: boolean }): Run {
    const current = this.getRun(id);
    if (!current) throw new Error(`run not found: ${id}`);
    const nextState = patch.state ?? current.state;
    // An omitted field preserves the durable value; an explicitly supplied
    // undefined/null clears it. Runtime transitions always include these
    // fields so a replied/stopped/completed run cannot retain stale input.
    const hasWait = Object.prototype.hasOwnProperty.call(patch, 'wait');
    const hasError = Object.prototype.hasOwnProperty.call(patch, 'error');
    const nextWait = hasWait ? (patch.wait ?? undefined) : current.wait;
    const nextError = hasError ? (patch.error ?? undefined) : current.error;
    this.db.prepare(`UPDATE agent_runs SET state=?,updated_at=?,wait_json=?,error=?,stop_requested=COALESCE(?,stop_requested) WHERE id=?`)
      .run(nextState, Date.now(), nextWait ? json(nextWait) : null, nextError ?? null,
        patch.stopRequested === undefined ? null : (patch.stopRequested ? 1 : 0), id);
    return this.getRun(id)!;
  }

  isStopRequested(id: string): boolean {
    const row = this.db.prepare(`SELECT stop_requested FROM agent_runs WHERE id = ?`).get(id) as Row | undefined;
    return Boolean(row?.stop_requested);
  }

  getRunInput(id: string): { selection?: Selection; skillNames: string[] } {
    const row = this.db.prepare(`SELECT selection_json,skill_names_json FROM agent_run_inputs WHERE run_id=?`).get(id) as Row | undefined;
    if (!row) return { skillNames: [] };
    const selection = parse<Selection | undefined>(row.selection_json, undefined);
    const skillNames = parse<string[]>(row.skill_names_json, []);
    return selection ? { selection, skillNames } : { skillNames };
  }

  getRunSnapshot<T = unknown>(runId: string): T | undefined {
    const row = this.db.prepare(`SELECT snapshot_json FROM agent_run_snapshots WHERE run_id=?`).get(runId) as Row | undefined;
    return row ? parse<T | undefined>(row.snapshot_json, undefined) : undefined;
  }

  saveRunSnapshot(runId: string, snapshot: unknown, updatedAt = Date.now()): void {
    this.db.prepare(`INSERT INTO agent_run_snapshots(run_id,snapshot_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at`)
      .run(runId, json(snapshot) ?? '{}', updatedAt);
  }

  replacePendingCalls(input: { runId: string; sessionId: string; calls: Array<{ call: import('../contracts/index.js').ToolCall; selection?: Selection }>; createdAt?: number }): void {
    const createdAt = input.createdAt ?? Date.now();
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM agent_pending_calls WHERE run_id=?`).run(input.runId);
      const insert = this.db.prepare(`INSERT INTO agent_pending_calls(run_id,session_id,position,call_json,selection_json,created_at) VALUES(?,?,?,?,?,?)`);
      input.calls.forEach((pending, position) => insert.run(input.runId, input.sessionId, position, json(pending.call) ?? '{}', pending.selection === undefined ? null : json(pending.selection), createdAt));
    })();
  }

  listPendingCalls(runId: string): StoredPendingCall[] {
    const rows = this.db.prepare(`SELECT * FROM agent_pending_calls WHERE run_id=? ORDER BY position`).all(runId) as Row[];
    return rows.map((row) => {
      const pending: StoredPendingCall = {
        runId: String(row.run_id), sessionId: String(row.session_id), position: Number(row.position),
        call: parse<import('../contracts/index.js').ToolCall>(row.call_json, { id: '', name: '', arguments: undefined }),
        createdAt: Number(row.created_at),
      };
      const selection = parse<Selection | undefined>(row.selection_json, undefined);
      if (selection) pending.selection = selection;
      return pending;
    });
  }

  clearPendingCalls(runId: string): void {
    this.db.prepare(`DELETE FROM agent_pending_calls WHERE run_id=?`).run(runId);
  }

  savePendingWait(runId: string, sessionId: string, wait: WaitRequest, createdAt = Date.now()): void {
    this.db.prepare(`INSERT INTO agent_pending_waits(run_id,session_id,wait_json,created_at) VALUES(?,?,?,?)
      ON CONFLICT(run_id) DO UPDATE SET wait_json=excluded.wait_json,created_at=excluded.created_at`)
      .run(runId, sessionId, json(wait) ?? '{}', createdAt);
  }

  /** Atomically park a tool wait together with every call after the barrier.
   * The runtime may be stopped immediately after this transaction commits;
   * recovery can then reconstruct the waiting run without guessing whether
   * the suffix was already submitted. */
  persistPendingWait(input: {
    runId: string;
    sessionId: string;
    wait: WaitRequest;
    calls: Array<{ call: import('../contracts/index.js').ToolCall; selection?: Selection }>;
    createdAt?: number;
  }): void {
    const createdAt = input.createdAt ?? Date.now();
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO agent_pending_waits(run_id,session_id,wait_json,created_at) VALUES(?,?,?,?)
        ON CONFLICT(run_id) DO UPDATE SET session_id=excluded.session_id,wait_json=excluded.wait_json,created_at=excluded.created_at`)
        .run(input.runId, input.sessionId, json(input.wait) ?? '{}', createdAt);
      this.db.prepare(`DELETE FROM agent_pending_calls WHERE run_id=?`).run(input.runId);
      const insert = this.db.prepare(`INSERT INTO agent_pending_calls(run_id,session_id,position,call_json,selection_json,created_at) VALUES(?,?,?,?,?,?)`);
      input.calls.forEach((pending, position) => insert.run(
        input.runId,
        input.sessionId,
        position,
        json(pending.call) ?? '{}',
        pending.selection === undefined ? null : json(pending.selection),
        createdAt,
      ));
    })();
  }

  getPendingWait(runId: string): WaitRequest | undefined {
    const row = this.db.prepare(`SELECT wait_json FROM agent_pending_waits WHERE run_id=?`).get(runId) as Row | undefined;
    return row ? parse<WaitRequest | undefined>(row.wait_json, undefined) : undefined;
  }

  clearPendingWait(runId: string): void {
    this.db.prepare(`DELETE FROM agent_pending_waits WHERE run_id=?`).run(runId);
  }

  findRequest(sessionId: string, requestId: string): Run | undefined {
    const row = this.db.prepare(`SELECT r.* FROM agent_requests q JOIN agent_runs r ON r.id=q.run_id WHERE q.session_id=? AND q.request_id=?`).get(sessionId, requestId) as Row | undefined;
    return row ? rowToRun(row) : undefined;
  }

  appendMessage(input: {
    id: string;
    sessionId: string;
    runId?: string;
    role: Message['role'];
    content: Message['content'];
    toolCalls?: Message['toolCalls'];
    callId?: string;
    createdAt?: number;
  }): Message {
    const createdAt = input.createdAt ?? Date.now();
    const insert = this.db.transaction(() => {
      const row = this.db.prepare(`SELECT COALESCE(MAX(ordinal),0)+1 AS next FROM agent_messages WHERE session_id=?`).get(input.sessionId) as Row;
      this.db.prepare(`INSERT INTO agent_messages(id,session_id,run_id,ordinal,role,content_json,tool_calls_json,call_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(input.id, input.sessionId, input.runId ?? null, Number(row.next), input.role, json(input.content) ?? '[]',
          input.toolCalls ? json(input.toolCalls) : null, input.callId ?? null, createdAt);
    });
    insert();
    return this.getMessage(input.id)!;
  }

  getMessage(id: string): Message | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_messages WHERE id=?`).get(id) as Row | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  findToolMessage(sessionId: string, runId: string, callId: string): Message | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_messages WHERE session_id=? AND run_id=? AND role='tool' AND call_id=? ORDER BY ordinal LIMIT 1`).get(sessionId, runId, callId) as Row | undefined;
    return row ? rowToMessage(row) : undefined;
  }

  hasUserMessageAfterTool(sessionId: string, runId: string, callId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM agent_messages AS tool
      WHERE tool.session_id=? AND tool.run_id=? AND tool.role='tool' AND tool.call_id=?
      AND EXISTS (SELECT 1 FROM agent_messages AS user_message
        WHERE user_message.session_id=tool.session_id AND user_message.run_id=tool.run_id
          AND user_message.role='user' AND user_message.ordinal>tool.ordinal)
      LIMIT 1`).get(sessionId, runId, callId) as Row | undefined;
    return Boolean(row);
  }

  /** Return calls after a durable assistant tool call. This closes the small
   * crash window between an operation result containing a wait and the
   * scheduler's pending-call transaction. */
  listToolCallSuffix(runId: string, callId: string): import('../contracts/index.js').ToolCall[] {
    const rows = this.db.prepare(`SELECT tool_calls_json FROM agent_messages WHERE run_id=? AND role='assistant' AND tool_calls_json IS NOT NULL ORDER BY ordinal`).all(runId) as Row[];
    for (const row of rows) {
      const calls = parse<import('../contracts/index.js').ToolCall[]>(row.tool_calls_json, []);
      const index = calls.findIndex((call) => call.id === callId);
      if (index >= 0) return calls.slice(index + 1);
    }
    return [];
  }

  updateMessageContent(id: string, content: Message['content']): Message | undefined {
    this.db.prepare(`UPDATE agent_messages SET content_json=? WHERE id=?`).run(json(content) ?? '[]', id);
    return this.getMessage(id);
  }

  listMessages(sessionId: string, options: { after?: number; before?: number; limit?: number } = {}): Message[] {
    const after = options.after ?? 0;
    const limit = Math.max(1, Math.min(10_000, options.limit ?? 10_000));
    const where = options.before === undefined ? 'session_id=? AND ordinal>?' : 'session_id=? AND ordinal>? AND ordinal<=?';
    const params = options.before === undefined ? [sessionId, after, limit] : [sessionId, after, options.before, limit];
    const rows = this.db.prepare(`SELECT * FROM agent_messages WHERE ${where} ORDER BY ordinal LIMIT ?`).all(...params) as Row[];
    return rows.map(rowToMessage);
  }

  lastMessageOrdinal(sessionId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(ordinal),0) AS value FROM agent_messages WHERE session_id=?`).get(sessionId) as Row;
    return Number(row.value);
  }

  appendEvent(input: AppendEventInput): AgentEvent {
    const createdAt = input.createdAt ?? Date.now();
    const event = this.db.transaction(() => {
      const sequence = input.sequence ?? Number((this.db.prepare(`SELECT COALESCE(MAX(sequence),0)+1 AS next FROM agent_events WHERE session_id=?`).get(input.sessionId) as Row).next);
      this.db.prepare(`INSERT INTO agent_events(session_id,sequence,run_id,turn_id,type,data_json,created_at) VALUES(?,?,?,?,?,?,?)`)
        .run(input.sessionId, sequence, input.runId ?? null, input.turnId ?? null, input.type, json(input.data) ?? '{}', createdAt);
      return { sessionId: input.sessionId, runId: input.runId, turnId: input.turnId, sequence, type: input.type, data: input.data, createdAt } as AgentEvent;
    });
    return event();
  }

  listEvents(sessionId: string, after = 0, limit = 1_000): AgentEvent[] {
    const rows = this.db.prepare(`SELECT * FROM agent_events WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(sessionId, after, Math.max(1, Math.min(50_000, limit))) as Row[];
    return rows.map((row) => ({
      sessionId: String(row.session_id),
      sequence: Number(row.sequence),
      runId: optionalString(row.run_id),
      turnId: optionalString(row.turn_id),
      type: String(row.type),
      data: parse<Record<string, unknown>>(row.data_json, {}),
      createdAt: Number(row.created_at),
    }));
  }

  latestEventSequence(sessionId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(sequence),0) AS value FROM agent_events WHERE session_id=?`).get(sessionId) as Row;
    return Number(row.value);
  }

  saveOperation(input: SaveOperationInput): StoredOperation {
    const createdAt = input.createdAt ?? Date.now();
    const updatedAt = input.updatedAt ?? createdAt;
    this.db.prepare(`INSERT INTO agent_operations(operation_id,session_id,run_id,call_id,tool_name,effect,fingerprint,state,arguments_json,result_json,error_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,result_json=excluded.result_json,error_json=excluded.error_json,updated_at=excluded.updated_at`)
      .run(input.operationId, input.sessionId, input.runId ?? null, input.callId ?? null, input.toolName, input.effect,
        input.fingerprint, input.state, json(input.arguments) ?? 'null', input.result ? json(input.result) : null,
        input.error ? json(input.error) : null, createdAt, updatedAt);
    return this.getOperation(input.operationId)!;
  }

  getOperation(operationId: string): StoredOperation | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_operations WHERE operation_id=?`).get(operationId) as Row | undefined;
    if (!row) return undefined;
    const operation: StoredOperation = {
      operationId: String(row.operation_id), sessionId: String(row.session_id), toolName: String(row.tool_name),
      effect: String(row.effect) as StoredOperation['effect'], fingerprint: String(row.fingerprint),
      state: String(row.state) as StoredOperation['state'], arguments: parse(row.arguments_json, undefined),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
    const runId = optionalString(row.run_id); if (runId) operation.runId = runId;
    const callId = optionalString(row.call_id); if (callId) operation.callId = callId;
    const result = parse<ToolResult | undefined>(row.result_json, undefined); if (result) operation.result = result;
    const error = parse<StoredOperation['error'] | undefined>(row.error_json, undefined); if (error) operation.error = error;
    return operation;
  }

  listOperations(options: { sessionId?: string; runId?: string; states?: string[] } = {}): StoredOperation[] {
    const clauses: string[] = []; const params: unknown[] = [];
    if (options.sessionId) { clauses.push('session_id=?'); params.push(options.sessionId); }
    if (options.runId) { clauses.push('run_id=?'); params.push(options.runId); }
    if (options.states?.length) { clauses.push(`state IN (${options.states.map(() => '?').join(',')})`); params.push(...options.states); }
    const rows = this.db.prepare(`SELECT * FROM agent_operations ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY created_at`).all(...params) as Row[];
    return rows.map((row) => this.getOperation(String(row.operation_id))!).filter(Boolean);
  }

  saveJob(input: SaveJobInput): StoredJob {
    const updatedAt = input.updatedAt ?? Date.now();
    this.db.prepare(`INSERT INTO agent_jobs(id,operation_id,session_id,run_id,node_id,state,remote_id,results_json,storage_state,apply_state,error,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state,remote_id=excluded.remote_id,results_json=excluded.results_json,
      storage_state=excluded.storage_state,apply_state=excluded.apply_state,error=excluded.error,updated_at=excluded.updated_at`)
      .run(input.id, input.operationId, input.sessionId, input.runId ?? null, input.nodeId, input.state, input.remoteId ?? null,
        json(input.results) ?? '[]', input.storageState, input.applyState, input.error ?? null, updatedAt);
    return this.getJob(input.id)!;
  }

  getJob(id: string): StoredJob | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_jobs WHERE id=?`).get(id) as Row | undefined;
    if (!row) return undefined;
    const job: StoredJob = {
      id: String(row.id), operationId: String(row.operation_id), sessionId: String(row.session_id), nodeId: String(row.node_id),
      state: String(row.state) as StoredJob['state'], results: parse<StoredJob['results']>(row.results_json, []),
      storageState: String(row.storage_state) as StoredJob['storageState'], applyState: String(row.apply_state) as StoredJob['applyState'],
      updatedAt: Number(row.updated_at),
    };
    const runId = optionalString(row.run_id); if (runId) job.runId = runId;
    const remoteId = optionalString(row.remote_id); if (remoteId) job.remoteId = remoteId;
    const error = optionalString(row.error); if (error) job.error = error;
    return job;
  }

  listJobs(options: { sessionId?: string; runId?: string; activeOnly?: boolean } = {}): StoredJob[] {
    const clauses: string[] = []; const params: unknown[] = [];
    if (options.sessionId) { clauses.push('session_id=?'); params.push(options.sessionId); }
    if (options.runId) { clauses.push('run_id=?'); params.push(options.runId); }
    if (options.activeOnly) clauses.push(`state IN ('created','submitting','submitted','running','submission_unknown')`);
    const rows = this.db.prepare(`SELECT id FROM agent_jobs ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY updated_at`).all(...params) as Row[];
    return rows.map((row) => this.getJob(String(row.id))!).filter(Boolean);
  }

  saveCheckpoint(input: Checkpoint): Checkpoint {
    const checkpoint = { ...input, lastMessageOrdinal: input.lastMessageOrdinal ?? this.lastMessageOrdinal(input.sessionId) };
    this.db.prepare(`INSERT INTO agent_checkpoints(id,session_id,run_id,state_json,summary_version,created_at,last_message_ordinal) VALUES(?,?,?,?,?,?,?)`)
      .run(checkpoint.id, checkpoint.sessionId, checkpoint.runId ?? null, json(checkpoint.state) ?? '{}', checkpoint.summaryVersion, checkpoint.createdAt, checkpoint.lastMessageOrdinal);
    return checkpoint;
  }

  getLatestCheckpoint(sessionId: string): Checkpoint | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_checkpoints WHERE session_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(sessionId) as Row | undefined;
    if (!row) return undefined;
    return { id: String(row.id), sessionId: String(row.session_id), runId: optionalString(row.run_id), state: parse(row.state_json, { messages: [], summaryVersion: 0, pinned: {}, viewedAssets: [] }), summaryVersion: Number(row.summary_version), createdAt: Number(row.created_at), lastMessageOrdinal: Number(row.last_message_ordinal ?? 0) };
  }

  saveResult(ref: string, sessionId: string, value: unknown, operationId?: string, expiresAt?: number): ResultPage {
    const page: ResultPage = { ref, sessionId, value, createdAt: Date.now() };
    this.db.prepare(`INSERT INTO agent_results(ref,session_id,operation_id,value_json,created_at,expires_at) VALUES(?,?,?,?,?,?)`)
      .run(ref, sessionId, operationId ?? null, json(value) ?? 'null', page.createdAt, expiresAt ?? null);
    return page;
  }

  readResult(ref: string, sessionId: string, cursor = 0, limit = 100): { value: unknown; nextCursor?: number; createdAt: number } | undefined {
    const row = this.db.prepare(`SELECT * FROM agent_results WHERE ref=? AND session_id=? AND (expires_at IS NULL OR expires_at>?)`).get(ref, sessionId, Date.now()) as Row | undefined;
    if (!row) return undefined;
    const value = parse<unknown>(row.value_json, null);
    const start = Math.max(0, cursor);
    const size = Math.max(1, Math.min(10_000, limit));
    if (Array.isArray(value)) {
      const slice = value.slice(start, start + size);
      return { value: slice, nextCursor: start + size < value.length ? start + size : undefined, createdAt: Number(row.created_at) };
    }
    if (typeof value === 'string') {
      const slice = value.slice(start, start + size);
      return { value: slice, nextCursor: start + size < value.length ? start + size : undefined, createdAt: Number(row.created_at) };
    }
    return { value, createdAt: Number(row.created_at) };
  }

  purgeExpiredResults(at = Date.now()): number {
    return Number(this.db.prepare(`DELETE FROM agent_results WHERE expires_at IS NOT NULL AND expires_at<=?`).run(at).changes);
  }

  /** Operations that were interrupted while a process was alive. */
  listUnfinishedOperations(): StoredOperation[] {
    return this.listOperations({ states: ['pending', 'running', 'submission_unknown'] });
  }
}

export { rowToMessage, rowToRun, rowToSession };
