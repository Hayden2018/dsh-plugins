/**
 * Cold-start graph summary.
 *
 * One call should tell a fresh session which vocabulary the graph actually
 * uses: entity kinds, live tags, relation labels, hub entities, and orphans.
 * Everything is computed from the in-memory indexes, so no SQL runs.
 */

/**
 * Count entries of one key into a map.
 * @param map - counter.
 * @param key - value to count.
 */
function count(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Turn a counter into a descending list of `{ <field>: key, count }`.
 * @param map - counter.
 * @param field - property name for the key.
 * @returns the sorted entries.
 */
function ranked(map, field) {
  return [...map.entries()]
    .map(([key, value]) => ({ [field]: key, count: value }))
    .sort(
      (left, right) => right.count - left.count || String(left[field]).localeCompare(String(right[field]))
    );
}

/**
 * Summarize the whole graph.
 * @param store - graph store.
 * @param args - validated arguments.
 * @param args.topK - how many tags, relations, and hubs to list.
 * @param args.includeOrphans - whether to list orphan ids.
 * @returns the summary value.
 */
export function overview(store, { topK, includeOrphans }) {
  store.assertReady();
  const types = new Map();
  const tags = new Map();
  const relations = new Map();
  const hubs = [];
  const orphans = [];
  let updatedAt = '';

  for (const node of store.nodes.values()) {
    count(types, node.type);
    for (const tag of node.tags) count(tags, tag);
    if (node.updated_at > updatedAt) updatedAt = node.updated_at;
    const degree = store.degreeOf(node.id);
    if (degree.in + degree.out === 0) orphans.push(node.id);
    hubs.push({
      id: node.id,
      name: node.name,
      type: node.type,
      in_degree: degree.in,
      out_degree: degree.out,
    });
  }

  const edges = store.allEdges();
  let edgeUpdatedAt = '';
  for (const edge of edges) {
    count(relations, edge.relation);
    if (edge.updated_at > edgeUpdatedAt) edgeUpdatedAt = edge.updated_at;
  }
  if (edgeUpdatedAt > updatedAt) updatedAt = edgeUpdatedAt;

  hubs.sort((left, right) => {
    const degree = (entry) => entry.in_degree + entry.out_degree;
    return degree(right) - degree(left) || left.id.localeCompare(right.id);
  });
  orphans.sort();

  return {
    nodes: store.nodes.size,
    edges: edges.length,
    updated_at: updatedAt,
    types: ranked(types, 'type'),
    tags: ranked(tags, 'tag').slice(0, topK),
    relations: ranked(relations, 'relation').slice(0, topK),
    hubs: hubs.slice(0, topK),
    orphans: { count: orphans.length, ids: includeOrphans ? orphans : [] },
  };
}
