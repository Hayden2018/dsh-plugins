/**
 * Durable graph storage.
 *
 * The whole graph lives in memory; SQLite is the durable copy and is touched
 * only to hydrate at startup, to commit a write, and to read the changelog.
 * Reads therefore never wait on the database, and a write either commits
 * durably before memory changes or leaves both sides untouched.
 *
 * Three application tables exist: `node`, `edge` (keyed by the triple
 * `(from_id, relation, to_id)`), and the append-only `history` changelog.
 */

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sqlite from 'node:sqlite';
import { DEFAULT_RELATION, GraphError, NODE_TYPES } from './types.js';
import {
  arrayOrEmpty,
  asObject,
  edgeFields,
  expectedRevision,
  nodeFields,
  normalizeText,
  optionalId,
  requiredId,
  validateDescription,
  validateDescriptionStrategy,
  validateName,
  validateRelation,
} from './validate.js';

/** Node 22 exposes `DatabaseSync`; later releases also alias it as `Database`. */
const Database = sqlite.DatabaseSync ?? sqlite.Database;

/** Marks this file as a knowledge-graph database, so an unrelated SQLite file is refused. */
const APPLICATION_ID = 0x4b475250;
/** Schema generation stored in `PRAGMA user_version`. */
export const SCHEMA_VERSION = 2;
/** Rows one changelog read may scan before filtering. */
const HISTORY_SCAN_LIMIT = 5_000;

const TYPE_CHECK = NODE_TYPES.map((type) => `'${type}'`).join(', ');

/** The current `node` table, also used when migrating generation 1. */
function nodeTable(name = 'node') {
  return `
CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN (${TYPE_CHECK})),
  tags TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by_session_id TEXT NOT NULL,
  updated_by_session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;`;
}

/** The current `edge` table: the relation is part of the primary key. */
function edgeTable(name = 'edge', { ifNotExists = true } = {}) {
  return `
CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
  from_id TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  to_id TEXT NOT NULL REFERENCES node(id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by_session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (from_id, relation, to_id)
) STRICT;`;
}

/** The append-only changelog read by `kg_history`. */
const HISTORY_TABLE = `
CREATE TABLE IF NOT EXISTS history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  session_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('node', 'edge')),
  target_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'delete', 'merge')),
  revision INTEGER NOT NULL,
  before_snapshot TEXT,
  after_snapshot TEXT
) STRICT;`;

const SCHEMA = `${nodeTable()}
${edgeTable()}
${HISTORY_TABLE}
CREATE INDEX IF NOT EXISTS edge_in ON edge(to_id, relation, from_id);
CREATE INDEX IF NOT EXISTS edge_relation ON edge(relation);
CREATE INDEX IF NOT EXISTS history_target ON history(target_kind, target_key, seq);
CREATE INDEX IF NOT EXISTS history_time ON history(timestamp);`;

/**
 * Parse one JSON array column.
 * @param text - stored text.
 * @param column - column name used in the diagnostic.
 * @param id - row id used in the diagnostic.
 * @returns the array of strings.
 */
function parseArrayColumn(text, column, id) {
  try {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new TypeError('not an array');
    return value.map((item) => String(item));
  } catch {
    throw new GraphError(
      'corrupt_database',
      `Row ${id} has an unreadable \`${column}\` column. Purge the graph data to recover.`
    );
  }
}

/** Current time as an ISO-8601 UTC string. */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * Add the normalized lookup strings a node uses for search.
 * @param record - node record without cache fields.
 * @returns the indexed record.
 */
function withCache(record) {
  return {
    ...record,
    _name: normalizeText(record.name),
    _tags: record.tags.map(normalizeText),
    _desc: normalizeText(record.description),
  };
}

/** A node row as it appears in a tool result. */
export function publicNode(node) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    tags: [...node.tags],
    description: node.description,
    attachments: [...node.attachments],
    created_at: node.created_at,
    updated_at: node.updated_at,
    created_by_session_id: node.created_by_session_id,
    updated_by_session_id: node.updated_by_session_id,
    revision: node.revision,
  };
}

/** An edge row as it appears in a tool result. */
export function publicEdge(edge) {
  return {
    from_id: edge.from_id,
    relation: edge.relation,
    to_id: edge.to_id,
    description: edge.description,
    created_at: edge.created_at,
    updated_at: edge.updated_at,
    updated_by_session_id: edge.updated_by_session_id,
    revision: edge.revision,
  };
}

/** Stable in-memory key for one directed, labelled relation. */
export function edgeKey(edge) {
  return tupleKey(edge.from_id, edge.relation, edge.to_id);
}

/**
 * Stable key for one `(from, relation, to)` triple.
 * @param fromId - source id.
 * @param relation - relation label.
 * @param toId - target id.
 * @returns the map key.
 */
export function tupleKey(fromId, relation, toId) {
  return `${fromId}\u0000${relation}\u0000${toId}`;
}

/** Serialized form stored in `history.target_key` for an edge. */
export function edgeTargetKey(fromId, relation, toId) {
  return JSON.stringify([fromId, relation, toId]);
}

/**
 * Ordered comparison used wherever a stable presentation is promised.
 * @param left - left edge-like value.
 * @param right - right edge-like value.
 * @returns negative, zero, or positive.
 */
function compareEdges(left, right) {
  if (left.relation !== right.relation) return left.relation < right.relation ? -1 : 1;
  if (left.from_id !== right.from_id) return left.from_id < right.from_id ? -1 : 1;
  if (left.to_id !== right.to_id) return left.to_id < right.to_id ? -1 : 1;
  return 0;
}

/**
 * Empty write plan shared by every mutation.
 * @returns a plan with no operations.
 */
function emptyPlan() {
  return {
    /** @type {object[]} full node records to insert or replace */
    nodeWrites: [],
    /** @type {object[]} existing node records to remove */
    nodeDeletes: [],
    /** @type {object[]} full edge records to insert or replace */
    edgeWrites: [],
    /** @type {object[]} existing edge records to remove */
    edgeDeletes: [],
    /** @type {object[]} changelog rows */
    history: [],
  };
}

/** Whether a plan would change anything. */
function planIsEmpty(plan) {
  return (
    plan.nodeWrites.length === 0 &&
    plan.nodeDeletes.length === 0 &&
    plan.edgeWrites.length === 0 &&
    plan.edgeDeletes.length === 0
  );
}

/**
 * One changelog row.
 * @param timestamp - mutation time.
 * @param sessionId - writing session.
 * @param kind - `node` or `edge`.
 * @param key - node id or serialized edge triple.
 * @param operation - create, update, delete, or merge.
 * @param revision - resulting (or final) revision.
 * @param before - prior record, or null.
 * @param after - new record, or null.
 * @returns the row.
 */
function historyRow(timestamp, sessionId, kind, key, operation, revision, before, after) {
  return {
    timestamp,
    session_id: sessionId,
    target_kind: kind,
    target_key: key,
    operation,
    revision,
    before: before === undefined || before === null ? null : JSON.stringify(before),
    after: after === undefined || after === null ? null : JSON.stringify(after),
  };
}

export class GraphStore {
  /** @type {import('node:sqlite').DatabaseSync | null} */
  #db = null;
  /** @type {Error | null} */
  #fault = null;
  #edgeCount = 0;
  #historyCount = 0;

  /**
   * @param options - storage location and read limits.
   * @param options.dataDir - directory owned by this plugin.
   * @param options.limits - defaults applied to search and traversal.
   */
  constructor({ dataDir, limits }) {
    this.dataDir = dataDir;
    this.dbPath = join(dataDir, 'graph.sqlite');
    this.limits = limits;
    /** @type {Map<string, object>} */
    this.nodes = new Map();
    /** @type {Map<string, Map<string, object>>} */
    this.outEdges = new Map();
    /** @type {Map<string, Map<string, object>>} */
    this.inEdges = new Map();
  }

  /** Why the store is unusable, or null. */
  get fault() {
    return this.#fault;
  }

  /**
   * Hydrate from an existing database. A missing file is a normal empty start;
   * an unreadable one records a fault that only purge clears.
   */
  init() {
    this.#fault = null;
    if (!existsSync(this.dbPath)) return;
    try {
      this.#open();
    } catch (error) {
      const fault =
        error instanceof GraphError
          ? error
          : new GraphError(
              'unavailable',
              `The knowledge-graph database could not be opened: ${error.message}`
            );
      this.#fault = fault;
      throw fault;
    }
  }

  /** Throw the recorded fault, if any. */
  assertReady() {
    if (this.#fault !== null) throw this.#fault;
  }

  /** Open the database, validate its identity, create or migrate the schema. */
  #open() {
    if (this.#db !== null) return this.#db;
    mkdirSync(this.dataDir, { recursive: true });
    const db = new Database(this.dbPath);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec('PRAGMA busy_timeout = 5000');

      const applicationId = readPragma(db, 'application_id');
      if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
        throw new GraphError(
          'invalid_database',
          `${this.dbPath} is not a knowledge-graph database. Choose another data directory or purge it.`
        );
      }
      let version = readPragma(db, 'user_version');
      // A crash between creating generation-1 tables and stamping the version
      // leaves a v1-shaped file behind; treat it as generation 1, not as new.
      if (version === 0 && hasTable(db, 'node')) version = 1;
      if (version > SCHEMA_VERSION) {
        throw new GraphError(
          'unsupported_schema',
          `${this.dbPath} was written by a newer plugin (schema ${version}); upgrade the plugin instead of downgrading.`
        );
      }
      if (version === 0) {
        db.exec(SCHEMA);
        if (applicationId === 0) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      } else if (version < SCHEMA_VERSION) {
        this.#migrate(db, version);
        if (applicationId === 0) db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      } else {
        db.exec(SCHEMA);
      }
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    this.#fault = null;
    try {
      this.#loadAll();
    } catch (error) {
      this.close();
      throw error;
    }
    return db;
  }

  /**
   * Replace the generation-1 schema with the composite-key layout.
   *
   * The rebuild runs in one transaction: on any failure the original file is
   * left exactly as it was, and the store reports a fault instead of guessing.
   * @param db - the open database.
   * @param from - the generation found on disk.
   */
  #migrate(db, from) {
    if (from !== 1) {
      throw new GraphError(
        'unsupported_schema',
        `No upgrade path exists from schema ${from} to ${SCHEMA_VERSION}.`
      );
    }
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.exec('BEGIN IMMEDIATE');
      if (!hasColumn(db, 'node', 'created_by_session_id')) {
        db.exec("ALTER TABLE node ADD COLUMN created_by_session_id TEXT NOT NULL DEFAULT ''");
        db.exec(
          "UPDATE node SET created_by_session_id = updated_by_session_id WHERE created_by_session_id = ''"
        );
      }
      db.exec('DROP TABLE IF EXISTS edge_next');
      db.exec(edgeTable('edge_next', { ifNotExists: false }));
      db.exec(
        'INSERT INTO edge_next (from_id, relation, to_id, description, created_at, updated_at, updated_by_session_id, revision)' +
          ' SELECT from_id, relation, to_id, description, created_at, updated_at, updated_by_session_id, revision FROM edge'
      );
      db.exec('DROP TABLE edge');
      db.exec('ALTER TABLE edge_next RENAME TO edge');
      db.exec('CREATE INDEX IF NOT EXISTS edge_in ON edge(to_id, relation, from_id)');
      db.exec('CREATE INDEX IF NOT EXISTS edge_relation ON edge(relation)');
      db.exec(HISTORY_TABLE);
      db.exec('CREATE INDEX IF NOT EXISTS history_target ON history(target_kind, target_key, seq)');
      db.exec('CREATE INDEX IF NOT EXISTS history_time ON history(timestamp)');
      const violations = db.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        throw new GraphError(
          'migration_failed',
          `${violations.length} relation(s) point at a missing entity.`
        );
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A rollback failure must not mask the original error.
      }
      const message = error instanceof GraphError ? error.message : String(error?.message ?? error);
      throw new GraphError(
        'migration_failed',
        `The graph database could not be upgraded from schema 1 to ${SCHEMA_VERSION} and was left unchanged: ${message} ` +
          'Purge the graph data from the plugin panel, or restore a backup, then retry.'
      );
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /** Open the database if a write needs it. */
  #ensureOpen() {
    return this.#db ?? this.#open();
  }

  /** Read every row into memory. */
  #loadAll() {
    const db = this.#db;
    this.nodes.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.#edgeCount = 0;
    for (const row of db.prepare('SELECT * FROM node ORDER BY id').all()) {
      const record = {
        id: row.id,
        name: row.name,
        type: row.type,
        tags: parseArrayColumn(row.tags, 'tags', row.id),
        description: row.description,
        attachments: parseArrayColumn(row.attachments, 'attachments', row.id),
        created_at: row.created_at,
        updated_at: row.updated_at,
        created_by_session_id: row.created_by_session_id,
        updated_by_session_id: row.updated_by_session_id,
        revision: Number(row.revision),
      };
      this.#indexNode(record);
    }
    for (const row of db.prepare('SELECT * FROM edge ORDER BY from_id, relation, to_id').all()) {
      this.#indexEdge({
        from_id: row.from_id,
        relation: row.relation,
        to_id: row.to_id,
        description: row.description,
        created_at: row.created_at,
        updated_at: row.updated_at,
        updated_by_session_id: row.updated_by_session_id,
        revision: Number(row.revision),
      });
    }
    this.#historyCount = Number(db.prepare('SELECT count(*) AS n FROM history').get().n);
  }

  /** Put one node into the in-memory index. */
  #indexNode(record) {
    const indexed = withCache(record);
    this.nodes.set(indexed.id, indexed);
    if (!this.outEdges.has(indexed.id)) this.outEdges.set(indexed.id, new Map());
    if (!this.inEdges.has(indexed.id)) this.inEdges.set(indexed.id, new Map());
    return indexed;
  }

  /** Put one edge into the adjacency indexes. */
  #indexEdge(record) {
    if (!this.outEdges.has(record.from_id)) this.outEdges.set(record.from_id, new Map());
    if (!this.inEdges.has(record.to_id)) this.inEdges.set(record.to_id, new Map());
    const key = edgeKey(record);
    const outgoing = this.outEdges.get(record.from_id);
    const existed = outgoing.has(key);
    outgoing.set(key, record);
    this.inEdges.get(record.to_id).set(key, record);
    if (!existed) this.#edgeCount += 1;
  }

  /** Remove one edge from the adjacency indexes. */
  #unindexEdge(edge) {
    const key = edgeKey(edge);
    const outgoing = this.outEdges.get(edge.from_id);
    if (outgoing !== undefined && outgoing.delete(key)) this.#edgeCount -= 1;
    this.inEdges.get(edge.to_id)?.delete(key);
  }

  /** Remove one node and its adjacency buckets. */
  #unindexNode(id) {
    this.nodes.delete(id);
    this.outEdges.delete(id);
    this.inEdges.delete(id);
  }

  /** Close the SQLite connection, leaving the file in place. */
  close() {
    if (this.#db === null) return;
    try {
      this.#db.close();
    } finally {
      this.#db = null;
    }
  }

  /**
   * Delete everything this plugin owns: close the connection, remove the
   * database directory, and empty the in-memory graph. The next write recreates
   * the database lazily, so a purge followed by an uninstall leaves no files.
   * @returns the empty status.
   */
  purge() {
    this.close();
    this.nodes.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.#edgeCount = 0;
    this.#historyCount = 0;
    this.#fault = null;
    if (existsSync(this.dataDir)) {
      rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    return this.status();
  }

  /** Storage facts for the maintenance panel. */
  status() {
    let bytes = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      const path = this.dbPath + suffix;
      if (existsSync(path)) {
        try {
          bytes += statSync(path).size;
        } catch {
          // A file that vanished between stat calls contributes nothing.
        }
      }
    }
    return {
      dataDir: this.dataDir,
      dbPath: this.dbPath,
      exists: existsSync(this.dbPath),
      bytes,
      nodes: this.nodes.size,
      edges: this.#edgeCount,
      revisions: this.#historyCount,
      schemaVersion: SCHEMA_VERSION,
      fault: this.#fault === null ? '' : this.#fault.message,
    };
  }

  /** Edge map leaving a node, never undefined. */
  outgoing(id) {
    return this.outEdges.get(id) ?? new Map();
  }

  /** Edge map entering a node, never undefined. */
  incoming(id) {
    return this.inEdges.get(id) ?? new Map();
  }

  /** Every stored edge, in a stable order. */
  allEdges() {
    const list = [];
    for (const bucket of this.outEdges.values()) {
      for (const edge of bucket.values()) list.push(edge);
    }
    return list.sort(compareEdges);
  }

  /**
   * Every stored edge between two entities, whatever its relation.
   * @param fromId - source id.
   * @param toId - target id.
   * @returns the edges in a stable order.
   */
  edgesBetween(fromId, toId) {
    const list = [];
    for (const edge of this.outgoing(fromId).values()) {
      if (edge.to_id === toId) list.push(edge);
    }
    return list.sort(compareEdges);
  }

  /**
   * One edge by its full triple.
   * @param fromId - source id.
   * @param relation - relation label.
   * @param toId - target id.
   * @returns the edge, or undefined.
   */
  edgeOf(fromId, relation, toId) {
    return this.outgoing(fromId).get(tupleKey(fromId, relation, toId));
  }

  /**
   * Stored degree, counting a self-loop once on each side.
   * @param id - node id.
   * @returns the incoming and outgoing counts.
   */
  degreeOf(id) {
    return { in: this.incoming(id).size, out: this.outgoing(id).size };
  }

  /**
   * Read nodes by id with their immediate relations.
   * @param args - validated arguments.
   * @param args.ids - node ids.
   * @param args.includeEdges - whether to attach relations.
   * @param args.direction - which relations to attach.
   * @param args.relations - optional relation allowlist.
   * @param args.edgeLimit - cap per direction.
   * @returns the node views and the ids that do not exist.
   */
  get({ ids, includeEdges, direction, relations, edgeLimit }) {
    this.assertReady();
    const relationSet = relations === undefined ? undefined : new Set(relations);
    const keep = (edge) => relationSet === undefined || relationSet.has(edge.relation);
    const nodes = [];
    const missing = [];
    for (const id of ids) {
      const node = this.nodes.get(id);
      if (node === undefined) {
        missing.push(id);
        continue;
      }
      const view = publicNode(node);
      if (includeEdges) {
        const outgoing =
          direction === 'incoming' ? [] : [...this.outgoing(id).values()].filter(keep).sort(compareEdges);
        const incoming =
          direction === 'outgoing' ? [] : [...this.incoming(id).values()].filter(keep).sort(compareEdges);
        view.edges = {
          outgoing: outgoing.slice(0, edgeLimit).map((edge) => this.#edgeView(edge, 'forward')),
          incoming: incoming.slice(0, edgeLimit).map((edge) => this.#edgeView(edge, 'backward')),
          truncated: outgoing.length > edgeLimit || incoming.length > edgeLimit,
        };
      }
      nodes.push(view);
    }
    return { nodes, missing };
  }

  /** One edge plus the node at its far end. */
  #edgeView(edge, traversal) {
    const neighborId = traversal === 'forward' ? edge.to_id : edge.from_id;
    const neighbor = this.nodes.get(neighborId);
    return {
      ...publicEdge(edge),
      traversal,
      neighbor:
        neighbor === undefined
          ? { id: neighborId, name: '', type: 'other' }
          : { id: neighbor.id, name: neighbor.name, type: neighbor.type },
    };
  }

  /**
   * Apply one atomic batch of node and edge writes. Every operation is planned
   * and validated before the transaction starts; memory changes only after the
   * commit succeeds.
   * @param input - raw argument object from the tool.
   * @param context - caller facts.
   * @param context.sessionId - session recorded as the writer.
   * @param context.cwd - directory used for relative attachment paths.
   * @returns a per-operation report.
   */
  save(input, { sessionId, cwd }) {
    this.assertReady();
    const body = asObject(input, 'arguments');
    const nodeSpec = body.nodes === undefined ? {} : asObject(body.nodes, 'nodes');
    const edgeSpec = body.edges === undefined ? {} : asObject(body.edges, 'edges');
    const now = nowIso();
    const plan = emptyPlan();
    const aliases = new Map();
    const batchIds = new Set();
    /** @type {object[]} */
    const nodeOps = [];
    /** @type {object[]} */
    const edgeOps = [];

    for (const raw of arrayOrEmpty(nodeSpec.create, 'nodes.create')) {
      const item = asObject(raw, 'nodes.create[]');
      const supplied = optionalId(item.id);
      let id;
      let alias;
      if (supplied === undefined) {
        id = randomUUID();
      } else if (supplied.startsWith('$')) {
        alias = supplied;
        if (aliases.has(alias)) {
          throw new GraphError(
            'duplicate_ref',
            `\`${alias}\` is used twice in this call; give each new node a distinct reference.`
          );
        }
        id = randomUUID();
        aliases.set(alias, id);
      } else {
        id = supplied;
        if (this.nodes.has(id) || batchIds.has(id)) {
          throw new GraphError('already_exists', `Node ${id} already exists; use \`update\` to change it.`);
        }
      }
      batchIds.add(id);
      const fields = nodeFields(item, { partial: false, cwd });
      const record = {
        id,
        ...fields,
        created_at: now,
        updated_at: now,
        created_by_session_id: sessionId,
        updated_by_session_id: sessionId,
        revision: 1,
      };
      plan.nodeWrites.push(record);
      plan.history.push(historyRow(now, sessionId, 'node', id, 'create', 1, null, publicNode(record)));
      nodeOps.push({ kind: 'create', record });
    }

    for (const raw of arrayOrEmpty(nodeSpec.update, 'nodes.update')) {
      const item = asObject(raw, 'nodes.update[]');
      const id = requiredId(item.id, 'nodes.update[].id');
      const current = this.nodes.get(id);
      if (current === undefined)
        throw new GraphError('not_found', `Node ${id} does not exist; create it instead.`);
      const expected = expectedRevision(item.expected_revision);
      if (expected !== undefined && expected !== current.revision) {
        throw revisionConflict('node', id, expected, current.revision);
      }
      const fields = nodeFields(item, { partial: true, cwd });
      const changed = diffNode(current, fields);
      if (changed === null) {
        nodeOps.push({ kind: 'unchanged', id });
        continue;
      }
      const record = {
        ...current,
        ...changed,
        updated_at: now,
        updated_by_session_id: sessionId,
        revision: current.revision + 1,
      };
      plan.nodeWrites.push(record);
      plan.history.push(
        historyRow(
          now,
          sessionId,
          'node',
          id,
          'update',
          record.revision,
          publicNode(current),
          publicNode(record)
        )
      );
      nodeOps.push({ kind: 'update', record });
    }

    /** Resolve a `$alias` to the id created in this same call. */
    const resolveRef = (value, label) => {
      if (typeof value !== 'string') throw new GraphError('invalid_args', `\`${label}\` must be a string.`);
      const text = value.trim();
      if (text.length === 0) throw new GraphError('invalid_args', `\`${label}\` must not be empty.`);
      if (text.startsWith('$')) {
        const mapped = aliases.get(text);
        if (mapped === undefined) {
          throw new GraphError(
            'unknown_ref',
            `\`${label}\` references ${text}, which this call does not create.`
          );
        }
        return mapped;
      }
      return optionalId(text);
    };

    /** Both endpoints must exist now or be created earlier in this call. */
    const requireEndpoint = (id, label) => {
      if (this.nodes.has(id) || batchIds.has(id)) return id;
      throw new GraphError(
        'not_found',
        `\`${label}\` names node ${id}, which does not exist; create it first.`
      );
    };

    const pendingEdges = new Set();
    for (const raw of arrayOrEmpty(edgeSpec.create, 'edges.create')) {
      const item = asObject(raw, 'edges.create[]');
      const fromId = requireEndpoint(resolveRef(item.from_id, 'edges.create[].from_id'), 'from_id');
      const toId = requireEndpoint(resolveRef(item.to_id, 'edges.create[].to_id'), 'to_id');
      const fields = edgeFields(item, { partial: false, defaultRelation: DEFAULT_RELATION });
      const key = tupleKey(fromId, fields.relation, toId);
      if (this.outgoing(fromId).has(key) || pendingEdges.has(key)) {
        throw new GraphError(
          'already_exists',
          `An edge ${fromId} —${fields.relation}→ ${toId} already exists; use \`update\` to change its description or \`new_relation\` to rename the relation.`
        );
      }
      pendingEdges.add(key);
      const record = {
        from_id: fromId,
        relation: fields.relation,
        to_id: toId,
        description: fields.description,
        created_at: now,
        updated_at: now,
        updated_by_session_id: sessionId,
        revision: 1,
      };
      plan.edgeWrites.push(record);
      plan.history.push(
        historyRow(
          now,
          sessionId,
          'edge',
          edgeTargetKey(fromId, fields.relation, toId),
          'create',
          1,
          null,
          publicEdge(record)
        )
      );
      edgeOps.push({ kind: 'create', record });
    }

    for (const raw of arrayOrEmpty(edgeSpec.update, 'edges.update')) {
      const item = asObject(raw, 'edges.update[]');
      const fromId = requiredId(item.from_id, 'edges.update[].from_id');
      const toId = requiredId(item.to_id, 'edges.update[].to_id');
      const selector = item.relation === undefined ? undefined : validateRelation(item.relation);
      const rename = item.new_relation === undefined ? undefined : validateRelation(item.new_relation);
      const candidates = this.edgesBetween(fromId, toId);
      if (candidates.length === 0) {
        throw new GraphError('not_found', `No edge exists from ${fromId} to ${toId}; create it instead.`);
      }
      let current;
      let legacyRename;
      if (selector !== undefined) {
        current = candidates.find((edge) => edge.relation === selector);
        if (current === undefined) {
          if (candidates.length > 1) {
            throw ambiguityError(fromId, toId, candidates, selector);
          }
          // One edge between the pair: keep the older call shape, where
          // `relation` was the replacement label, working unchanged.
          current = candidates[0];
          legacyRename = selector;
        }
      } else if (candidates.length > 1) {
        throw ambiguityError(fromId, toId, candidates);
      } else {
        current = candidates[0];
      }
      const expected = expectedRevision(item.expected_revision);
      if (expected !== undefined && expected !== current.revision) {
        throw revisionConflict('edge', `${fromId} —${current.relation}→ ${toId}`, expected, current.revision);
      }
      const description = item.description === undefined ? undefined : validateDescription(item.description);
      const relation = rename ?? legacyRename ?? current.relation;
      const changed = diffEdge(current, { relation, description });
      if (changed === null) {
        edgeOps.push({ kind: 'unchanged', edge: current });
        continue;
      }
      const record = {
        ...current,
        ...changed,
        updated_at: now,
        updated_by_session_id: sessionId,
        revision: current.revision + 1,
      };
      if (record.relation !== current.relation) plan.edgeDeletes.push(current);
      plan.edgeWrites.push(record);
      plan.history.push(
        historyRow(
          now,
          sessionId,
          'edge',
          edgeTargetKey(record.from_id, record.relation, record.to_id),
          'update',
          record.revision,
          publicEdge(current),
          publicEdge(record)
        )
      );
      edgeOps.push({ kind: 'update', record, before: current });
    }

    if (!planIsEmpty(plan)) {
      this.#persist(plan, 'write');
      this.#applyPlan(plan);
    }

    return this.#saveReport(nodeOps, edgeOps);
  }

  /** Build the tool-facing report for one batch. */
  #saveReport(nodeOps, edgeOps) {
    const createdNodes = [];
    const updatedNodes = [];
    const unchangedNodes = [];
    for (const op of nodeOps) {
      if (op.kind === 'create') createdNodes.push({ id: op.record.id, name: op.record.name });
      else if (op.kind === 'update') {
        updatedNodes.push({ id: op.record.id, name: op.record.name, revision: op.record.revision });
      } else unchangedNodes.push(op.id);
    }
    const createdEdges = [];
    const updatedEdges = [];
    const unchangedEdges = [];
    for (const op of edgeOps) {
      if (op.kind === 'create') {
        createdEdges.push({
          from_id: op.record.from_id,
          relation: op.record.relation,
          to_id: op.record.to_id,
        });
      } else if (op.kind === 'update') {
        updatedEdges.push({
          from_id: op.record.from_id,
          relation: op.record.relation,
          to_id: op.record.to_id,
          revision: op.record.revision,
        });
      } else {
        unchangedEdges.push({
          from_id: op.edge.from_id,
          relation: op.edge.relation,
          to_id: op.edge.to_id,
        });
      }
    }
    return {
      ok: true,
      nodes: { created: createdNodes, updated: updatedNodes, unchanged: unchangedNodes },
      edges: { created: createdEdges, updated: updatedEdges, unchanged: unchangedEdges },
    };
  }

  /**
   * Execute one planned write in a single transaction. Memory is untouched on
   * failure, and every changelog row lands in the same transaction as the data
   * it describes.
   * @param plan - planned operations.
   * @param action - message suffix used when SQL fails.
   */
  #persist(plan, action) {
    const db = this.#ensureOpen();
    db.exec('BEGIN IMMEDIATE');
    try {
      const upsertNode = db.prepare(
        'INSERT INTO node (id, name, type, tags, description, attachments, created_at, updated_at, created_by_session_id, updated_by_session_id, revision)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)' +
          ' ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, tags = excluded.tags,' +
          ' description = excluded.description, attachments = excluded.attachments, updated_at = excluded.updated_at,' +
          ' updated_by_session_id = excluded.updated_by_session_id, revision = excluded.revision'
      );
      const deleteNode = db.prepare('DELETE FROM node WHERE id = ?');
      const upsertEdge = db.prepare(
        'INSERT INTO edge (from_id, relation, to_id, description, created_at, updated_at, updated_by_session_id, revision)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)' +
          ' ON CONFLICT(from_id, relation, to_id) DO UPDATE SET description = excluded.description,' +
          ' updated_at = excluded.updated_at, updated_by_session_id = excluded.updated_by_session_id, revision = excluded.revision'
      );
      const deleteEdge = db.prepare('DELETE FROM edge WHERE from_id = ? AND relation = ? AND to_id = ?');
      const insertHistory = db.prepare(
        'INSERT INTO history (timestamp, session_id, target_kind, target_key, operation, revision, before_snapshot, after_snapshot)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const record of plan.nodeWrites) {
        upsertNode.run(
          record.id,
          record.name,
          record.type,
          JSON.stringify(record.tags),
          record.description,
          JSON.stringify(record.attachments),
          record.created_at,
          record.updated_at,
          record.created_by_session_id,
          record.updated_by_session_id,
          record.revision
        );
      }
      for (const edge of plan.edgeDeletes) deleteEdge.run(edge.from_id, edge.relation, edge.to_id);
      for (const record of plan.edgeWrites) {
        upsertEdge.run(
          record.from_id,
          record.relation,
          record.to_id,
          record.description,
          record.created_at,
          record.updated_at,
          record.updated_by_session_id,
          record.revision
        );
      }
      for (const node of plan.nodeDeletes) deleteNode.run(node.id);
      for (const row of plan.history) {
        insertHistory.run(
          row.timestamp,
          row.session_id,
          row.target_kind,
          row.target_key,
          row.operation,
          row.revision,
          row.before,
          row.after
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // A rollback failure must not mask the original error.
      }
      throw error instanceof GraphError
        ? error
        : new GraphError('write_failed', `The graph ${action} was rolled back: ${error.message}`);
    }
  }

  /** Move the committed plan into the in-memory indexes. */
  #applyPlan(plan) {
    for (const record of plan.nodeWrites) this.#indexNode(record);
    for (const edge of plan.edgeDeletes) this.#unindexEdge(edge);
    for (const record of plan.edgeWrites) this.#indexEdge(record);
    for (const node of plan.nodeDeletes) this.#unindexNode(node.id);
    this.#historyCount += plan.history.length;
  }

  /**
   * Delete explicitly identified nodes and edges. A node with incident edges is
   * refused unless the caller accepts removing those edges too.
   * @param input - raw argument object.
   * @param context - caller facts.
   * @param context.sessionId - session recorded as the writer.
   * @returns the deletion report.
   */
  remove(input, { sessionId }) {
    this.assertReady();
    const body = asObject(input, 'arguments');
    const cascade = body.cascade_edges === true;
    const now = nowIso();
    const plan = emptyPlan();
    const nodeTargets = [];
    for (const raw of arrayOrEmpty(body.nodes, 'nodes')) {
      const item = asObject(raw, 'nodes[]');
      const id = requiredId(item.id, 'nodes[].id');
      const current = this.nodes.get(id);
      if (current === undefined) throw new GraphError('not_found', `Node ${id} does not exist.`);
      const expected = expectedRevision(item.expected_revision);
      if (expected !== undefined && expected !== current.revision) {
        throw revisionConflict('node', id, expected, current.revision);
      }
      nodeTargets.push(current);
    }

    const edgeTargets = [];
    for (const raw of arrayOrEmpty(body.edges, 'edges')) {
      const item = asObject(raw, 'edges[]');
      const fromId = requiredId(item.from_id, 'edges[].from_id');
      const toId = requiredId(item.to_id, 'edges[].to_id');
      const selector =
        item.relation === undefined
          ? undefined
          : edgeFields({ relation: item.relation }, { partial: true }).relation;
      const candidates = this.edgesBetween(fromId, toId);
      if (candidates.length === 0) {
        throw new GraphError('not_found', `No edge exists from ${fromId} to ${toId}.`);
      }
      let current;
      if (selector !== undefined) {
        current = candidates.find((edge) => edge.relation === selector);
        if (current === undefined) throw ambiguityError(fromId, toId, candidates, selector);
      } else if (candidates.length > 1) {
        throw ambiguityError(fromId, toId, candidates);
      } else {
        current = candidates[0];
      }
      const expected = expectedRevision(item.expected_revision);
      if (expected !== undefined && expected !== current.revision) {
        throw revisionConflict('edge', `${fromId} —${current.relation}→ ${toId}`, expected, current.revision);
      }
      edgeTargets.push(current);
    }

    const nodeIds = new Set(nodeTargets.map((node) => node.id));
    const incident = [];
    if (nodeIds.size > 0) {
      const seen = new Set();
      for (const id of nodeIds) {
        for (const edge of [...this.outgoing(id).values(), ...this.incoming(id).values()]) {
          const key = edgeKey(edge);
          if (seen.has(key)) continue;
          seen.add(key);
          incident.push(edge);
        }
      }
    }
    if (incident.length > 0 && !cascade) {
      throw new GraphError(
        'has_edges',
        `${nodeTargets.length === 1 ? 'This node has' : 'These nodes have'} ${incident.length} connected edge(s). ` +
          'Pass `cascade_edges: true` to delete them with the node(s).'
      );
    }

    const seenEdges = new Set();
    for (const edge of [...edgeTargets, ...incident]) {
      const key = edgeKey(edge);
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      plan.edgeDeletes.push(edge);
      plan.history.push(
        historyRow(
          now,
          sessionId,
          'edge',
          edgeTargetKey(edge.from_id, edge.relation, edge.to_id),
          'delete',
          edge.revision,
          publicEdge(edge),
          null
        )
      );
    }
    for (const node of nodeTargets) {
      plan.nodeDeletes.push(node);
      plan.history.push(
        historyRow(now, sessionId, 'node', node.id, 'delete', node.revision, publicNode(node), null)
      );
    }

    if (!planIsEmpty(plan)) {
      this.#persist(plan, 'delete');
      this.#applyPlan(plan);
    }

    return {
      ok: true,
      deleted: {
        nodes: nodeTargets.map((node) => node.id),
        edges: plan.edgeDeletes.map((edge) => ({
          from_id: edge.from_id,
          relation: edge.relation,
          to_id: edge.to_id,
        })),
      },
      counts: { nodes: nodeTargets.length, edges: plan.edgeDeletes.length },
    };
  }

  /**
   * Fold `source_id` into `target_id`, rewriting every incident edge, or rename
   * `source_id` to an unused `target_id`. One transaction covers the new target
   * record, the rewired edges, the changelog, and the removal of the source.
   * @param input - raw argument object.
   * @param context - caller facts.
   * @param context.sessionId - session recorded as the writer.
   * @returns the merge report.
   */
  merge(input, { sessionId }) {
    this.assertReady();
    const body = asObject(input, 'arguments');
    const sourceId = requiredId(body.source_id, 'source_id');
    const targetId = requiredId(body.target_id, 'target_id');
    if (sourceId === targetId) {
      throw new GraphError('invalid_args', '`source_id` and `target_id` must be different entities.');
    }
    const source = this.nodes.get(sourceId);
    if (source === undefined) throw new GraphError('not_found', `Node ${sourceId} does not exist.`);
    const target = this.nodes.get(targetId);
    const strategy = validateDescriptionStrategy(body.description_strategy) ?? 'append';
    const mergedDescription =
      body.merged_description === undefined ? undefined : validateDescription(body.merged_description);
    const mergedName = body.merged_name === undefined ? undefined : validateName(body.merged_name);
    const expectedSource = expectedRevision(body.expected_source_revision);
    if (expectedSource !== undefined && expectedSource !== source.revision) {
      throw revisionConflict('node', sourceId, expectedSource, source.revision);
    }
    if (target !== undefined) {
      const expectedTarget = expectedRevision(body.expected_target_revision);
      if (expectedTarget !== undefined && expectedTarget !== target.revision) {
        throw revisionConflict('node', targetId, expectedTarget, target.revision);
      }
    } else if (body.expected_target_revision !== undefined) {
      throw new GraphError(
        'not_found',
        `Node ${targetId} does not exist, so it cannot be locked with \`expected_target_revision\`.`
      );
    }

    const now = nowIso();
    const plan = emptyPlan();
    const renaming = target === undefined;
    /** @type {object} */
    let merged;
    if (renaming) {
      merged = {
        ...source,
        id: targetId,
        name: mergedName ?? source.name,
        description: mergedDescription ?? source.description,
        updated_at: now,
        updated_by_session_id: sessionId,
        revision: source.revision + 1,
      };
    } else {
      const description =
        mergedDescription !== undefined
          ? mergedDescription
          : strategy === 'keep_target'
            ? target.description
            : strategy === 'replace_with_source'
              ? source.description
              : appendText(target.description, source.description);
      merged = {
        ...target,
        name: mergedName ?? target.name,
        tags: unionSorted(target.tags, source.tags),
        attachments: unionList(target.attachments, source.attachments),
        description,
        updated_at: now,
        updated_by_session_id: sessionId,
        revision: target.revision + 1,
      };
    }
    plan.nodeWrites.push(merged);

    // Rewire the source's edges, dropping self-loops and folding duplicates
    // into the edge that already sits on the target.
    const seen = new Set();
    const moves = new Map();
    const dropped = [];
    for (const edge of [...this.outgoing(sourceId).values(), ...this.incoming(sourceId).values()]) {
      const key = edgeKey(edge);
      if (seen.has(key)) continue;
      seen.add(key);
      const fromId = edge.from_id === sourceId ? targetId : edge.from_id;
      const toId = edge.to_id === sourceId ? targetId : edge.to_id;
      if (fromId === toId) {
        dropped.push(edge);
        continue;
      }
      const newKey = tupleKey(fromId, edge.relation, toId);
      if (!moves.has(newKey)) moves.set(newKey, { fromId, toId, edge });
    }

    let movedCount = 0;
    let combinedCount = 0;
    for (const move of moves.values()) {
      const existing = this.edgeOf(move.fromId, move.edge.relation, move.toId);
      if (existing === undefined) {
        const record = {
          ...move.edge,
          from_id: move.fromId,
          to_id: move.toId,
          updated_at: now,
          updated_by_session_id: sessionId,
          revision: move.edge.revision + 1,
        };
        plan.edgeWrites.push(record);
        plan.edgeDeletes.push(move.edge);
        plan.history.push(
          historyRow(
            now,
            sessionId,
            'edge',
            edgeTargetKey(move.edge.from_id, move.edge.relation, move.edge.to_id),
            'delete',
            move.edge.revision,
            publicEdge(move.edge),
            null
          )
        );
        plan.history.push(
          historyRow(
            now,
            sessionId,
            'edge',
            edgeTargetKey(record.from_id, record.relation, record.to_id),
            'create',
            record.revision,
            null,
            publicEdge(record)
          )
        );
        movedCount += 1;
        continue;
      }
      const extra = move.edge.description.trim();
      const description =
        extra.length > 0 && !existing.description.includes(extra)
          ? appendText(existing.description, extra)
          : existing.description;
      if (description !== existing.description) {
        const record = {
          ...existing,
          description,
          updated_at: now,
          updated_by_session_id: sessionId,
          revision: existing.revision + 1,
        };
        plan.edgeWrites.push(record);
        plan.history.push(
          historyRow(
            now,
            sessionId,
            'edge',
            edgeTargetKey(record.from_id, record.relation, record.to_id),
            'update',
            record.revision,
            publicEdge(existing),
            publicEdge(record)
          )
        );
      }
      plan.edgeDeletes.push(move.edge);
      plan.history.push(
        historyRow(
          now,
          sessionId,
          'edge',
          edgeTargetKey(move.edge.from_id, move.edge.relation, move.edge.to_id),
          'delete',
          move.edge.revision,
          publicEdge(move.edge),
          null
        )
      );
      combinedCount += 1;
    }
    for (const edge of dropped) {
      plan.edgeDeletes.push(edge);
      plan.history.push(
        historyRow(
          now,
          sessionId,
          'edge',
          edgeTargetKey(edge.from_id, edge.relation, edge.to_id),
          'delete',
          edge.revision,
          publicEdge(edge),
          null
        )
      );
    }

    plan.nodeDeletes.push(source);
    plan.history.push(
      historyRow(now, sessionId, 'node', sourceId, 'delete', source.revision, publicNode(source), null)
    );
    plan.history.push(
      historyRow(
        now,
        sessionId,
        'node',
        targetId,
        'merge',
        merged.revision,
        publicNode(renaming ? source : target),
        publicNode(merged)
      )
    );

    this.#persist(plan, 'merge');
    this.#applyPlan(plan);

    return {
      ok: true,
      mode: renaming ? 'renamed' : 'merged',
      source_id: sourceId,
      target_id: targetId,
      revision: merged.revision,
      nodes: { removed: 1, written: 1 },
      edges: { moved: movedCount, combined: combinedCount, dropped: dropped.length },
    };
  }

  /**
   * Read changelog rows for one entity or for the whole graph.
   * @param options - validated arguments.
   * @param options.id - optional entity id.
   * @param options.includeEdgeHistory - include edges touching `id`.
   * @param options.since - optional ISO lower bound.
   * @param options.until - optional ISO upper bound.
   * @param options.sessionId - optional writing-session filter.
   * @param options.operations - optional operation filter.
   * @param options.limit - maximum rows to return.
   * @returns the entries, counts, and truncation facts.
   */
  history({ id, includeEdgeHistory, since, until, sessionId, operations, limit }) {
    this.assertReady();
    const db = this.#readDb();
    const counts = { create: 0, update: 0, delete: 0, merge: 0 };
    const empty = {
      mode: id === undefined ? 'diff' : 'entity',
      target: id ?? '',
      since: since ?? '',
      until: until ?? '',
      count: 0,
      total: 0,
      truncated: false,
      counts,
      entries: [],
    };
    if (db === null) return empty;

    const clauses = [];
    const params = [];
    if (since !== undefined) {
      clauses.push('timestamp >= ?');
      params.push(since);
    }
    if (until !== undefined) {
      clauses.push('timestamp <= ?');
      params.push(until);
    }
    if (sessionId !== undefined) {
      clauses.push('session_id = ?');
      params.push(sessionId);
    }
    if (operations !== undefined) {
      clauses.push(`operation IN (${operations.map(() => '?').join(', ')})`);
      params.push(...operations);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare(`SELECT * FROM history ${where} ORDER BY seq DESC LIMIT ${HISTORY_SCAN_LIMIT}`)
      .all(...params);

    const matching = id === undefined ? rows : rows.filter((row) => rowTouches(row, id, includeEdgeHistory));
    const total = matching.length;
    for (const row of matching) {
      if (counts[row.operation] !== undefined) counts[row.operation] += 1;
    }
    const page = matching.slice(0, limit);
    const ordered = id === undefined ? page : [...page].reverse();

    return {
      mode: id === undefined ? 'diff' : 'entity',
      target: id ?? '',
      since: since ?? '',
      until: until ?? '',
      count: ordered.length,
      total,
      truncated: total > ordered.length,
      counts,
      entries: ordered.map((row) => {
        const before = parseSnapshot(row.before_snapshot);
        const after = parseSnapshot(row.after_snapshot);
        const entry = {
          seq: Number(row.seq),
          timestamp: row.timestamp,
          session_id: row.session_id,
          target_kind: row.target_kind,
          target_key: row.target_key,
          operation: row.operation,
          revision: Number(row.revision),
        };
        if (before !== null) entry.before = before;
        if (after !== null) entry.after = after;
        return entry;
      }),
    };
  }

  /**
   * The database connection used by changelog reads. A missing file is a normal
   * empty history and must not be created just to answer a read.
   * @returns the connection, or null.
   */
  #readDb() {
    if (this.#db !== null) return this.#db;
    if (!existsSync(this.dbPath)) return null;
    return this.#open();
  }
}

/**
 * Whether a changelog row concerns one entity.
 * @param row - raw history row.
 * @param id - entity id.
 * @param includeEdgeHistory - whether edge mutations count.
 * @returns whether the row belongs to the entity's history.
 */
function rowTouches(row, id, includeEdgeHistory) {
  if (row.target_kind === 'node') {
    if (row.target_key === id) return true;
    if (parseSnapshot(row.before_snapshot)?.id === id) return true;
    return parseSnapshot(row.after_snapshot)?.id === id;
  }
  if (!includeEdgeHistory) return false;
  const triple = parseEdgeTriple(row.target_key);
  if (triple !== null && (triple[0] === id || triple[2] === id)) return true;
  const before = parseSnapshot(row.before_snapshot);
  const after = parseSnapshot(row.after_snapshot);
  return touchesEdge(before, id) || touchesEdge(after, id);
}

/**
 * Whether an edge snapshot has `id` at either end.
 * @param snapshot - parsed edge record or null.
 * @param id - entity id.
 * @returns whether the edge touches the entity.
 */
function touchesEdge(snapshot, id) {
  if (snapshot === null || typeof snapshot !== 'object') return false;
  return snapshot.from_id === id || snapshot.to_id === id;
}

/**
 * Parse one JSON snapshot column.
 * @param text - stored JSON or null.
 * @returns the parsed value, or null.
 */
function parseSnapshot(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Parse a serialized edge triple.
 * @param text - stored `["from","relation","to"]`.
 * @returns the triple, or null when unreadable.
 */
function parseEdgeTriple(text) {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === 'string')) {
      return value;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Append one non-empty text block to another.
 * @param base - existing description.
 * @param extra - text to add.
 * @returns the combined description.
 */
function appendText(base, extra) {
  const left = base.trim();
  const right = extra.trim();
  if (left.length === 0) return right;
  if (right.length === 0) return left;
  if (left.includes(right)) return left;
  return `${left}\n\n${right}`;
}

/**
 * Union two sorted tag lists, preserving canonical order.
 * @param left - first list.
 * @param right - second list.
 * @returns the sorted union.
 */
function unionSorted(left, right) {
  return [...new Set([...left, ...right])].sort();
}

/**
 * Union two lists, keeping first-seen order.
 * @param left - first list.
 * @param right - second list.
 * @returns the deduplicated union.
 */
function unionList(left, right) {
  const out = [...left];
  for (const item of right) if (!out.includes(item)) out.push(item);
  return out;
}

/**
 * Build the ambiguity error for a node pair with several relations.
 * @param fromId - source id.
 * @param toId - target id.
 * @param candidates - the stored edges.
 * @param wanted - the relation the caller asked for, when it does not exist.
 * @returns the error to throw.
 */
function ambiguityError(fromId, toId, candidates, wanted) {
  const labels = candidates
    .map((edge) => edge.relation)
    .sort()
    .join(', ');
  const prefix =
    wanted === undefined
      ? `${fromId} and ${toId} hold ${candidates.length} relations`
      : `No ${wanted} relation exists from ${fromId} to ${toId}; that pair holds ${candidates.length}`;
  return new GraphError('ambiguous_edge', `${prefix}: ${labels}. Pass \`relation\` to name one.`, {
    relations: candidates.map((edge) => edge.relation),
  });
}

/**
 * Read an integer pragma.
 * @param db - open database.
 * @param name - pragma name.
 * @returns the integer value, or 0.
 */
function readPragma(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  const value = row === undefined ? 0 : Number(row[name]);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Whether a table exists.
 * @param db - open database.
 * @param name - table name.
 * @returns whether it exists.
 */
function hasTable(db, name) {
  return (
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

/**
 * Whether a table already has a column.
 * @param db - open database.
 * @param table - table name.
 * @param column - column name.
 * @returns whether it exists.
 */
function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

/**
 * Compare stored node fields with a partial update.
 * @param current - indexed node.
 * @param fields - supplied fields.
 * @returns the changed fields, or null when nothing would change.
 */
function diffNode(current, fields) {
  const changed = {};
  let any = false;
  if (fields.name !== undefined && fields.name !== current.name) {
    changed.name = fields.name;
    any = true;
  }
  if (fields.type !== undefined && fields.type !== current.type) {
    changed.type = fields.type;
    any = true;
  }
  if (fields.description !== undefined && fields.description !== current.description) {
    changed.description = fields.description;
    any = true;
  }
  if (fields.tags !== undefined && !sameArray(fields.tags, current.tags)) {
    changed.tags = fields.tags;
    any = true;
  }
  if (fields.attachments !== undefined && !sameArray(fields.attachments, current.attachments)) {
    changed.attachments = fields.attachments;
    any = true;
  }
  return any ? changed : null;
}

/**
 * Compare stored edge fields with a partial update.
 * @param current - indexed edge.
 * @param fields - supplied fields.
 * @returns the changed fields, or null when nothing would change.
 */
function diffEdge(current, fields) {
  const changed = {};
  let any = false;
  if (fields.relation !== undefined && fields.relation !== current.relation) {
    changed.relation = fields.relation;
    any = true;
  }
  if (fields.description !== undefined && fields.description !== current.description) {
    changed.description = fields.description;
    any = true;
  }
  return any ? changed : null;
}

/**
 * Element-wise array equality.
 * @param left - first array.
 * @param right - second array.
 * @returns whether both hold the same values in the same order.
 */
function sameArray(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Build the stale-write error.
 * @param kind - `node` or `edge`.
 * @param label - id or edge label.
 * @param expected - the revision the caller believed.
 * @param actual - the current revision.
 * @returns the error to throw.
 */
function revisionConflict(kind, label, expected, actual) {
  return new GraphError(
    'revision_conflict',
    `Revision conflict on ${kind} ${label}: expected ${expected}, current ${actual}. Read it again, then retry with the current revision or omit \`expected_revision\`.`,
    { expected, actual }
  );
}
