/**
 * One-time adoption of a profile-local graph into the installation-wide store.
 *
 * Before this plugin moved to `<DSH_HOME>/knowledge-graph`, every profile kept
 * its own `graph.sqlite` under `<profile>/data/dsh-knowledge-graph`. On the
 * first start at the new location this module picks the richest non-empty
 * legacy database, copies it with `VACUUM INTO` (a consistent snapshot that
 * includes the write-ahead log), validates it, and publishes it atomically.
 *
 * Legacy files are renamed, not deleted. A process lock serializes two profiles
 * starting at once. Nothing runs when the target already exists, so a purge is
 * never undone by a later restart.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import * as sqlite from 'node:sqlite';
import { APPLICATION_ID, SCHEMA_VERSION } from './store.js';

/** Node 22 exposes `DatabaseSync`; later releases also alias it as `Database`. */
const Database = sqlite.DatabaseSync ?? sqlite.Database;

/** How long a second starting profile waits for the migrating one. */
const LOCK_WAIT_MS = 3_000;
/** A lock older than this is treated as left behind by a crashed process. */
const LOCK_STALE_MS = 60_000;

/** Sleep synchronously during startup, before any event loop work is pending. */
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Inspect one candidate database without changing it.
 * @param path - candidate `graph.sqlite`.
 * @returns its facts, or null when it is absent, foreign, or unreadable.
 */
function inspect(path) {
  if (!existsSync(path)) return null;
  let db;
  try {
    db = new Database(path, { readOnly: true });
    const applicationId = Number(db.prepare('PRAGMA application_id').get().application_id);
    if (applicationId !== 0 && applicationId !== APPLICATION_ID) return null;
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (version > SCHEMA_VERSION) return null;
    const hasNode =
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'node'").get() !==
      undefined;
    if (!hasNode) return null;
    const nodes = Number(db.prepare('SELECT count(*) AS n FROM node').get().n);
    const latest = db.prepare('SELECT max(updated_at) AS m FROM node').get().m ?? '';
    return { path, nodes, latest, size: statSync(path).size };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // A failure to close a read-only probe must not fail migration.
    }
  }
}

/**
 * Every profile-local graph this installation may still hold.
 * @param home - resolved DSH home.
 * @param profileDir - the active profile directory, when known.
 * @returns candidate database paths, current profile first.
 */
function candidates(home, profileDir) {
  const paths = [];
  if (typeof profileDir === 'string' && profileDir.length > 0) {
    paths.push(join(profileDir, 'data', 'dsh-knowledge-graph', 'graph.sqlite'));
  }
  if (typeof home === 'string' && home.length > 0) {
    let entries = [];
    try {
      entries = readdirSync(join(home, 'profiles'), { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      paths.push(join(home, 'profiles', entry.name, 'data', 'dsh-knowledge-graph', 'graph.sqlite'));
    }
  }
  return [...new Set(paths)];
}

/**
 * Sort the richest legacy graph first: newest activity, then most entities.
 * @param left - first candidate.
 * @param right - second candidate.
 * @returns comparison for `Array.prototype.sort`.
 */
function compareCandidates(left, right) {
  if (left.latest !== right.latest) return left.latest < right.latest ? 1 : -1;
  if (left.nodes !== right.nodes) return right.nodes - left.nodes;
  return right.size - left.size;
}

/**
 * Take the migration lock, waiting for a concurrent profile and clearing a
 * stale lock left by a crash.
 * @param dir - target data directory.
 * @returns the lock path, or null when another process kept it too long.
 */
function acquireLock(dir) {
  const path = join(dir, '.migration.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'));
      return path;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
      } catch {
        // It disappeared between open and stat; retry immediately.
        if (!existsSync(path)) continue;
      }
      if (stale) {
        rmSync(path, { force: true });
        continue;
      }
      if (Date.now() >= deadline) return null;
      sleep(50);
    }
  }
}

/**
 * Quote one filesystem path for a SQLite string literal.
 * @param path - absolute path.
 * @returns the quoted literal.
 */
function quote(path) {
  return `'${path.replace(/'/g, "''")}'`;
}

/**
 * Copy one legacy graph into the target directory and publish it atomically.
 * @param source - inspected candidate.
 * @param targetDir - installation-wide graph directory.
 * @returns the published database path.
 */
function copyInto(source, targetDir) {
  const target = join(targetDir, 'graph.sqlite');
  const temporary = join(targetDir, `.migrating-${process.pid}-${Date.now()}.sqlite`);
  const db = new Database(source.path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec(`VACUUM INTO ${quote(temporary)}`);
  } finally {
    try {
      db.close();
    } catch {
      // The snapshot is already on disk; a close failure must not discard it.
    }
  }
  const copy = inspect(temporary);
  if (copy === null) {
    rmSync(temporary, { force: true });
    throw new Error(`the copy of ${source.path} did not validate as a knowledge-graph database`);
  }
  if (existsSync(target)) {
    const existing = inspect(target);
    // A profile that lost the startup race may have created an empty database
    // before the lock was published; adopt the migrated copy over it.
    if (existing !== null && existing.nodes > 0) {
      rmSync(temporary, { force: true });
      return target;
    }
    rmSync(target, { force: true });
    rmSync(target + '-wal', { force: true });
    rmSync(target + '-shm', { force: true });
  }
  try {
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

/**
 * Move the richest legacy profile graph to the installation-wide location.
 *
 * Migration runs only when the target database is absent. The chosen source is
 * renamed as a backup; other non-empty legacy databases are reported and left
 * untouched.
 * @param options - migration inputs.
 * @param options.dataDir - target graph directory.
 * @param options.home - resolved DSH home, or null for a custom location.
 * @param options.profileDir - active profile directory, when known.
 * @param options.logger - host logger.
 * @returns the migrated source path, or null when nothing was needed.
 */
export function migrateLegacyGraph({ dataDir, home, profileDir, logger }) {
  const target = join(dataDir, 'graph.sqlite');
  if (existsSync(target)) return null;

  const found = candidates(home, profileDir)
    .map(inspect)
    .filter((candidate) => candidate !== null && candidate.nodes > 0)
    .sort(compareCandidates);
  if (found.length === 0) return null;

  mkdirSync(dataDir, { recursive: true });
  const lock = acquireLock(dataDir);
  if (lock === null) {
    logger?.warn?.(
      `knowledge-graph: another DSH profile is migrating the graph into ${dataDir}; continuing without migration`
    );
    return null;
  }
  try {
    if (existsSync(target)) return null;
    const source = found[0];
    copyInto(source, dataDir);
    const stamp = new Date().toISOString().slice(0, 10);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = source.path + suffix;
      if (!existsSync(file)) continue;
      try {
        renameSync(file, `${file}.migrated-${stamp}`);
      } catch (error) {
        logger?.warn?.(`knowledge-graph: could not rename ${file}: ${error.message}`);
      }
    }
    logger?.info?.(`knowledge-graph: migrated ${source.nodes} entities from ${source.path} to ${target}`);
    for (const other of found.slice(1)) {
      logger?.warn?.(
        `knowledge-graph: left ${other.nodes} entities in ${other.path} untouched; the shared graph is now ${target}`
      );
    }
    return source.path;
  } finally {
    rmSync(lock, { force: true });
  }
}
