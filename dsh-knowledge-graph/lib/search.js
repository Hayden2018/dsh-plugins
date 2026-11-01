/**
 * Ranked entity search.
 *
 * Ranking is fixed: name before tag before description, and exact before
 * prefix before substring within each field. A token fallback keeps multi-word
 * queries useful when the whole phrase does not occur verbatim.
 *
 * Filters, ordering, and pagination are applied after ranking, so `total` is
 * always the number of entities that matched rather than the page size.
 */

import { normalizeText } from './validate.js';

/** Field order is the requested priority: name, then tag, then description. */
const RANK = Object.freeze({
  nameExact: 0,
  namePrefix: 1,
  nameSubstring: 2,
  tagExact: 3,
  tagPrefix: 4,
  tagSubstring: 5,
  description: 6,
  recent: 7,
});

/** Longest description excerpt returned by a search hit. */
export const EXCERPT_LENGTH = 180;

/**
 * Classify one node against one phrase.
 * @param node - indexed node.
 * @param query - normalized phrase.
 * @returns the best match, or null.
 */
function matchPhrase(node, query) {
  if (node._name === query) return { rank: RANK.nameExact, field: 'name', kind: 'exact' };
  if (node._name.startsWith(query)) return { rank: RANK.namePrefix, field: 'name', kind: 'prefix' };
  if (node._name.includes(query)) return { rank: RANK.nameSubstring, field: 'name', kind: 'substring' };

  for (const tag of node._tags) {
    if (tag === query) return { rank: RANK.tagExact, field: 'tag', kind: 'exact' };
  }
  for (const tag of node._tags) {
    if (tag.startsWith(query)) return { rank: RANK.tagPrefix, field: 'tag', kind: 'prefix' };
  }
  for (const tag of node._tags) {
    if (tag.includes(query)) return { rank: RANK.tagSubstring, field: 'tag', kind: 'substring' };
  }
  if (node._desc.includes(query)) return { rank: RANK.description, field: 'description', kind: 'substring' };
  return null;
}

/**
 * Match every word somewhere in the same field. Only used when the literal
 * phrase matched nothing.
 * @param node - indexed node.
 * @param tokens - normalized words.
 * @returns the best match, or null.
 */
function matchTokens(node, tokens) {
  if (tokens.every((token) => node._name.includes(token))) {
    return { rank: RANK.nameSubstring, field: 'name', kind: 'substring' };
  }
  if (tokens.every((token) => node._tags.some((tag) => tag.includes(token)))) {
    return { rank: RANK.tagSubstring, field: 'tag', kind: 'substring' };
  }
  if (tokens.every((token) => node._desc.includes(token))) {
    return { rank: RANK.description, field: 'description', kind: 'substring' };
  }
  return null;
}

/**
 * Match one node against free text, falling back to word matching.
 * @param node - indexed node.
 * @param text - normalized query text; empty means "everything".
 * @returns the best match, or null.
 */
export function matchNode(node, text) {
  if (text.length === 0) return { rank: RANK.recent, field: 'recent', kind: 'recent' };
  const match = matchPhrase(node, text);
  if (match !== null) return match;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) return null;
  return matchTokens(node, tokens);
}

/**
 * One-line description excerpt.
 * @param text - full description.
 * @returns whitespace-collapsed, length-bounded text.
 */
export function excerpt(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_LENGTH) return flat;
  return `${flat.slice(0, EXCERPT_LENGTH - 1)}…`;
}

/**
 * Order hits for one of the supported sort keys.
 * @param hits - matched hits.
 * @param sortBy - `relevance`, `updated_at`, `created_at`, `name`, or `degree`.
 * @param store - graph store used for degree counts.
 * @returns the same array, sorted.
 */
export function sortHits(hits, sortBy, store) {
  const byName = (left, right) => {
    if (left.node._name !== right.node._name) return left.node._name < right.node._name ? -1 : 1;
    return left.node.id < right.node.id ? -1 : left.node.id > right.node.id ? 1 : 0;
  };
  if (sortBy === 'updated_at') {
    hits.sort(
      (left, right) => right.node.updated_at.localeCompare(left.node.updated_at) || byName(left, right)
    );
  } else if (sortBy === 'created_at') {
    hits.sort(
      (left, right) => right.node.created_at.localeCompare(left.node.created_at) || byName(left, right)
    );
  } else if (sortBy === 'name') {
    hits.sort(byName);
  } else if (sortBy === 'degree') {
    const degree = (node) => {
      const counts = store.degreeOf(node.id);
      return counts.in + counts.out;
    };
    hits.sort((left, right) => degree(right.node) - degree(left.node) || byName(left, right));
  } else {
    hits.sort((left, right) => left.rank - right.rank || byName(left, right));
  }
  return hits;
}

/**
 * Search the in-memory graph.
 * @param store - graph store.
 * @param args - validated arguments.
 * @param args.query - free text; empty lists without text filtering.
 * @param args.types - optional node-type filter.
 * @param args.tagsAll - tags that must all be present.
 * @param args.tagsAny - tags of which at least one must be present.
 * @param args.sortBy - ordering key.
 * @param args.limit - page size.
 * @param args.offset - zero-based page offset.
 * @returns ranked, filtered, paged hits.
 */
export function search(store, { query, types, tagsAll, tagsAny, sortBy, limit, offset }) {
  store.assertReady();
  const text = normalizeText(query);
  const typeSet = types === undefined ? undefined : new Set(types);
  const all = tagsAll ?? [];
  const any = tagsAny ?? [];
  const hits = [];

  /** Apply the filters every candidate must pass. */
  const eligible = (node) => {
    if (typeSet !== undefined && !typeSet.has(node.type)) return false;
    if (all.length > 0 && !all.every((tag) => node._tags.includes(tag))) return false;
    if (any.length > 0 && !any.some((tag) => node._tags.includes(tag))) return false;
    return true;
  };

  for (const node of store.nodes.values()) {
    if (!eligible(node)) continue;
    const match = matchNode(node, text);
    if (match === null) continue;
    hits.push({ node, ...match });
  }

  sortHits(hits, sortBy, store);
  const total = hits.length;
  const page = hits.slice(offset, offset + limit);
  return {
    query: typeof query === 'string' ? query : '',
    sort_by: sortBy,
    offset,
    count: page.length,
    total,
    truncated: total > offset + page.length,
    results: page.map((hit) => ({
      id: hit.node.id,
      name: hit.node.name,
      type: hit.node.type,
      tags: [...hit.node.tags],
      excerpt: excerpt(hit.node.description),
      matched_field: hit.field,
      match_kind: hit.kind,
      updated_at: hit.node.updated_at,
      revision: hit.node.revision,
    })),
  };
}
