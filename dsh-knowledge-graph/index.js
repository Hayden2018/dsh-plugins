/**
 * Knowledge Graph Host half.
 *
 * Owns one installation-wide SQLite graph (`node`, `edge`, and the `history`
 * changelog) under `<DSH_HOME>/knowledge-graph`, keeps it in memory for reads,
 * and registers ten model-facing tools. Every profile shares the database; the
 * store reloads when another profile commits. Authenticated Web routes back the
 * visualization's entity/relation inspectors, plus the storage status and
 * explicit purge action in the maintenance panel.
 */

import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { migrateLegacyGraph } from './lib/migrate.js';
import { GraphStore } from './lib/store.js';
import { createTools } from './lib/tools.js';
import { GraphError } from './lib/types.js';

export const name = 'knowledge-graph';

/** The tool registry is the reason this plugin exists. */
export const inject = ['tools'];

export const Config = z.object({
  /**
   * Directory holding `graph.sqlite`. Empty means
   * `<DSH_HOME>/knowledge-graph`, shared by every profile, or
   * `$DSH_KNOWLEDGE_GRAPH_DIR` when set.
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
  /** Entities one Web graph snapshot may include, highest degree first. */
  maxGraphNodes: z.number().min(1).max(10_000).default(2_000),
  /** Relations one Web graph snapshot may include. */
  maxGraphEdges: z.number().min(1).max(50_000).default(8_000),
});

/** Path of the maintenance endpoint used by the Web panel. */
const ADMIN_PATH = '/knowledge-graph/admin';
/** Path of the graph snapshot read by the right-Sidebar visualization. */
const GRAPH_PATH = '/knowledge-graph/graph';
/** Path of one entity's full record, read by the visualization's inspector. */
const NODE_PATH = '/knowledge-graph/node';
/** Path of one relation's full record and mutation actions. */
const EDGE_PATH = '/knowledge-graph/edge';
const MAX_BODY_BYTES = 8_192;
/** Edge description preview carried by the graph snapshot. */
const MAX_EDGE_PREVIEW = 600;
/** Characters of a node description returned to the inspector. */
const MAX_NODE_PREVIEW = 40_000;
/** Characters of one edge description returned to the inspector. */
const MAX_EDGE_DETAIL = 20_000;
/** Body bound for one node edit; descriptions are the large field. */
const NODE_BODY_BYTES = 262_144;
/** Body bound for one relation mutation; descriptions are the large field. */
const EDGE_BODY_BYTES = 262_144;
/** The only fields the Web editor may change. */
const EDITABLE_NODE_FIELDS = new Set(['name', 'type', 'tags', 'description']);
/** Relation labels accepted by the Web editor, matching the store's validator. */
const RELATION_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/;

/**
 * Resolve the installation-wide harness home.
 * @param ctx - host plugin context.
 * @returns an absolute home directory.
 */
function resolveHome(ctx) {
  const homePath = ctx.get('dshHomePath');
  if (typeof homePath === 'function') {
    try {
      const home = homePath();
      if (typeof home === 'string' && home.length > 0) return home;
    } catch {
      // Fall through to the environment/default resolution.
    }
  }
  const configured = (process.env.DSH_HOME ?? '').trim();
  return configured.length > 0 ? resolve(configured) : join(homedir(), '.dsh');
}

/**
 * Resolve the directory this plugin owns.
 * @param ctx - host plugin context.
 * @param config - resolved plugin Config.
 * @returns the directory, its source, and the home used for the default.
 */
function resolveDataDir(ctx, config) {
  const profile = ctx.get('profileContext')?.dir;
  const base = typeof profile === 'string' && profile.length > 0 ? profile : process.cwd();
  const configured = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  if (configured.length > 0) {
    return {
      dir: isAbsolute(configured) ? configured : resolve(base, configured),
      source: 'config',
      home: null,
    };
  }
  const fromEnv = (process.env.DSH_KNOWLEDGE_GRAPH_DIR ?? '').trim();
  if (fromEnv.length > 0) {
    return { dir: isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv), source: 'env', home: null };
  }
  const home = resolveHome(ctx);
  return { dir: join(home, 'knowledge-graph'), source: 'default', home };
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

/** HTTP status for one graph mutation failure. */
function errorStatus(error) {
  switch (error?.code) {
    case 'invalid_args':
    case 'bad_request':
    case 'confirmation_required':
    case 'invalid_relation':
    case 'invalid_type':
      return 400;
    case 'not_found':
      return 404;
    case 'revision_conflict':
    case 'already_exists':
    case 'has_edges':
    case 'duplicate_ref':
    case 'unknown_ref':
    case 'ambiguous_edge':
      return 409;
    case 'storage_busy':
      return 503;
    default:
      return 500;
  }
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

/** Clip one string for a compact Web preview. */
function clip(text, max) {
  if (typeof text !== 'string' || text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Build the compact graph the right-Sidebar canvas renders. Nodes are ordered
 * by degree so a capped snapshot keeps the structural hubs; edges survive only
 * when both endpoints do. Descriptions are previews here; the inspector reads
 * one entity's full record from the node endpoint.
 * @param store - the live graph store.
 * @param limits - configured graph caps.
 * @returns the snapshot and its cap facts.
 */
function graphSnapshot(store, limits) {
  store.assertReady();
  const allNodes = [];
  for (const node of store.nodes.values()) {
    const degree = store.degreeOf(node.id);
    allNodes.push({
      id: node.id,
      name: node.name,
      type: node.type,
      tags: [...node.tags],
      in: degree.in,
      out: degree.out,
      degree: degree.in + degree.out,
      updated_at: node.updated_at,
    });
  }
  allNodes.sort(
    (left, right) =>
      right.degree - left.degree ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id)
  );
  const nodes = allNodes.slice(0, limits.maxGraphNodes);
  const keep = new Set(nodes.map((node) => node.id));
  // Cytoscape requires unique ids across nodes and edges. Node ids are
  // user-chosen slugs, so pick an edge prefix that no kept node id starts with
  // rather than assuming `e0` is free.
  let edgePrefix = '__kg_edge__';
  while (nodes.some((node) => node.id.startsWith(edgePrefix))) edgePrefix = `_${edgePrefix}`;
  const allEdges = store.allEdges();
  const edges = [];
  for (const edge of allEdges) {
    if (!keep.has(edge.from_id) || !keep.has(edge.to_id)) continue;
    if (edges.length >= limits.maxGraphEdges) break;
    edges.push({
      id: `${edgePrefix}${edges.length}`,
      source: edge.from_id,
      target: edge.to_id,
      relation: edge.relation,
      description: clip(edge.description, MAX_EDGE_PREVIEW),
    });
  }
  return {
    nodes,
    edges,
    totals: { nodes: allNodes.length, edges: allEdges.length },
    truncated: nodes.length < allNodes.length || edges.length < allEdges.length,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Build one entity's inspector record: the full stored description, tags,
 * attachments, both edge directions, and degree.
 * @param store - the live graph store.
 * @param id - exact entity id.
 * @returns the record, or undefined when the entity does not exist.
 */
function nodeSnapshot(store, id) {
  const { nodes } = store.get({
    ids: [id],
    includeEdges: true,
    direction: 'both',
    edgeLimit: 200,
  });
  const node = nodes[0];
  if (node === undefined) return undefined;
  const degree = store.degreeOf(id);
  const edgeView = (edge) => ({
    ...edge,
    description: clip(edge.description, MAX_EDGE_DETAIL),
  });
  return {
    ...node,
    description: clip(node.description, MAX_NODE_PREVIEW),
    tags: [...node.tags],
    attachments: [...node.attachments],
    in: degree.in,
    out: degree.out,
    degree: degree.in + degree.out,
    edges: {
      outgoing: node.edges.outgoing.map(edgeView),
      incoming: node.edges.incoming.map(edgeView),
      truncated: node.edges.truncated,
    },
  };
}

/**
 * Build one relation's full inspector record. The graph snapshot carries only
 * a description preview and no revision, so the relation editor reads this
 * endpoint before it can safely update or delete the edge.
 * @param store - the live graph store.
 * @param fromId - source entity id.
 * @param relation - exact relation label.
 * @param toId - target entity id.
 * @returns the edge record with endpoint summaries, or undefined.
 */
function edgeSnapshot(store, fromId, relation, toId) {
  store.assertReady();
  const edge = store.edgeOf(fromId, relation, toId);
  if (edge === undefined) return undefined;
  const endpoint = (id) => {
    const node = store.nodes.get(id);
    return node === undefined
      ? { id, name: id, type: 'other' }
      : { id: node.id, name: node.name, type: node.type };
  };
  return {
    ...edge,
    description: clip(edge.description, MAX_EDGE_DETAIL),
    from: endpoint(fromId),
    to: endpoint(toId),
  };
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
    () => routeCtx.webServer.register({ kind: 'exact', path: ADMIN_PATH, auth: 'required', handler }),
    'knowledge-graph: admin route'
  );
}

/**
 * Serve the compact graph snapshot, entity and relation inspector records, and
 * their user edit actions to the right-Sidebar visualization. The routes require
 * an admitted Peer; mutations additionally require a JSON body and an
 * `x-dsh-kg-action` header.
 * @param routeCtx - context carrying `webServer` and `connection`.
 * @param store - the live graph store.
 * @param limits - configured graph caps.
 */
function registerGraphRoutes(routeCtx, store, limits) {
  const graphHandler = async (req, res) => {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    try {
      sendJson(res, 200, { ok: true, graph: graphSnapshot(store, limits) }, method === 'HEAD');
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errorView(error) }, method === 'HEAD');
    }
  };

  /** Create, update, or delete one entity from the Web inspector. */
  const mutateNode = async (req, res) => {
    const action = req.headers['x-dsh-kg-action'];
    if (action !== 'create' && action !== 'update' && action !== 'delete') {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'bad_request',
          message: 'Use `x-dsh-kg-action: create`, `update`, or `delete`.',
        },
      });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, NODE_BODY_BYTES);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorView(error) });
      return;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'invalid_args', message: 'Request body must be a JSON object.' },
      });
      return;
    }
    const rawSession = req.headers['x-dsh-kg-session'];
    const sessionId =
      (Array.isArray(rawSession) ? rawSession[0] : rawSession ?? '').trim().slice(0, 200) || 'web-ui';
    try {
      if (action === 'create') {
        const unknown = Object.keys(body).filter((key) => !EDITABLE_NODE_FIELDS.has(key));
        if (unknown.length > 0) {
          throw new GraphError(
            'invalid_args',
            `Only name, type, tags, and description may be set (got ${unknown.join(', ')}).`
          );
        }
        if (body.name === undefined || body.type === undefined) {
          throw new GraphError('invalid_args', 'A new entity requires `name` and `type`.');
        }
        const report = store.save(
          {
            nodes: {
              create: [
                {
                  name: body.name,
                  type: body.type,
                  tags: body.tags,
                  description: body.description,
                },
              ],
            },
          },
          { sessionId, cwd: process.cwd() }
        );
        const id = report.nodes.created[0]?.id;
        if (id === undefined) {
          throw new GraphError('write_failed', 'The graph did not report the created entity.');
        }
        const node = nodeSnapshot(store, id);
        if (node === undefined) {
          throw new GraphError('write_failed', `Entity ${id} was committed but could not be read.`);
        }
        sendJson(res, 200, { ok: true, node });
        return;
      }

      const id = typeof body.id === 'string' ? body.id.trim() : '';
      if (id.length === 0) {
        throw new GraphError('invalid_args', '`id` must be a non-empty entity id.');
      }
      const expected = body.expected_revision;
      if (!Number.isInteger(expected) || expected < 1) {
        throw new GraphError('invalid_args', '`expected_revision` must be a positive integer.');
      }

      if (action === 'delete') {
        if (body.cascade_edges !== undefined && typeof body.cascade_edges !== 'boolean') {
          throw new GraphError('invalid_args', '`cascade_edges` must be a boolean.');
        }
        const report = store.remove(
          {
            nodes: [{ id, expected_revision: expected }],
            cascade_edges: body.cascade_edges === true,
          },
          { sessionId }
        );
        sendJson(res, 200, { ok: true, deleted: report.deleted });
        return;
      }

      const patch = body.patch;
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new GraphError('invalid_args', '`patch` must be a JSON object.');
      }
      const keys = Object.keys(patch);
      if (keys.length === 0) {
        throw new GraphError(
          'invalid_args',
          'Provide at least one of `name`, `type`, `tags`, or `description`.'
        );
      }
      const unknown = keys.filter((key) => !EDITABLE_NODE_FIELDS.has(key));
      if (unknown.length > 0) {
        throw new GraphError(
          'invalid_args',
          `Only name, type, tags, and description may be edited (got ${unknown.join(', ')}).`
        );
      }
      store.save(
        { nodes: { update: [{ id, expected_revision: expected, ...patch }] } },
        { sessionId, cwd: process.cwd() }
      );
      const node = nodeSnapshot(store, id);
      if (node === undefined) {
        throw new GraphError('not_found', `Entity ${id} does not exist.`);
      }
      sendJson(res, 200, { ok: true, node });
    } catch (error) {
      sendJson(res, errorStatus(error), { ok: false, error: errorView(error) });
    }
  };

  const nodeHandler = async (req, res) => {
    const method = req.method ?? 'GET';
    if (method === 'POST') {
      await mutateNode(req, res);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' });
      res.end();
      return;
    }
    let id;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      id = (url.searchParams.get('id') ?? '').trim();
    } catch {
      id = '';
    }
    if (id.length === 0) {
      sendJson(
        res,
        400,
        { ok: false, error: { code: 'invalid_args', message: 'Pass `?id=<entity id>`.' } },
        method === 'HEAD'
      );
      return;
    }
    try {
      const node = nodeSnapshot(store, id);
      if (node === undefined) {
        sendJson(
          res,
          404,
          { ok: false, error: { code: 'not_found', message: `Entity ${id} does not exist.` } },
          method === 'HEAD'
        );
        return;
      }
      sendJson(res, 200, { ok: true, node }, method === 'HEAD');
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errorView(error) }, method === 'HEAD');
    }
  };

  /** Read one required trimmed string from a mutation body. */
  const bodyText = (value, label) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new GraphError('invalid_args', `\`${label}\` must be a non-empty string.`);
    }
    return value.trim();
  };

  /** Read one required relation label, with the store's accepted syntax. */
  const bodyRelation = (value, label) => {
    const relation = bodyText(value, label);
    if (!RELATION_PATTERN.test(relation)) {
      throw new GraphError(
        'invalid_relation',
        '`relation` must be a lowercase snake_case label such as `works_for` (letters, digits, `_`, `:`, `-`).'
      );
    }
    return relation;
  };

  /** Read one optional string, preserving its whitespace. */
  const optionalText = (value, label) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') {
      throw new GraphError('invalid_args', `\`${label}\` must be a string.`);
    }
    return value;
  };

  /** Read the required optimistic-lock revision. */
  const bodyRevision = (value) => {
    if (!Number.isInteger(value) || value < 1) {
      throw new GraphError('invalid_args', '`expected_revision` must be a positive integer.');
    }
    return value;
  };

  /** Resolve the changelog writer, falling back to the Web UI when no session is passed. */
  const sessionOf = (req) => {
    const raw = req.headers['x-dsh-kg-session'];
    return (Array.isArray(raw) ? raw[0] : raw ?? '').trim().slice(0, 200) || 'web-ui';
  };

  /** Read one edge's full record for the relation inspector. */
  const readEdge = async (req, res, method) => {
    let fromId;
    let relation;
    let toId;
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      fromId = (url.searchParams.get('from_id') ?? '').trim();
      relation = (url.searchParams.get('relation') ?? '').trim();
      toId = (url.searchParams.get('to_id') ?? '').trim();
    } catch {
      fromId = '';
      relation = '';
      toId = '';
    }
    if (fromId.length === 0 || relation.length === 0 || toId.length === 0) {
      sendJson(
        res,
        400,
        {
          ok: false,
          error: {
            code: 'invalid_args',
            message: 'Pass `?from_id=<id>&relation=<label>&to_id=<id>`.',
          },
        },
        method === 'HEAD'
      );
      return;
    }
    try {
      const edge = edgeSnapshot(store, fromId, relation, toId);
      if (edge === undefined) {
        sendJson(
          res,
          404,
          {
            ok: false,
            error: {
              code: 'not_found',
              message: `Relation ${fromId} —${relation}→ ${toId} does not exist.`,
            },
          },
          method === 'HEAD'
        );
        return;
      }
      sendJson(res, 200, { ok: true, edge }, method === 'HEAD');
    } catch (error) {
      sendJson(res, errorStatus(error), { ok: false, error: errorView(error) }, method === 'HEAD');
    }
  };

  /** Create, rename, or delete one relation from the Web inspector. */
  const mutateEdge = async (req, res) => {
    const action = req.headers['x-dsh-kg-action'];
    if (action !== 'create' && action !== 'update' && action !== 'delete') {
      sendJson(res, 400, {
        ok: false,
        error: {
          code: 'bad_request',
          message: 'Use `x-dsh-kg-action: create`, `update`, or `delete`.',
        },
      });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req, EDGE_BODY_BYTES);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorView(error) });
      return;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, {
        ok: false,
        error: { code: 'invalid_args', message: 'Request body must be a JSON object.' },
      });
      return;
    }
    const sessionId = sessionOf(req);
    try {
      const fromId = bodyText(body.from_id, 'from_id');
      const toId = bodyText(body.to_id, 'to_id');
      const relation = bodyRelation(body.relation, 'relation');

      if (action === 'create') {
        const description = optionalText(body.description, 'description') ?? '';
        store.save(
          { edges: { create: [{ from_id: fromId, to_id: toId, relation, description }] } },
          { sessionId, cwd: process.cwd() }
        );
        const edge = edgeSnapshot(store, fromId, relation, toId);
        sendJson(res, 200, { ok: true, edge });
        return;
      }

      const expected = bodyRevision(body.expected_revision);

      if (action === 'delete') {
        store.remove(
          { edges: [{ from_id: fromId, to_id: toId, relation, expected_revision: expected }] },
          { sessionId }
        );
        sendJson(res, 200, {
          ok: true,
          deleted: { from_id: fromId, relation, to_id: toId },
        });
        return;
      }

      const hasRelation = Object.prototype.hasOwnProperty.call(body, 'new_relation');
      const hasDescription = Object.prototype.hasOwnProperty.call(body, 'description');
      if (!hasRelation && !hasDescription) {
        throw new GraphError(
          'invalid_args',
          'Provide `new_relation`, `description`, or both to update a relation.'
        );
      }
      const newRelation = hasRelation ? bodyRelation(body.new_relation, 'new_relation') : undefined;
      const description = hasDescription
        ? optionalText(body.description, 'description')
        : undefined;

      store.assertReady();
      const current = store.edgeOf(fromId, relation, toId);
      if (current === undefined) {
        throw new GraphError(
          'not_found',
          `Relation ${fromId} —${relation}→ ${toId} does not exist; refresh the graph.`
        );
      }
      // UI-only overwrite guard. The model-facing kg_save path deliberately keeps
      // its existing behavior; this route refuses a rename that would replace a
      // different relation already stored on the same directed pair. A stale
      // revision is left to save() so it still reports revision_conflict.
      if (
        current.revision === expected &&
        newRelation !== undefined &&
        newRelation !== relation &&
        store.edgeOf(fromId, newRelation, toId) !== undefined
      ) {
        throw new GraphError(
          'already_exists',
          `Relation ${fromId} —${newRelation}→ ${toId} already exists; choose another label.`
        );
      }

      const update = {
        from_id: fromId,
        to_id: toId,
        relation,
        expected_revision: expected,
      };
      if (newRelation !== undefined) update.new_relation = newRelation;
      if (description !== undefined) update.description = description;
      store.save({ edges: { update: [update] } }, { sessionId, cwd: process.cwd() });

      const edge = edgeSnapshot(store, fromId, newRelation ?? relation, toId);
      sendJson(res, 200, { ok: true, edge });
    } catch (error) {
      sendJson(res, errorStatus(error), { ok: false, error: errorView(error) });
    }
  };

  const edgeHandler = async (req, res) => {
    const method = req.method ?? 'GET';
    if (method === 'POST') {
      await mutateEdge(req, res);
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' });
      res.end();
      return;
    }
    await readEdge(req, res, method);
  };

  routeCtx.effect(
    () => routeCtx.webServer.register({ kind: 'exact', path: GRAPH_PATH, auth: 'required', handler: graphHandler }),
    'knowledge-graph: graph route'
  );
  routeCtx.effect(
    () => routeCtx.webServer.register({ kind: 'exact', path: NODE_PATH, auth: 'required', handler: nodeHandler }),
    'knowledge-graph: node route'
  );
  routeCtx.effect(
    () => routeCtx.webServer.register({ kind: 'exact', path: EDGE_PATH, auth: 'required', handler: edgeHandler }),
    'knowledge-graph: edge route'
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
    maxGraphNodes: limit(config?.maxGraphNodes, 2_000, 1, 10_000),
    maxGraphEdges: limit(config?.maxGraphEdges, 8_000, 1, 50_000),
  };
  const location = resolveDataDir(ctx, config);
  if (location.source === 'default') {
    try {
      migrateLegacyGraph({
        dataDir: location.dir,
        home: location.home,
        profileDir: ctx.get('profileContext')?.dir,
        logger: ctx.logger,
      });
    } catch (error) {
      ctx.logger?.warn?.(`knowledge-graph: legacy data migration failed: ${error.message}`);
    }
  }
  const store = new GraphStore({ dataDir: location.dir, limits });

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
    registerGraphRoutes(routeCtx, store, limits);
  });
}
