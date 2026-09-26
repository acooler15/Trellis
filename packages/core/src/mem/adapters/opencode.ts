/**
 * OpenCode 1.2+ persisted-session reader.
 *
 * OpenCode stores sessions in a WAL-mode SQLite database under its XDG data
 * dir (see `internal/paths.ts:opencodeDbPath`). Two storage generations exist
 * in the same file and both are read:
 *
 * 1.x (confirmed against a live 1.18 store):
 *
 *   - `session`  — id / parent_id (sub-agent chain) / title / directory
 *                  (workspace cwd) / time_created / time_updated
 *   - `message`  — id / session_id / time_created / data (JSON: {role, ...})
 *   - `part`     — message_id / session_id / time_created /
 *                  data (JSON: {type: "text"|"tool"|"reasoning"|..., ...})
 *
 * 2.x (confirmed against sst/opencode v2.0.12 and a live store):
 *
 *   - `session_v2`      — same session columns plus fork/suspend bookkeeping;
 *                         written by 2.x only, and holds every session the
 *                         2.x first-run migration copied from `session`
 *                         (whose `version` column is copied verbatim, so
 *                         migrated rows still say "1.18.x")
 *   - `session_message` — id / session_id / type / seq / data, where type is
 *                         "user" / "assistant" / "compaction" / "idle" / … and
 *                         the text lives inline in data (data.text, resp.
 *                         data.content[]); no `part` rows are written
 *
 * A store upgraded from 1.x keeps both generations: migrated sessions exist in
 * both session tables, their dialogue was copied into `session_message` while
 * the legacy `message` / `part` rows were left in place, and sessions a 1.18.x
 * binary writes after the migration are legacy-only. Which generation owns a
 * session is therefore decided structurally (membership in `session_v2`),
 * never by the version string.
 *
 * SQLite access is via the zero-dependency parser in
 * `internal/sqlite-readonly.ts`. A `better-sqlite3`-backed reader shipped in
 * 0.6.0-beta.3 and was reverted one release later because its prebuild
 * download + node-gyp fallback broke `npm install` on Windows and restricted
 * networks; no native module, WASM blob, system `sqlite3`, or install-time
 * build step may come back with this adapter.
 *
 * Everything here is read-only: the database is snapshotted and parsed, never
 * opened for write, locked, checkpointed, or copied over.
 */

import * as fs from "node:fs";

import {
  compactionBoundaryTurn,
  stripInjectionTags,
  isBootstrapTurn,
} from "../dialogue.js";
import { inRangeOverlap, sameProject } from "../filter.js";
import { opencodeDbPath } from "../internal/paths.js";
import {
  createSqlitePreparedStore,
  declaresColumn,
  findTable,
  requireColumns,
  requireOneOfColumns,
  requireRowColumns,
  SqliteSchemaError,
  withSqliteDb,
  type SqliteWarningCopy,
} from "../internal/sqlite-adapter.js";
import { type SqliteRow, type SqliteTableInfo } from "../internal/sqlite-readonly.js";
import { searchInDialogue } from "../search.js";
import type {
  DialogueRole,
  DialogueTurn,
  MemFilter,
  MemSessionInfo,
  MemWarning,
  SearchHit,
} from "../types.js";

// ---------- loose external shapes ----------

interface OpencodeMessageData {
  role?: string;
}

interface OpencodePartData {
  type?: string;
  text?: string;
  summaryMessageId?: unknown;
  tail_start_id?: unknown;
  compactBoundary?: unknown;
  replace?: unknown;
}

function parseDialogueRole(v: unknown): DialogueRole | undefined {
  return v === "user" || v === "assistant" ? v : undefined;
}

/** Safely parse the JSON stored in a `data` column. Returns null on failure —
 * a row carrying hostile or truncated JSON is dropped, never thrown on. */
function parseDataJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ---------- schema contract ----------

const SESSION_TABLE = "session";
const MESSAGE_TABLE = "message";
const PART_TABLE = "part";
const SESSION_V2_TABLE = "session_v2";
const SESSION_MESSAGE_TABLE = "session_message";

/** Accepted spellings for the session's workspace directory, in preference
 * order. Current OpenCode uses `directory`; `cwd` is accepted so an older or
 * renamed store still lists rather than failing closed. */
const SESSION_CWD_COLUMNS = ["directory", "cwd"] as const;

const SQLITE_WARNINGS: SqliteWarningCopy = {
  unreadableCode: "opencode-db-unreadable",
  snapshotUnstableCode: "opencode-db-snapshot-unstable",
  schemaUnsupportedCode: "opencode-db-schema-unsupported",
  writingMessage: (dbPath) =>
    `OpenCode is writing to its session database; retry in a moment (${dbPath})`,
  unreadableMessage: (dbPath, error) =>
    `cannot read OpenCode session database (${dbPath}): ${error.message}`,
  unsupportedMessage: (dbPath, error) =>
    `unsupported OpenCode session schema (${dbPath}): ${error.message}`,
};

type ReadOnlyDb = Parameters<
  typeof findTable
>[0];

/** `findTable` without the throw. A missing table means that storage
 * generation never wrote here (a 1.x-only store has no `session_v2`; a pure
 * 2.x store may not have the legacy tables) — that is absence, not a broken
 * store, and callers treat it as an empty contribution. */
function findOptionalTable(
  db: ReadOnlyDb,
  name: string,
): SqliteTableInfo | undefined {
  return db.listTables().find((item) => item.name === name);
}

// ---------- message / part store ----------

interface OpencodeMessageRow {
  id: string;
  time_created: number;
  /** Scan position, used to break ties so equal timestamps still order
   * deterministically instead of depending on sort stability. */
  seq: number;
  role: DialogueRole;
}

interface OpencodePartRow {
  time_created: number;
  seq: number;
  data: Record<string, unknown>;
}

/** OpenCode 2.x `session_message` row. The `type` column replaces 1.x's
 * `data.role`; `seq` is the per-session monotonic order. */
interface OpencodeV2MessageRow {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  data: Record<string, unknown>;
}

/**
 * Messages + parts grouped by session. Only the search path builds this for a
 * whole database; extract / context populate it with one session's rows.
 */
interface OpencodeSessionStore {
  messagesBySession: Map<string, OpencodeMessageRow[]>;
  partsByMsg: Map<string, OpencodePartRow[]>;
  /** OpenCode 2.x `session_message` rows grouped by session. Empty unless the
   * store carries the `session_v2` generation. */
  v2BySession: Map<string, OpencodeV2MessageRow[]>;
  /** Sessions that exist in `session_v2`, i.e. belong to the 2.x generation
   * (native 2.x sessions plus every session the 2.x migration copied). */
  v2SessionIds: Set<string>;
}

function emptySessionStore(): OpencodeSessionStore {
  return {
    messagesBySession: new Map(),
    partsByMsg: new Map(),
    v2BySession: new Map(),
    v2SessionIds: new Set(),
  };
}

/** Scan position breaks ties so rows written in the same millisecond still
 * order the same way on every run. */
function byTimeThenScan(
  a: { time_created: number; seq: number },
  b: { time_created: number; seq: number },
): number {
  return a.time_created !== b.time_created
    ? a.time_created - b.time_created
    : a.seq - b.seq;
}

function buildSessionStore(
  allMessages: readonly SqliteRow[],
  allParts: readonly SqliteRow[],
): Pick<OpencodeSessionStore, "messagesBySession" | "partsByMsg"> {
  const messagesBySession = new Map<string, OpencodeMessageRow[]>();
  for (let i = 0; i < allMessages.length; i++) {
    const row = allMessages[i];
    if (!row) continue;
    const sessionId = typeof row.session_id === "string" ? row.session_id : "";
    const id = typeof row.id === "string" ? row.id : "";
    if (!sessionId || !id) continue;
    const data = parseDataJson(row.data) as OpencodeMessageData | null;
    const role = parseDialogueRole(data?.role);
    if (!role) continue;
    const list = messagesBySession.get(sessionId) ?? [];
    list.push({
      id,
      time_created: typeof row.time_created === "number" ? row.time_created : 0,
      seq: i,
      role,
    });
    messagesBySession.set(sessionId, list);
  }

  const partsByMsg = new Map<string, OpencodePartRow[]>();
  for (let i = 0; i < allParts.length; i++) {
    const row = allParts[i];
    if (!row) continue;
    const msgId = typeof row.message_id === "string" ? row.message_id : "";
    if (!msgId) continue;
    const data = parseDataJson(row.data);
    if (!data) continue;
    const list = partsByMsg.get(msgId) ?? [];
    list.push({
      time_created: typeof row.time_created === "number" ? row.time_created : 0,
      seq: i,
      data,
    });
    partsByMsg.set(msgId, list);
  }

  for (const list of messagesBySession.values()) list.sort(byTimeThenScan);
  for (const list of partsByMsg.values()) list.sort(byTimeThenScan);

  return { messagesBySession, partsByMsg };
}

/** Read `session_message` (OpenCode 2.x dialogue rows). Only called when the
 * `session_v2` generation is present, in which case the table is part of the
 * contract and its absence is a schema failure. */
function scanV2Messages(
  db: ReadOnlyDb,
  sessionId: string | undefined,
): OpencodeV2MessageRow[] {
  const table = findTable(db, SESSION_MESSAGE_TABLE);
  requireColumns(table, ["id", "session_id", "type", "seq", "data"]);
  const rows =
    sessionId === undefined
      ? db.scanTable(SESSION_MESSAGE_TABLE)
      : db.scanTable(
          SESSION_MESSAGE_TABLE,
          (row) => row.session_id === sessionId,
        );
  requireRowColumns(rows, SESSION_MESSAGE_TABLE, [
    "id",
    "session_id",
    "type",
    "seq",
    "data",
  ]);
  const out: OpencodeV2MessageRow[] = [];
  for (const row of rows) {
    if (!row) continue;
    const id = typeof row.id === "string" ? row.id : "";
    const type = typeof row.type === "string" ? row.type : "";
    const session_id =
      typeof row.session_id === "string" ? row.session_id : "";
    if (!id || !type || !session_id) continue;
    const data = parseDataJson(row.data);
    if (!data) continue;
    out.push({
      id,
      session_id,
      type,
      seq: typeof row.seq === "number" ? row.seq : 0,
      time_created:
        typeof row.time_created === "number" ? row.time_created : 0,
      data,
    });
  }
  // `seq` is the monotonic per-session order OpenCode 2.x writes; timestamps
  // only break ties between rows sharing a step.
  out.sort((a, b) => a.seq - b.seq || a.time_created - b.time_created);
  return out;
}

/**
 * Validate both generations and return the rows selected by `sessionId`, or
 * every row when `sessionId` is undefined (the search store).
 *
 * A generation participates only when its session table exists; the message
 * tables of a present generation are contract-checked as before. 1.x's own
 * `session_message` (input subsystem) is select-only, so scanning it here is
 * gated on `session_v2` and never sees 1.x rows.
 */
function scanMessagesAndParts(
  db: ReadOnlyDb,
  sessionId: string | undefined,
): OpencodeSessionStore {
  const store = emptySessionStore();

  const hasLegacy = findOptionalTable(db, SESSION_TABLE) !== undefined;
  const hasV2 = findOptionalTable(db, SESSION_V2_TABLE) !== undefined;
  if (!hasLegacy && !hasV2) {
    throw new SqliteSchemaError(
      `missing table: ${SESSION_TABLE} / ${SESSION_V2_TABLE}`,
    );
  }

  if (hasLegacy) {
    const messageTable = findTable(db, MESSAGE_TABLE);
    requireColumns(messageTable, ["id", "session_id", "data"]);
    const partTable = findTable(db, PART_TABLE);
    requireColumns(partTable, ["message_id", "data"]);

    const messages =
      sessionId === undefined
        ? db.scanTable(MESSAGE_TABLE)
        : db.scanTable(MESSAGE_TABLE, (row) => row.session_id === sessionId);
    requireRowColumns(messages, MESSAGE_TABLE, ["id", "session_id", "data"]);

    let parts: SqliteRow[];
    if (sessionId === undefined) {
      parts = db.scanTable(PART_TABLE);
    } else if (declaresColumn(partTable, "session_id")) {
      // Current OpenCode denormalizes `session_id` onto `part`, so one session's
      // parts can be selected without first materializing its message ids.
      parts = db.scanTable(PART_TABLE, (row) => row.session_id === sessionId);
    } else {
      const messageIds = new Set(
        messages
          .map((row) => row.id)
          .filter((id): id is string => typeof id === "string"),
      );
      parts = db.scanTable(
        PART_TABLE,
        (row) =>
          typeof row.message_id === "string" && messageIds.has(row.message_id),
      );
    }
    requireRowColumns(parts, PART_TABLE, ["message_id", "data"]);

    const legacy = buildSessionStore(messages, parts);
    store.messagesBySession = legacy.messagesBySession;
    store.partsByMsg = legacy.partsByMsg;
  }

  if (hasV2) {
    // Session ids decide the generation a session's dialogue is read from —
    // structural routing, never the (copied) `version` column.
    const v2SessionTable = findTable(db, SESSION_V2_TABLE);
    requireColumns(v2SessionTable, ["id"]);
    const v2IdRows =
      sessionId === undefined
        ? db.scanTable(SESSION_V2_TABLE)
        : db.scanTable(SESSION_V2_TABLE, (row) => row.id === sessionId);
    for (const row of v2IdRows) {
      if (typeof row.id === "string" && row.id) store.v2SessionIds.add(row.id);
    }
    for (const row of scanV2Messages(db, sessionId)) {
      const list = store.v2BySession.get(row.session_id) ?? [];
      list.push(row);
      store.v2BySession.set(row.session_id, list);
    }
  }

  return store;
}

/** Search-scoped whole-db store, prepared and released by the orchestrator.
 * One-session extract / context calls never populate it. */
const preparedStore = createSqlitePreparedStore<OpencodeSessionStore>();

function loadSessionStore(
  dbPath: string,
  warnings: MemWarning[],
  sessionId?: string,
): OpencodeSessionStore {
  return withSqliteDb(
    dbPath,
    warnings,
    SQLITE_WARNINGS,
    emptySessionStore(),
    (db) => scanMessagesAndParts(db, sessionId),
  );
}

export function prepareOpencodeSessionStore(
  dbPath: string,
  warnings: MemWarning[] = [],
): void {
  preparedStore.prepare(dbPath, () => loadSessionStore(dbPath, warnings));
}

export function releaseOpencodeSessionStore(): void {
  preparedStore.release();
}

// ---------- compaction ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCompactionSummaryPart(data: Record<string, unknown>): boolean {
  return (
    data.type === "compaction" &&
    (typeof data.tail_start_id === "string" || isRecord(data.compactBoundary))
  );
}

function compactionMarkerSummaryId(
  data: Record<string, unknown>,
): string | undefined {
  return data.type === "compaction" &&
    data.replace === true &&
    typeof data.summaryMessageId === "string"
    ? data.summaryMessageId
    : undefined;
}

/**
 * Identify the messages that carry a compaction summary. The compacted turns
 * remain as rows in the same database, so they stay in the dialogue and the
 * summary message is rendered as a boundary marker in place.
 *
 * The marker shape (`{type:"compaction", replace, summaryMessageId}` plus a
 * summary part with `tail_start_id` / `compactBoundary`) is the one ZCode
 * inherited from its OpenCode fork. If OpenCode never writes it, no message is
 * classified as a summary and every turn reads as ordinary dialogue.
 */
function compactSummaryMessageIds(
  messages: readonly OpencodeMessageRow[],
  partsByMsg: Map<string, OpencodePartRow[]>,
): Set<string> {
  const summaryIds = new Set<string>();
  const markerSummaryIds = new Set<string>();

  for (const msg of messages) {
    if (markerSummaryIds.has(msg.id)) summaryIds.add(msg.id);
    for (const part of partsByMsg.get(msg.id) ?? []) {
      const markerSummaryId = compactionMarkerSummaryId(part.data);
      if (markerSummaryId) markerSummaryIds.add(markerSummaryId);
      if (isCompactionSummaryPart(part.data)) {
        summaryIds.add(msg.id);
        break;
      }
    }
  }
  return summaryIds;
}

/**
 * One message becomes one turn: its `text` parts concatenated, then cleaned.
 * `reasoning`, `tool`, `step-start` and `step-finish` parts are not dialogue
 * and are skipped. Messages left with no text are dropped.
 */
function buildTextTurn(
  msg: OpencodeMessageRow,
  parts: readonly OpencodePartRow[],
  compactSummaryIds: ReadonlySet<string>,
): DialogueTurn | null {
  const collected: string[] = [];
  let totalRaw = 0;
  for (const part of parts) {
    const pd = part.data as OpencodePartData;
    if (pd.type !== "text") continue;
    const txt = typeof pd.text === "string" ? pd.text : "";
    if (!txt) continue;
    totalRaw += txt.length;
    collected.push(stripInjectionTags(txt));
  }
  if (!collected.length) return null;

  const merged = collected.join("\n\n");
  if (compactSummaryIds.has(msg.id)) {
    return compactionBoundaryTurn(
      "context compacted here; the turns above are still in the OpenCode database",
      merged,
    );
  }
  if (isBootstrapTurn(merged, totalRaw)) return null;
  return merged.trim() ? { role: msg.role, text: merged } : null;
}

/**
 * One OpenCode 2.x `session_message` row becomes one turn. `user` rows carry
 * `data.text`; `assistant` rows carry the reply inline as `data.content`,
 * where only `type:"text"` items are dialogue (`reasoning` / tool items are
 * not); a `compaction` row with `status:"completed"` renders as the boundary
 * marker. Selection / synthetic rows (`idle`, `system`, `skill`, `shell`,
 * agent-model-location selections) are not dialogue and are skipped. Compacted
 * turns remain as rows in the same database — 2.x never prunes them — so the
 * 1.x marker wording holds here too.
 */
function buildV2Turn(row: OpencodeV2MessageRow): DialogueTurn | null {
  if (row.type === "user") {
    const raw = typeof row.data.text === "string" ? row.data.text : "";
    if (!raw) return null;
    const merged = stripInjectionTags(raw);
    if (isBootstrapTurn(merged, raw.length)) return null;
    return merged ? { role: "user", text: merged } : null;
  }
  if (row.type === "assistant") {
    const content = Array.isArray(row.data.content) ? row.data.content : [];
    const collected: string[] = [];
    let totalRaw = 0;
    for (const item of content) {
      if (!isRecord(item) || item.type !== "text") continue;
      const txt = typeof item.text === "string" ? item.text : "";
      if (!txt) continue;
      totalRaw += txt.length;
      collected.push(stripInjectionTags(txt));
    }
    if (!collected.length) return null;
    const merged = collected.join("\n\n");
    if (isBootstrapTurn(merged, totalRaw)) return null;
    return merged.trim() ? { role: "assistant", text: merged } : null;
  }
  if (row.type === "compaction") {
    // `running` / `failed` rows record the attempt, not a summary to show.
    if (row.data.status !== "completed") return null;
    return compactionBoundaryTurn(
      "context compacted here; the turns above are still in the OpenCode database",
      typeof row.data.summary === "string" ? row.data.summary : undefined,
    );
  }
  return null;
}

// ---------- list ----------

/** Largest absolute time value an ECMAScript Date can represent. */
const MAX_TIME_VALUE = 8.64e15;

function toIso(epochMs: unknown): string | undefined {
  // A corrupt or hostile timestamp must degrade to "no timestamp", not throw
  // RangeError out of the row loop and fail the whole command.
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return undefined;
  if (epochMs <= 0 || epochMs > MAX_TIME_VALUE) return undefined;
  return new Date(epochMs).toISOString();
}

/** Scan one session-table generation with the shared column contract. A
 * missing table means that generation never wrote here and contributes
 * nothing; a present one must satisfy the contract or the store fails closed. */
function scanSessionTable(
  db: ReadOnlyDb,
  table: string,
): { rows: SqliteRow[]; cwdColumn: string } | undefined {
  const found = findOptionalTable(db, table);
  if (!found) return undefined;
  requireColumns(found, ["id", "time_created", "time_updated"]);
  const cwdColumn = requireOneOfColumns(found, SESSION_CWD_COLUMNS);
  const rows = db.scanTable(table);
  requireRowColumns(rows, table, [
    "id",
    cwdColumn,
    "time_created",
    "time_updated",
  ]);
  return { rows, cwdColumn };
}

/**
 * List OpenCode sessions from both storage generations — the legacy `session`
 * table (1.x, and 1.18.x builds that run after a 2.x migration) and
 * `session_v2` (2.x, plus every session the 2.x first-run migration copied
 * over; those exist in both tables with their dialogue only in
 * `session_message`). On id collision the `session_v2` row wins because it is
 * the copy 2.x keeps updating. Listing never touches the message tables. A
 * machine with no OpenCode store lists nothing and warns about nothing.
 */
export function opencodeListSessions(
  f: MemFilter,
  warnings: MemWarning[] = [],
): MemSessionInfo[] {
  const dbPath = opencodeDbPath();
  if (dbPath === undefined || !fs.existsSync(dbPath)) return [];

  const listed = withSqliteDb(
    dbPath,
    warnings,
    SQLITE_WARNINGS,
    null as {
      legacy: ReturnType<typeof scanSessionTable>;
      v2: ReturnType<typeof scanSessionTable>;
    } | null,
    (db) => {
      const legacy = scanSessionTable(db, SESSION_TABLE);
      const v2 = scanSessionTable(db, SESSION_V2_TABLE);
      if (!legacy && !v2) {
        throw new SqliteSchemaError(
          `missing table: ${SESSION_TABLE} / ${SESSION_V2_TABLE}`,
        );
      }
      return { legacy, v2 };
    },
  );
  if (!listed) return [];

  const merged = new Map<string, { row: SqliteRow; cwdColumn: string }>();
  for (const generation of [listed.legacy, listed.v2]) {
    if (!generation) continue;
    for (const row of generation.rows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;
      // Later generations overwrite earlier ones: `session_v2` wins.
      merged.set(id, { row, cwdColumn: generation.cwdColumn });
    }
  }

  const out: MemSessionInfo[] = [];
  for (const { row, cwdColumn } of merged.values()) {
    const directory =
      typeof row[cwdColumn] === "string"
        ? (row[cwdColumn] as string)
        : undefined;
    if (f.cwd && !sameProject(directory, f.cwd)) continue;

    const created = toIso(row.time_created);
    const updated = toIso(row.time_updated) ?? created;
    if (!inRangeOverlap(created, updated, f)) continue;

    out.push({
      platform: "opencode",
      id: row.id as string,
      title: typeof row.title === "string" ? row.title : undefined,
      cwd: directory,
      created,
      updated,
      filePath: dbPath,
      // Sub-agent sessions point at their dispatcher; `--include-children`
      // merges them into the parent.
      ...(typeof row.parent_id === "string" && row.parent_id
        ? { parent_id: row.parent_id }
        : {}),
    });
  }
  return out;
}

// ---------- extract / search ----------

/** One extracted turn plus the timestamp that merges the two storage
 * generations deterministically. */
interface DatedTurn {
  time: number;
  turn: DialogueTurn;
}

/**
 * Read one session's dialogue from the generation it belongs to.
 *
 * A session listed in `session_v2` belongs to the 2.x generation: the 2.x
 * first-run migration copied its dialogue into `session_message` but left the
 * legacy `message` / `part` rows in place, so reading both generations would
 * duplicate every turn. Legacy rows are read only for sessions 2.x never
 * adopted (1.x-only stores, and sessions a 1.18.x binary created after the
 * migration). A 1.18.x build resuming a migrated session would append legacy
 * rows the v2 path does not see — an inconsistent state OpenCode itself does
 * not support (its downgrade cannot resume into `session_v2`), so it is not
 * worked around here.
 */
function dialogueFromStore(
  store: OpencodeSessionStore,
  sessionId: string,
): DatedTurn[] {
  const out: DatedTurn[] = [];
  if (store.v2SessionIds.has(sessionId)) {
    for (const row of store.v2BySession.get(sessionId) ?? []) {
      const turn = buildV2Turn(row);
      if (turn) out.push({ time: row.time_created, turn });
    }
    return out;
  }
  const messages = store.messagesBySession.get(sessionId) ?? [];
  const summaryIds = compactSummaryMessageIds(messages, store.partsByMsg);
  for (const msg of messages) {
    const turn = buildTextTurn(
      msg,
      store.partsByMsg.get(msg.id) ?? [],
      summaryIds,
    );
    if (turn) out.push({ time: msg.time_created, turn });
  }
  return out;
}

/** Read one session's dialogue, reusing the search-scoped store when the
 * orchestrator prepared one for this same database. */
function readSessionDialogue(
  dbPath: string,
  sessionId: string,
  warnings: MemWarning[],
): DatedTurn[] {
  const prepared = preparedStore.get(dbPath);
  const store = prepared ?? loadSessionStore(dbPath, warnings, sessionId);
  return dialogueFromStore(store, sessionId);
}

export function opencodeExtractDialogue(
  s: MemSessionInfo,
  warnings: MemWarning[] = [],
): DialogueTurn[] {
  return readSessionDialogue(s.filePath, s.id, warnings).map(
    (item) => item.turn,
  );
}

export function opencodeSearch(
  s: MemSessionInfo,
  kw: string,
  warnings: MemWarning[] = [],
): SearchHit {
  return searchInDialogue(opencodeExtractDialogue(s, warnings), kw);
}
