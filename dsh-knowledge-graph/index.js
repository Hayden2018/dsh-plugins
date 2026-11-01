/**
 * Knowledge Graph Host half.
 *
 * Owns one profile-local SQLite graph (`node`, `edge`, and the `history`
 * changelog), keeps it in memory for reads, and registers ten model-facing
 * tools. A small authenticated admin route backs the Web panel's storage
 * status and its explicit purge action.
 */

import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { GraphStore } from './lib/store.js';
import { createTools } from './lib/tools.js';
import { GraphError } from './lib/types.js';

export const name = 'knowledge-graph';

/** The tool registry is the reason this plugin exists. */
export const inject = ['tools'];

export const Config = z.object({
  /**
   * Directory holding `graph.sqlite`. Empty means
   * `<profile>/data/dsh-knowledge-graph`, or `$DSH_KNOWLEDGE_GRAPH_DIR` when set.
   */
  dataDir: z.string().default(''),
  /** Hits returned by `kg_search` when the call omits `limit`. */
  maxSearchResults: z.number().min(1).max(100).default(25),
  /** Distinct entities one `kg_draw_graph` may discover. */
  maxDrawNodes: z.number().min(1).max(500).default(100),
  /** Characters of tree text one `kg_draw_graph` may emit. */
  maxDrawChars: z.number().min(1_000).max(200_000).default(16_000),
  /** Characters of hydrated record text one `kg_get` or `kg_query` may emit. */
  maxGetChars: z.number().min(1_000).max(400_000).default(200_000),
  /** Upper bound on `kg_trace_node`'s `max_hops`. */
  maxTraceHops: z.number().min(1).max(50).default(32),
});

/** Path of the maintenance endpoint used by the Web panel. */
const ADMIN_PATH = '/knowledge-graph/admin';
const MAX_BODY_BYTES = 8_192;

/**
 * Resolve the directory this plugin owns.
 * @param ctx - host plugin context.
 * @param config - resolved plugin Config.
 * @returns an absolute directory path.
 */
function resolveDataDir(ctx, config) {
  const profile = ctx.get('profileContext')?.dir;
  const base = typeof profile === 'string' && profile.length > 0 ? profile : process.cwd();
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  if (configured.length > 0) return isAbsolute(configured) ? configured : resolve(base, configured);
  const fromEnv = (process.env.DSH_KNOWLEDGE_GRAPH_DIR ?? '').trim();
  if (fromEnv.length > 0) return isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
  if (typeof profile === 'string' && profile.length > 0) {
    return join(profile, 'data', 'dsh-knowledge-graph');
  }
  const home = (process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh');
  return join(home, 'knowledge-graph');
}

/**
 * Clamp one configured limit.
 * @param value - configured value.
 * @param fallback - value used when the field is missing.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @returns the usable integer.
 */
function limit(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/** One JSON response. */
function sendJson(res, status, value, head = false) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  if (head) res.end();
  else res.end(body);
}

/** Describe an error without exposing a stack. */
function errorView(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'request_failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Read one small JSON request body.
 * @param req - incoming request.
 * @param maxBytes - size bound.
 * @returns the parsed body.
 */
async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new GraphError('invalid_args', 'Request body is too large.');
    chunks.push(buffer);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GraphError('invalid_args', 'Request body must be JSON.');
  }
}

/**
 * Serve storage status and the explicit purge action. Purge is deliberately
 * user-only: no agent tool reaches it, and a cross-origin form cannot send the
 * required header plus JSON body.
 * @param routeCtx - context carrying `webServer` and `connection`.
 * @param store - the live graph store.
 */
function registerAdminRoute(routeCtx, store) {
  const handler = async (req, res) => {
    const method = req.method ?? 'GET';
    let rejection;
    try {
      rejection = routeCtx.connection.requestRejection(req);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errorView(error) }, method === 'HEAD');
      return;
    }
    if (rejection !== undefined) {
      res.writeHead(rejection);
      res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
      return;
    }

    if (method === 'GET' || method === 'HEAD') {
      try {
        sendJson(res, 200, { ok: true, status: store.status() }, method === 'HEAD');
      } catch (error) {
        sendJson(res, 500, { ok: false, error: errorView(error) }, method === 'HEAD');
      }
      return;
    }

    if (method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' });
      res.end();
      return;
    }

    if (req.headers['x-dsh-kg-action'] !== 'purge') {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'bad_request', message: 'Missing the x-dsh-kg-action: purge header.' },
      });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req, MAX_BODY_BYTES);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorView(error) });
      return;
    }
    if (body === null || typeof body !== 'object' || body.confirm !== 'purge') {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'confirmation_required',
          message: 'Send {"confirm":"purge"} to delete all graph data.',
        },
      });
      return;
    }

    try {
      const status = store.purge();
      sendJson(res, 200, { ok: true, purged: true, status });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errorView(error) });
    }
  };

  routeCtx.effect(
    () => routeCtx.webServer.register({ kind: 'exact', path: ADMIN_PATH, handler }),
    'knowledge-graph: admin route'
  );
}

/**
 * Mount the graph store, its tools, and the maintenance route.
 * @param ctx - host plugin context.
 * @param config - resolved plugin Config.
 */
export function apply(ctx, config) {
  const limits = {
    maxSearchResults: limit(config?.maxSearchResults, 25, 1, 100),
    maxDrawNodes: limit(config?.maxDrawNodes, 100, 1, 500),
    maxDrawChars: limit(config?.maxDrawChars, 16_000, 1_000, 200_000),
    maxGetChars: limit(config?.maxGetChars, 200_000, 1_000, 400_000),
    maxTraceHops: limit(config?.maxTraceHops, 32, 1, 50),
  };
  const dataDir = resolveDataDir(ctx, config);
  const store = new GraphStore({ dataDir, limits });

  try {
    store.init();
  } catch (error) {
    // A damaged or foreign database disables the tools with a diagnostic until
    // the user purges it; it is never replaced silently by an empty graph.
    ctx.logger?.warn?.(`knowledge-graph: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const definition of createTools(store, limits)) {
    ctx.effect(() => ctx.tools.register(definition), `knowledge-graph: ${definition.name}`);
  }

  ctx.effect(() => () => store.close(), 'knowledge-graph: sqlite connection');

  ctx.inject(['webServer', 'connection'], (routeCtx) => {
    registerAdminRoute(routeCtx, store);
  });
}
