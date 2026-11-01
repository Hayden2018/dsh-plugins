/**
 * Bounded graph traversal and text rendering.
 *
 * `draw` renders a hop-bounded neighborhood as a tree-like text view; `trace`
 * finds one shortest connection between two nodes. Both walk the in-memory
 * adjacency indexes, so neither touches SQLite.
 */

import { GraphError, MAX_DRAW_HOPS } from './types.js';
import { edgeKey, publicEdge } from './store.js';

/** Distinct nodes one drawing may discover. */
const DRAW_SCAN_LIMIT = 50_000;
/** Nodes one trace may visit. */
const TRACE_NODE_LIMIT = 10_000;
/** Edge examinations one trace may perform. */
const TRACE_SCAN_LIMIT = 50_000;
/** Wall-clock budget for one trace, in milliseconds. */
const TRACE_TIME_BUDGET_MS = 2_500;

/**
 * Escape text for the tree view: names must stay on one line.
 * @param text - raw name.
 * @returns single-line text.
 */
function escapeName(text) {
  return String(text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
}

/**
 * Collapse text for an inline branch annotation.
 * @param text - raw text.
 * @param length - maximum length.
 * @returns single-line text.
 */
function oneLine(text, length) {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

/**
 * All relations incident to one node, in a stable order and deduplicated so a
 * self-loop appears once.
 * @param store - graph store.
 * @param id - node id.
 * @param direction - which sides to walk.
 * @param relations - optional relation allowlist.
 * @param excludeRelations - optional relation denylist.
 * @returns neighbor entries.
 */
export function neighbors(store, id, direction, relations, excludeRelations) {
  const relationSet = relations === undefined || relations.length === 0 ? undefined : new Set(relations);
  const excluded =
    excludeRelations === undefined || excludeRelations.length === 0 ? undefined : new Set(excludeRelations);
  const list = [];
  const seen = new Set();
  const push = (edge, otherId, traversal) => {
    if (relationSet !== undefined && !relationSet.has(edge.relation)) return;
    if (excluded !== undefined && excluded.has(edge.relation)) return;
    const key = edgeKey(edge);
    if (seen.has(key)) return;
    seen.add(key);
    const other = store.nodes.get(otherId);
    list.push({
      edge,
      otherId,
      traversal,
      sortName: other === undefined ? '' : other.name.toLowerCase(),
    });
  };
  if (direction !== 'incoming') {
    for (const edge of store.outgoing(id).values()) push(edge, edge.to_id, 'forward');
  }
  if (direction !== 'outgoing') {
    for (const edge of store.incoming(id).values()) push(edge, edge.from_id, 'backward');
  }
  list.sort((left, right) => {
    if (left.sortName !== right.sortName) return left.sortName < right.sortName ? -1 : 1;
    if (left.edge.relation !== right.edge.relation) return left.edge.relation < right.edge.relation ? -1 : 1;
    return edgeKey(left.edge) < edgeKey(right.edge) ? -1 : 1;
  });
  for (const entry of list) delete entry.sortName;
  return list;
}

/**
 * Render a hop-bounded neighborhood of one node.
 * @param store - graph store.
 * @param options - validated arguments.
 * @param options.rootId - node to center on.
 * @param options.hops - 0..3 edges from the root.
 * @param options.direction - which sides to walk.
 * @param options.relations - optional relation allowlist.
 * @param options.excludeRelations - optional relation denylist.
 * @param options.maxNodes - cap on distinct nodes.
 * @param options.maxNeighbors - cap on edges expanded per node.
 * @param options.includeEdgeDescriptions - annotate branches with edge text.
 * @param options.maxChars - cap on tree characters.
 * @param options.maxEdges - cap on rendered links.
 * @returns the tree text, the alias table, and truncation facts.
 */
export function draw(store, options) {
  store.assertReady();
  const {
    rootId,
    direction,
    relations,
    excludeRelations,
    maxNodes,
    maxNeighbors,
    includeEdgeDescriptions,
    maxChars,
    maxEdges,
  } = options;
  const hops = Math.max(0, Math.min(MAX_DRAW_HOPS, Math.trunc(options.hops)));
  const root = store.nodes.get(rootId);
  if (root === undefined) throw new GraphError('not_found', `Node ${rootId} does not exist.`);
  const reasons = new Set();
  let truncated = false;

  const dist = new Map([[rootId, 0]]);
  const parent = new Map();
  const order = [rootId];
  const childrenOf = new Map();
  const queue = [rootId];
  let scans = 0;

  while (queue.length > 0) {
    const id = queue.shift();
    const depthHere = dist.get(id) ?? 0;
    if (depthHere >= hops) continue;
    const incident = neighbors(store, id, direction, relations, excludeRelations);
    if (incident.length > maxNeighbors) {
      truncated = true;
      reasons.add('neighbor_limit');
    }
    let stop = false;
    for (const entry of incident.slice(0, maxNeighbors)) {
      scans += 1;
      if (scans > DRAW_SCAN_LIMIT) {
        truncated = true;
        reasons.add('scan_limit');
        stop = true;
        break;
      }
      if (dist.has(entry.otherId)) continue;
      if (dist.size >= maxNodes) {
        truncated = true;
        reasons.add('node_limit');
        stop = true;
        break;
      }
      dist.set(entry.otherId, depthHere + 1);
      parent.set(entry.otherId, { parentId: id, edge: entry.edge, traversal: entry.traversal });
      order.push(entry.otherId);
      queue.push(entry.otherId);
      if (!childrenOf.has(id)) childrenOf.set(id, []);
      childrenOf.get(id).push({ id: entry.otherId, edge: entry.edge, traversal: entry.traversal });
    }
    if (stop) break;
  }

  const aliases = new Map();
  const aliasOrder = [];
  const aliasOf = (id) => {
    let value = aliases.get(id);
    if (value === undefined) {
      value = `n${aliases.size + 1}`;
      aliases.set(id, value);
      aliasOrder.push(id);
    }
    return value;
  };

  const lines = [];
  let chars = 0;
  let edgesRendered = 0;
  let stopped = false;

  const pushLine = (line) => {
    if (stopped) return false;
    if (chars + line.length + 1 > maxChars) {
      truncated = true;
      reasons.add('char_limit');
      stopped = true;
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };

  /** Whether `candidateId` is an ancestor of `nodeId` in the rendered tree. */
  const isAncestor = (candidateId, nodeId) => {
    let cursor = nodeId;
    let guard = 0;
    while (parent.has(cursor) && guard < 64) {
      cursor = parent.get(cursor).parentId;
      if (cursor === candidateId) return true;
      guard += 1;
    }
    return false;
  };

  const renderChildren = (nodeId, prefix) => {
    if (stopped) return;
    const entries = [];
    const seenEdges = new Set();
    const depthHere = dist.get(nodeId) ?? 0;
    if (depthHere < hops) {
      for (const child of childrenOf.get(nodeId) ?? []) {
        entries.push({ kind: 'child', id: child.id, edge: child.edge, traversal: child.traversal });
        seenEdges.add(edgeKey(child.edge));
      }
    }
    const trunk = parent.get(nodeId)?.edge;
    const incident = neighbors(store, nodeId, direction, relations, excludeRelations);
    for (const entry of incident) {
      const key = edgeKey(entry.edge);
      if (seenEdges.has(key)) continue;
      // Undiscovered neighbours stay counted as omitted rather than rendered.
      if (!dist.has(entry.otherId)) continue;
      if (trunk !== undefined && key === edgeKey(trunk)) continue;
      const cycle = entry.otherId === nodeId || isAncestor(entry.otherId, nodeId);
      entries.push({
        kind: cycle ? 'cycle' : 'ref',
        id: entry.otherId,
        edge: entry.edge,
        traversal: entry.traversal,
      });
      seenEdges.add(key);
    }

    const shown = entries.slice(0, maxNeighbors);
    // Every incident relation is either rendered, hidden by the cap, or is the
    // branch that led to this node; count the neighbours the model cannot see.
    const omitted = Math.max(0, incident.length - shown.length - (trunk === undefined ? 0 : 1));
    if (omitted > 0) {
      truncated = true;
      reasons.add('neighbor_limit');
    }

    for (let index = 0; index < shown.length; index += 1) {
      if (stopped) return;
      const entry = shown[index];
      const isLast = index === shown.length - 1 && omitted === 0;
      const branch = isLast ? '└── ' : '├── ';
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      const other = store.nodes.get(entry.id);
      if (other === undefined) continue;
      const arrow = entry.traversal === 'backward' ? '←' : '→';
      const suffix =
        entry.kind === 'cycle'
          ? ' [cycle; not expanded]'
          : entry.kind === 'ref'
            ? ' [ref; not expanded]'
            : '';
      const note =
        includeEdgeDescriptions && entry.edge.description.length > 0
          ? ` — ${oneLine(entry.edge.description, 80)}`
          : '';
      const line = `${prefix}${branch}${entry.edge.relation} ${arrow} ${escapeName(other.name)} [${aliasOf(entry.id)}] ${other.type}${note}${suffix}`;
      if (!pushLine(line)) return;
      edgesRendered += 1;
      if (edgesRendered >= maxEdges) {
        truncated = true;
        reasons.add('edge_limit');
        stopped = true;
        return;
      }
      if (entry.kind === 'child') renderChildren(entry.id, childPrefix);
    }
    if (omitted > 0) pushLine(`${prefix}└── … ${omitted} more neighbor${omitted === 1 ? '' : 's'} omitted`);
  };

  const rootAlias = aliasOf(rootId);
  const rootTags = root.tags.length > 0 ? ` · ${root.tags.map(escapeName).join(', ')}` : '';
  pushLine(`${escapeName(root.name)} [${rootAlias}] ${root.type}${rootTags}`);
  renderChildren(rootId, '');

  const nodes = aliasOrder.map((id) => {
    const node = store.nodes.get(id);
    return {
      alias: aliases.get(id),
      id,
      name: node === undefined ? '' : node.name,
      type: node === undefined ? 'other' : node.type,
    };
  });

  return {
    root: { id: root.id, name: root.name, type: root.type },
    hops,
    direction,
    truncated,
    reasons: [...reasons].sort(),
    nodes,
    text: lines.join('\n'),
  };
}

/**
 * Find one shortest connection between two nodes.
 * @param store - graph store.
 * @param options - validated arguments.
 * @param options.fromId - start node.
 * @param options.toId - target node.
 * @param options.direction - which sides to walk.
 * @param options.maxHops - search depth bound.
 * @param options.relations - optional relation allowlist.
 * @returns the status, the path when found, and the search facts.
 */
export function trace(store, options) {
  store.assertReady();
  const { fromId, toId, direction, relations, maxHops } = options;
  if (!store.nodes.has(fromId)) throw new GraphError('not_found', `Node ${fromId} does not exist.`);
  if (!store.nodes.has(toId)) throw new GraphError('not_found', `Node ${toId} does not exist.`);
  const directed = direction !== 'both';

  if (fromId === toId) {
    return {
      status: 'found',
      directed,
      hops: 0,
      examined: 0,
      path: { nodes: [summaryOf(store, fromId)], edges: [] },
    };
  }

  const dist = new Map([[fromId, 0]]);
  const parent = new Map();
  const queue = [fromId];
  const started = Date.now();
  let examined = 0;
  let limited = false;
  let found = false;
  let frontierOpen = false;

  while (queue.length > 0) {
    if (Date.now() - started > TRACE_TIME_BUDGET_MS) {
      limited = true;
      break;
    }
    const id = queue.shift();
    const depthHere = dist.get(id) ?? 0;
    const incident = neighbors(store, id, direction, relations);
    if (depthHere >= maxHops) {
      if (incident.some((entry) => !dist.has(entry.otherId))) frontierOpen = true;
      continue;
    }
    for (const entry of incident) {
      examined += 1;
      if (examined > TRACE_SCAN_LIMIT) {
        limited = true;
        break;
      }
      if (dist.has(entry.otherId)) continue;
      dist.set(entry.otherId, depthHere + 1);
      parent.set(entry.otherId, { parentId: id, edge: entry.edge, traversal: entry.traversal });
      if (entry.otherId === toId) {
        found = true;
        break;
      }
      if (dist.size > TRACE_NODE_LIMIT) {
        limited = true;
        break;
      }
      queue.push(entry.otherId);
    }
    if (found || limited) break;
  }

  if (found) {
    const nodeIds = [];
    const edges = [];
    let cursor = toId;
    let guard = 0;
    while (cursor !== fromId && guard < TRACE_NODE_LIMIT) {
      const step = parent.get(cursor);
      if (step === undefined) break;
      nodeIds.push(cursor);
      edges.push({ ...publicEdge(step.edge), traversal: step.traversal });
      cursor = step.parentId;
      guard += 1;
    }
    nodeIds.push(fromId);
    nodeIds.reverse();
    edges.reverse();
    return {
      status: 'found',
      directed,
      hops: edges.length,
      examined,
      path: { nodes: nodeIds.map((id) => summaryOf(store, id)), edges },
    };
  }

  let status;
  if (limited) status = 'search_limit_reached';
  else if (frontierOpen) status = 'not_found_within_hops';
  else status = 'no_path';

  return { status, directed, hops: 0, examined, path: { nodes: [], edges: [] } };
}

/**
 * Minimal node identity used in traversal results.
 * @param store - graph store.
 * @param id - node id.
 * @returns the summary, or an empty placeholder for a dangling reference.
 */
function summaryOf(store, id) {
  const node = store.nodes.get(id);
  if (node === undefined) return { id, name: '', type: 'other' };
  return { id: node.id, name: node.name, type: node.type };
}
