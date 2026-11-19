/**
 * Archive purge Host half.
 *
 * Counts archived Sessions by their latest log activity and deletes archived
 * session logs only on an explicit, two-step user confirmation from the
 * Plugins page.
 *
 * The harness archive set stores session ids only, with no archive timestamp,
 * so "inactive for N days" compares the current log generation's last write
 * (its mtime), never the moment the Session was archived. Deletion is
 * user-only: these routes back the page, and no agent tool reaches them.
 *
 * A purge removes the Session's artifact directory, drops its derived
 * projection-cache row, removes the id from the archive set, and detaches it
 * from every Workspace that still accounts it. Attachments are
 * content-addressed and shared, so they are intentionally left in place.
 *
 * A Session the Host still keeps resident holds its log's write lease, so the
 * purge runs that Session's agent-loop lifecycle teardown first: the harness
 * exposes no "unload one Session" call, and archiving only stops work. A
 * Session with a running turn, or one another writer holds, is still skipped.
 */

import { rm, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

export const name = 'archive-purge';

/** The registry owns the archive set; persistence locates and claims each log. */
export const inject = ['workspaceRegistry', 'sessionPersistence'];

/** Days without a log write after which an archived Session counts as inactive. */
const OLDER_THAN_DAYS = 7;

const STATUS_PATH = '/archive-purge/status';
const PURGE_PATH = '/archive-purge/purge';
const PURGE_HEADER = 'x-dsh-archive-purge';
const PURGE_HEADER_VALUE = 'purge';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4_096;

/** Human-readable failure text. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** One JSON response with an explicit length so HEAD and keep-alive behave. */
function sendJson(res, status, value, head = false) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(head ? undefined : body);
}

/** Read a small JSON body, refusing anything above the cap. */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Read every archived Session's stored log state once.
 *
 * The persistence listing supplies each Session's header, size, and artifact
 * location without opening a log; one `stat` per session then supplies the
 * last-write time used as its latest activity. A session whose log cannot be
 * located is reported as missing instead of being guessed at.
 *
 * @param ctx - the plugin context (workspace registry and persistence).
 * @returns the archived ids, their activity data, and the derived counts.
 */
async function classify(ctx) {
  const registry = ctx.workspaceRegistry;
  const archivedIds = [...registry.archivedSessionIds].map((id) => String(id));
  const cutoff = Date.now() - OLDER_THAN_DAYS * DAY_MS;
  const snapshots = await ctx.sessionPersistence.list();
  const byId = new Map(snapshots.map((snapshot) => [String(snapshot.header.id), snapshot]));
  const entries = new Map();
  let bytes = 0;
  let missing = 0;

  await Promise.all(
    archivedIds.map(async (id) => {
      const snapshot = byId.get(id);
      const location = snapshot?.location;
      if (location === undefined) {
        missing += 1;
        return;
      }
      try {
        const info = await stat(location.path);
        const size = snapshot.sizeBytes ?? info.size;
        entries.set(id, { location, mtimeMs: info.mtimeMs, size });
        bytes += size;
      } catch {
        missing += 1;
      }
    })
  );

  let older = 0;
  let olderBytes = 0;
  for (const entry of entries.values()) {
    if (entry.mtimeMs >= cutoff) continue;
    older += 1;
    olderBytes += entry.size;
  }

  return { archivedIds, entries, cutoff, bytes, older, olderBytes, missing };
}

/** The wire-safe counts the page renders; paths and ids stay on the Host. */
function statusOf(classified) {
  return {
    archived: classified.archivedIds.length,
    older: classified.older,
    bytes: classified.bytes,
    olderBytes: classified.olderBytes,
    missing: classified.missing,
    cutoff: classified.cutoff,
    olderThanDays: OLDER_THAN_DAYS,
    residentRelease: true,
  };
}

/**
 * Record which Workspaces still account each target before any file is
 * removed, so a successful deletion can detach the session from every one.
 */
function planDetach(registry, targets) {
  const plan = new Map();
  for (const workspace of registry.list()) {
    for (const sessionId of workspace.sessionIds) {
      const id = String(sessionId);
      if (!targets.has(id)) continue;
      const workspaces = plan.get(id);
      if (workspaces === undefined) plan.set(id, [workspace]);
      else workspaces.push(workspace);
    }
  }
  return plan;
}

/** Cordis effect label the agent loop puts on one Session's owned teardown. */
const LIFECYCLE_LABEL_PREFIX = 'agentLoop.lifecycle(';
const RELEASE_POLL_MS = 25;
const RELEASE_POLL_TRIES = 120;

/**
 * The lifecycle label a Cordis effect disposer carries, when it carries one.
 * `Fiber.getEffects()` reports the same label but not the disposer, and the
 * disposer is the only callable handle on that teardown.
 * @param disposer - one registered Cordis effect disposer.
 * @returns its effect label, or undefined for an unlabeled or other disposable.
 */
function effectLabelOf(disposer) {
  if (typeof disposer !== 'function') return undefined;
  for (const key of Object.getOwnPropertySymbols(disposer)) {
    const meta = disposer[key];
    if (meta !== null && typeof meta === 'object' && typeof meta.label === 'string') {
      return meta.label;
    }
  }
  return undefined;
}

/**
 * Run the exact `agentLoop.lifecycle(<id>)` teardown of one resident Agent.
 *
 * The harness exposes no "unload one Session" call: the Agent handle that owns
 * this teardown is dropped by the Session controller when it resumes a Session,
 * and archiving only stops work. The effect itself stays registered on the
 * Session controller's fiber, so calling its Cordis disposer performs the same
 * teardown the Host runs on shutdown — cancel and drain the turn, dispose the
 * Agent's scope, close the write handle, unregister the Agent and Session.
 *
 * Two private Cordis details are read (`fiber._disposables` and the effect
 * label symbol property). A harness that changes either makes this release a
 * clean no-op, so the purge falls back to reporting the Session as active.
 *
 * @param ctx - the plugin context (registry and logger).
 * @param id - resident Session to release.
 * @returns whether the Session left the live store.
 */
async function releaseResident(ctx, id) {
  const agent = ctx.get('agents')?.get(id);
  // A running turn still owns its log: only an idle Agent may be unloaded.
  if (agent === undefined || agent.status === 'running') return false;
  const registry = ctx.registry;
  if (registry === undefined || typeof registry.values !== 'function') return false;
  const label = `${LIFECYCLE_LABEL_PREFIX}${id})`;
  let teardown;
  for (const runtime of registry.values()) {
    for (const fiber of runtime.fibers ?? []) {
      for (const disposer of fiber._disposables ?? []) {
        if (effectLabelOf(disposer) !== label) continue;
        teardown = disposer;
        break;
      }
      if (teardown !== undefined) break;
    }
    if (teardown !== undefined) break;
  }
  if (teardown === undefined) return false;
  let failure;
  try {
    await teardown();
  } catch (error) {
    // Teardown collects failures but still runs every cleanup step, so the
    // Session may have left the store even though the disposer rejected.
    failure = error;
  }
  for (let attempt = 0; attempt < RELEASE_POLL_TRIES; attempt += 1) {
    if (ctx.get('sessions')?.get(id) === undefined) return true;
    await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS));
  }
  if (failure !== undefined) {
    ctx.logger?.warn?.(`archive-purge: could not release "${id}": ${messageOf(failure)}`);
  }
  return false;
}

/** Drop the derived projection-cache row; a failure only costs a later replay. */
async function removeCacheRow(ctx, id) {
  try {
    const domain = ctx.get('storageDomain')?.get?.('session_projcache');
    const table = domain?.table?.('sessions');
    if (table === undefined) return;
    await table.delete(id);
  } catch (error) {
    ctx.logger?.warn?.(
      `archive-purge: could not drop the projection cache row for "${id}": ${messageOf(error)}`
    );
  }
}

/**
 * Remove one archived Session's archive-set membership and Workspace account.
 * Runs after the log is gone (or when it was already absent), so a failed
 * deletion leaves the Session archived and retryable.
 */
async function cleanupRecord(ctx, registry, id, detachPlan) {
  await registry.unarchiveSession(id);
  const workspaces = detachPlan.get(id);
  if (workspaces === undefined) return;
  for (const workspace of workspaces) {
    try {
      await workspace.detachSession(id);
    } catch (error) {
      ctx.logger?.warn?.(
        `archive-purge: could not detach "${id}" from workspace "${workspace.id}": ${messageOf(error)}`
      );
    }
  }
}

/**
 * Delete one target. A resident but idle Session is unloaded first, because its
 * loaded Agent holds the write lease and the log cannot be removed under it; a
 * running turn and another writer are skipped rather than forced.
 */
async function purgeOne(ctx, registry, id, entry, detachPlan) {
  let released = false;
  if (ctx.get('sessions')?.get(id) !== undefined) {
    released = await releaseResident(ctx, id);
    if (!released) return { id, reason: 'active' };
  }

  if (entry === undefined) {
    await cleanupRecord(ctx, registry, id, detachPlan);
    return { id, reason: 'no-log', released };
  }

  let handle;
  try {
    handle = await ctx.sessionPersistence.open(id, 'write');
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'SessionAlreadyOwnedError') return { id, reason: 'owned', released };
    if (name === 'SessionPersistenceNotFoundError') {
      await cleanupRecord(ctx, registry, id, detachPlan);
      return { id, reason: 'no-log', released };
    }
    return { id, reason: 'unreadable', detail: messageOf(error), released };
  }
  try {
    await handle.close();
  } catch {
    // Closing still releases the in-process claim and the kernel lease.
  }

  const dir = dirname(entry.location.path);
  if (basename(dir) !== id) return { id, reason: 'unsafe-path', released };

  try {
    await rm(dir, { recursive: true, force: true });
  } catch (error) {
    return { id, reason: 'delete-failed', detail: messageOf(error), released };
  }

  await cleanupRecord(ctx, registry, id, detachPlan);
  await removeCacheRow(ctx, id);
  return { id, reason: undefined, bytes: entry.size, released };
}

/**
 * Recompute the eligible set at request time and delete it. The caller never
 * supplies ids, so a stale page cannot purge a different set than it showed.
 */
async function runPurge(ctx, scope) {
  const classified = await classify(ctx);
  const targets =
    scope === 'older'
      ? classified.archivedIds.filter((id) => {
          const entry = classified.entries.get(id);
          return entry !== undefined && entry.mtimeMs < classified.cutoff;
        })
      : classified.archivedIds;

  const detachPlan = planDetach(ctx.workspaceRegistry, new Set(targets));
  const skipped = [];
  let deleted = 0;
  let released = 0;
  let bytesFreed = 0;

  for (const id of targets) {
    let result;
    try {
      result = await purgeOne(ctx, ctx.workspaceRegistry, id, classified.entries.get(id), detachPlan);
    } catch (error) {
      // One unreadable record must not abandon the rest of the batch.
      result = { id, reason: 'cleanup-failed', detail: messageOf(error) };
    }
    if (result.reason === undefined) {
      deleted += 1;
      bytesFreed += result.bytes ?? 0;
      if (result.released === true) released += 1;
    } else {
      skipped.push({
        id,
        reason: result.reason,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
    }
  }

  let remaining = null;
  try {
    remaining = statusOf(await classify(ctx));
  } catch (error) {
    ctx.logger?.warn?.(`archive-purge: the post-purge count failed: ${messageOf(error)}`);
  }

  return {
    scope,
    deleted,
    released,
    bytesFreed,
    skipped,
    remaining,
  };
}

/**
 * Mount the two maintenance routes. They appear only where a Web server and
 * its connection trust layer exist; the counts stay available to the page.
 */
export function apply(ctx) {
  let purging = false;

  ctx.inject(['webServer', 'connection'], (routeCtx) => {
    const statusHandler = async (req, res) => {
      const method = req.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      try {
        sendJson(res, 200, { ok: true, status: statusOf(await classify(ctx)) }, method === 'HEAD');
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: { code: 'status-failed', message: messageOf(error) },
        });
      }
    };

    const purgeHandler = async (req, res) => {
      const method = req.method ?? 'GET';
      if (method !== 'POST') {
        res.writeHead(405, { allow: 'POST' });
        res.end();
        return;
      }
      if (req.headers[PURGE_HEADER] !== PURGE_HEADER_VALUE) {
        sendJson(res, 400, {
          ok: false,
          error: {
            code: 'confirmation-required',
            message: `Missing the ${PURGE_HEADER}: ${PURGE_HEADER_VALUE} header.`,
          },
        });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: { code: 'invalid-body', message: messageOf(error) },
        });
        return;
      }
      const scope = body?.scope;
      if (body?.confirm !== 'purge' || (scope !== 'all' && scope !== 'older')) {
        sendJson(res, 400, {
          ok: false,
          error: {
            code: 'confirmation-required',
            message: 'Send {"confirm":"purge","scope":"all"|"older"} to delete archived session logs.',
          },
        });
        return;
      }

      if (purging) {
        sendJson(res, 409, {
          ok: false,
          error: { code: 'busy', message: 'A purge is already running.' },
        });
        return;
      }
      purging = true;
      try {
        sendJson(res, 200, { ok: true, result: await runPurge(ctx, scope) });
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: { code: 'purge-failed', message: messageOf(error) },
        });
      } finally {
        purging = false;
      }
    };

    routeCtx.effect(
      () =>
        routeCtx.webServer.register({
          kind: 'exact',
          path: STATUS_PATH,
          auth: 'required',
          handler: statusHandler,
        }),
      'archive-purge: status route'
    );
    routeCtx.effect(
      () =>
        routeCtx.webServer.register({
          kind: 'exact',
          path: PURGE_PATH,
          auth: 'required',
          handler: purgeHandler,
        }),
      'archive-purge: purge route'
    );
  });
}
