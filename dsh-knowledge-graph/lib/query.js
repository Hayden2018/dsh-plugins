/**
 * Declarative subgraph filtering.
 *
 * `kg_search` looks at one entity's own text and metadata; `kg_draw_graph` walks
 * blind from one root. This module fills the gap in between: entities that
 * match their own attributes *and* have at least one incident edge meeting a
 * caller-supplied constraint, with optional one-step record hydration.
 */

import { excerpt, matchNode, sortHits } from './search.js';
import { normalizeText } from './validate.js';

/**
 * Incident edges of one node in the requested direction.
 * @param store - graph store.
 * @param id - node id.
 * @param direction - `outgoing`, `incoming`, or `both`.
 * @returns entries carrying the edge and the other endpoint.
 */
function incidentEdges(store, id, direction) {
  const entries = [];
  if (direction !== 'incoming') {
    for (const edge of store.outgoing(id).values()) entries.push({ edge, otherId: edge.to_id });
  }
  if (direction !== 'outgoing') {
    for (const edge of store.incoming(id).values()) entries.push({ edge, otherId: edge.from_id });
  }
  return entries;
}

/**
 * Whether one node has an incident edge satisfying every constraint.
 * @param store - graph store.
 * @param id - node id.
 * @param filter - normalized edge filter.
 * @returns whether at least one edge matched.
 */
function hasMatchingEdge(store, id, filter) {
  const relationSet = filter.relations === undefined ? undefined : new Set(filter.relations);
  const neighborSet = filter.neighborIds === undefined ? undefined : new Set(filter.neighborIds);
  for (const entry of incidentEdges(store, id, filter.direction)) {
    if (relationSet !== undefined && !relationSet.has(entry.edge.relation)) continue;
    if (neighborSet !== undefined && !neighborSet.has(entry.otherId)) continue;
    if (filter.neighborTypes !== undefined || filter.neighborTagsAny !== undefined) {
      const neighbor = store.nodes.get(entry.otherId);
      if (neighbor === undefined) continue;
      if (filter.neighborTypes !== undefined && !filter.neighborTypes.includes(neighbor.type)) continue;
      if (
        filter.neighborTagsAny !== undefined &&
        !filter.neighborTagsAny.some((tag) => neighbor._tags.includes(tag))
      )
        continue;
    }
    return true;
  }
  return false;
}

/**
 * Filter entities by their own attributes and by incident edges.
 * @param store - graph store.
 * @param args - validated arguments.
 * @param args.query - optional free text.
 * @param args.types - optional type filter.
 * @param args.tagsAll - tags that must all be present.
 * @param args.tagsAny - tags of which at least one must be present.
 * @param args.updatedAfter - optional ISO lower bound.
 * @param args.updatedBefore - optional ISO upper bound.
 * @param args.edgeFilter - optional incident-edge constraint.
 * @param args.includeFullRecords - whether to return hydrated records.
 * @param args.limit - page size.
 * @param args.offset - zero-based page offset.
 * @returns the page, its totals, and the hydrated records when asked.
 */
export function query(
  store,
  {
    query,
    types,
    tagsAll,
    tagsAny,
    updatedAfter,
    updatedBefore,
    edgeFilter,
    includeFullRecords,
    limit,
    offset,
  }
) {
  store.assertReady();
  const text = normalizeText(query);
  const typeSet = types === undefined ? undefined : new Set(types);
  const all = tagsAll ?? [];
  const any = tagsAny ?? [];
  const hits = [];

  for (const node of store.nodes.values()) {
    if (typeSet !== undefined && !typeSet.has(node.type)) continue;
    if (all.length > 0 && !all.every((tag) => node._tags.includes(tag))) continue;
    if (any.length > 0 && !any.some((tag) => node._tags.includes(tag))) continue;
    if (updatedAfter !== undefined && node.updated_at < updatedAfter) continue;
    if (updatedBefore !== undefined && node.updated_at > updatedBefore) continue;
    if (text.length > 0 && matchNode(node, text) === null) continue;
    if (edgeFilter !== undefined && !hasMatchingEdge(store, node.id, edgeFilter)) continue;
    hits.push({ node, rank: 0, field: 'recent', kind: 'recent' });
  }

  sortHits(hits, 'updated_at', store);
  const total = hits.length;
  const page = hits.slice(offset, offset + limit);
  const records = includeFullRecords
    ? store.get({
        ids: page.map((hit) => hit.node.id),
        includeEdges: true,
        direction: 'both',
        edgeLimit: 50,
      }).nodes
    : [];

  return {
    count: page.length,
    total,
    truncated: total > offset + page.length,
    offset,
    results: includeFullRecords
      ? []
      : page.map((hit) => ({
          id: hit.node.id,
          name: hit.node.name,
          type: hit.node.type,
          tags: [...hit.node.tags],
          excerpt: excerpt(hit.node.description),
          updated_at: hit.node.updated_at,
          revision: hit.node.revision,
        })),
    nodes: records,
  };
}
