/**
 * Model-facing tool definitions.
 *
 * Each tool validates its own arguments, returns a canonical value described by
 * its output schema, and renders that value as bounded text. Reads are marked
 * concurrency-safe; writes stay exclusive.
 */

import {
  DIRECTIONS,
  DESCRIPTION_STRATEGIES,
  GraphError,
  MAX_DRAW_HOPS,
  NODE_TYPES,
  SORT_KEYS,
} from './types.js';
import { search } from './search.js';
import { overview } from './overview.js';
import { query } from './query.js';
import { draw, trace } from './traverse.js';
import {
  MAX_GET_IDS,
  arrayOrEmpty,
  asObject,
  requiredId,
  validateOperations,
  validateRelationList,
  validateSortKey,
  validateTagFilter,
  validateTimestamp,
  validateTypeList,
} from './validate.js';

/** Relations returned per direction by a get call that does not say otherwise. */
const DEFAULT_EDGE_LIMIT = 100;
/** Hard cap on relations returned per direction. */
const MAX_EDGE_LIMIT = 500;
/** Relations attached per direction when `kg_query` hydrates records. */
const QUERY_EDGE_LIMIT = 50;

/* ------------------------------------------------------------------ schemas */

const text = (description) => ({ type: 'string', description });
const integer = (description) => ({ type: 'integer', description });
const boolean = (description) => ({ type: 'boolean', description });
const stringList = (description) => ({ type: 'array', items: { type: 'string' }, description });
const entityType = { type: 'string', enum: [...NODE_TYPES] };
const typeList = (description) => ({
  type: 'array',
  items: { type: 'string', enum: [...NODE_TYPES] },
  description,
});
const directionParam = () => ({ type: 'string', enum: [...DIRECTIONS] });

const nodeRefSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'type'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    type: entityType,
  },
});

const nodeViewSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'type',
    'tags',
    'description',
    'attachments',
    'created_at',
    'updated_at',
    'created_by_session_id',
    'updated_by_session_id',
    'revision',
  ],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    type: entityType,
    tags: { type: 'array', items: { type: 'string' } },
    description: { type: 'string' },
    attachments: { type: 'array', items: { type: 'string' } },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    created_by_session_id: { type: 'string' },
    updated_by_session_id: { type: 'string' },
    revision: { type: 'integer' },
    edges: {
      type: 'object',
      additionalProperties: false,
      required: ['outgoing', 'incoming', 'truncated'],
      properties: {
        outgoing: { type: 'array', items: edgeViewSchema() },
        incoming: { type: 'array', items: edgeViewSchema() },
        truncated: { type: 'boolean' },
      },
    },
  },
});

const edgeViewSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: [
    'from_id',
    'relation',
    'to_id',
    'description',
    'created_at',
    'updated_at',
    'updated_by_session_id',
    'revision',
    'traversal',
    'neighbor',
  ],
  properties: {
    from_id: { type: 'string' },
    relation: { type: 'string' },
    to_id: { type: 'string' },
    description: { type: 'string' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    updated_by_session_id: { type: 'string' },
    revision: { type: 'integer' },
    traversal: { type: 'string', enum: ['forward', 'backward'] },
    neighbor: nodeRefSchema(),
  },
});

const pathEdgeSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: [
    'from_id',
    'relation',
    'to_id',
    'description',
    'created_at',
    'updated_at',
    'updated_by_session_id',
    'revision',
    'traversal',
  ],
  properties: {
    from_id: { type: 'string' },
    relation: { type: 'string' },
    to_id: { type: 'string' },
    description: { type: 'string' },
    created_at: { type: 'string' },
    updated_at: { type: 'string' },
    updated_by_session_id: { type: 'string' },
    revision: { type: 'integer' },
    traversal: { type: 'string', enum: ['forward', 'backward'] },
  },
});

/* ------------------------------------------------------------------ helpers */

/**
 * Owning session recorded as the writer.
 * @param exec - tool execution context.
 * @returns the session id, or `system` for a non-agent caller.
 */
function sessionOf(exec) {
  const id = exec?.agent?.id;
  return typeof id === 'string' && id.length > 0 ? id : 'system';
}

/**
 * Directory used to resolve relative attachment paths.
 * @param exec - tool execution context.
 * @returns the session working directory when known.
 */
function cwdOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
}

/**
 * Read a required string argument.
 * @param args - validated argument object.
 * @param name - property name.
 * @returns the trimmed string.
 */
function stringArg(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GraphError('invalid_args', `\`${name}\` must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * Read one of the direction values.
 * @param args - argument object.
 * @param fallback - value used when omitted.
 * @returns the direction.
 */
function directionArg(args, fallback) {
  const value = args.direction;
  if (value === undefined) return fallback;
  if (!DIRECTIONS.includes(value)) {
    throw new GraphError('invalid_args', `\`direction\` must be one of ${DIRECTIONS.join(', ')}.`);
  }
  return value;
}

/**
 * Read a bounded integer argument.
 * @param value - candidate value.
 * @param fallback - value used when omitted.
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param name - property name used in the message.
 * @returns the clamped integer.
 */
function intArg(value, fallback, min, max, name) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GraphError('invalid_args', `\`${name}\` must be an integer.`);
  }
  return Math.max(min, Math.min(max, value));
}

/**
 * Union the singular and plural type filters.
 * @param single - optional single type.
 * @param many - optional type array.
 * @returns the merged list, or undefined.
 */
function mergeTypes(single, many) {
  const fromSingle = validateTypeList(single, 'type');
  const fromMany = validateTypeList(many, 'types');
  if (fromSingle === undefined && fromMany === undefined) return undefined;
  const merged = [...(fromSingle ?? [])];
  for (const type of fromMany ?? []) if (!merged.includes(type)) merged.push(type);
  return merged.length > 0 ? merged : undefined;
}

/**
 * Collapse text for one-line rendering.
 * @param value - raw text.
 * @param length - maximum length.
 * @returns single-line text.
 */
function oneLine(value, length) {
  const flat = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length <= length ? flat : `${flat.slice(0, length - 1)}…`;
}

/**
 * Render one hydrated entity, with complete descriptions.
 * @param node - public node view.
 * @returns the lines for this entity.
 */
function nodeLines(node) {
  const lines = [`${node.name} [${node.id}] ${node.type} · revision ${node.revision}`];
  lines.push(`  updated ${node.updated_at} by ${node.updated_by_session_id}`);
  if (node.created_by_session_id !== node.updated_by_session_id) {
    lines.push(`  created ${node.created_at} by ${node.created_by_session_id}`);
  }
  if (node.tags.length > 0) lines.push(`  tags: ${node.tags.join(', ')}`);
  if (node.attachments.length > 0) lines.push(`  attachments: ${node.attachments.join(', ')}`);
  if (node.description.length > 0) lines.push(`  description: ${node.description}`);
  if (node.edges !== undefined) {
    if (node.edges.outgoing.length > 0) {
      lines.push('  outgoing:');
      for (const edge of node.edges.outgoing) lines.push(edgeLine(edge, '→'));
    }
    if (node.edges.incoming.length > 0) {
      lines.push('  incoming:');
      for (const edge of node.edges.incoming) lines.push(edgeLine(edge, '←'));
    }
    if (node.edges.truncated) lines.push('  … more relations not shown; raise `edge_limit`.');
  }
  return lines;
}

/**
 * Render one relation line with its complete description.
 * @param edge - edge view.
 * @param arrow - direction marker.
 * @returns the line.
 */
function edgeLine(edge, arrow) {
  const description =
    edge.description.length > 0 ? ` — ${edge.description.replace(/\r?\n/g, '\n      ')}` : '';
  return `    ${edge.relation} ${arrow} ${edge.neighbor.name} [${edge.neighbor.id}] ${edge.neighbor.type}${description}`;
}

/**
 * Join rendered records and apply the configured output cap.
 * @param lines - rendered lines.
 * @param maxChars - cap from Config.
 * @returns the bounded text.
 */
function boundedText(lines, maxChars) {
  const joined = lines.join('\n').trimEnd();
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}\n… output capped at ${maxChars} characters; narrow \`ids\`, \`relations\`, or \`edge_limit\`.`;
}

/**
 * Describe what one changelog row changed.
 * @param entry - history entry value.
 * @returns short field-diff phrases.
 */
function changeSummary(entry) {
  const before = entry.before;
  const after = entry.after;
  const structural = new Set([
    'id',
    'from_id',
    'to_id',
    'created_at',
    'updated_at',
    'created_by_session_id',
    'updated_by_session_id',
    'revision',
  ]);
  if (before === undefined || before === null) {
    if (after === undefined || after === null) return [];
    // The entry header already names an edge; entity creates read better as a
    // short identity line than as a list of every stored column.
    if (after.from_id !== undefined) return [];
    const tags = Array.isArray(after.tags) && after.tags.length > 0 ? ` · ${after.tags.join(', ')}` : '';
    return [`${JSON.stringify(oneLine(after.name ?? '', 60))} · ${after.type ?? ''}${tags}`];
  }
  if (after === undefined || after === null) {
    if (before.from_id !== undefined) return [];
    return [`${JSON.stringify(oneLine(before.name ?? '', 60))} · ${before.type ?? ''}`];
  }
  const parts = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (structural.has(key)) continue;
    const left = before[key];
    const right = after[key];
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    if (Array.isArray(left) || Array.isArray(right)) {
      const added = (right ?? []).filter((item) => !(left ?? []).includes(item));
      const removed = (left ?? []).filter((item) => !(right ?? []).includes(item));
      const diff = [
        added.length > 0 ? `+${added.join('|')}` : '',
        removed.length > 0 ? `-${removed.join('|')}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      if (diff.length > 0) parts.push(`${key}: ${diff}`);
      continue;
    }
    if (typeof left === 'string' || typeof right === 'string') {
      parts.push(
        `${key}: ${JSON.stringify(oneLine(left ?? '', 60))} → ${JSON.stringify(oneLine(right ?? '', 60))}`
      );
      continue;
    }
    parts.push(`${key}: ${JSON.stringify(left)} → ${JSON.stringify(right)}`);
  }
  return parts;
}

/* --------------------------------------------------------------------- tools */

/**
 * Build every tool definition for one store.
 * @param store - graph store.
 * @param limits - configured defaults.
 * @returns registry-ready definitions.
 */
export function createTools(store, limits) {
  return [
    {
      name: 'kg_overview',
      description:
        'Summarize the whole knowledge graph in one call: entity and relation totals, counts by type, the tags and relation labels actually in use, the highest-degree hub entities, and orphaned entities. ' +
        'Call this first in a new session instead of dumping entities just to learn the vocabulary.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          top_k: integer('Entries listed per inventory (tags, relations, hubs), 5-100; defaults to 25.'),
          include_orphans: boolean('List the exact ids of entities with no relations; defaults to true.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['nodes', 'edges', 'updated_at', 'types', 'tags', 'relations', 'hubs', 'orphans'],
          properties: {
            nodes: { type: 'integer' },
            edges: { type: 'integer' },
            updated_at: { type: 'string' },
            types: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['type', 'count'],
                properties: { type: entityType, count: { type: 'integer' } },
              },
            },
            tags: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['tag', 'count'],
                properties: { tag: { type: 'string' }, count: { type: 'integer' } },
              },
            },
            relations: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['relation', 'count'],
                properties: { relation: { type: 'string' }, count: { type: 'integer' } },
              },
            },
            hubs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name', 'type', 'in_degree', 'out_degree'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  type: entityType,
                  in_degree: { type: 'integer' },
                  out_degree: { type: 'integer' },
                },
              },
            },
            orphans: {
              type: 'object',
              additionalProperties: false,
              required: ['count', 'ids'],
              properties: {
                count: { type: 'integer' },
                ids: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        render(_args, value) {
          if (value.nodes === 0) {
            return [
              {
                type: 'text',
                text: 'The knowledge graph is empty. Save the first entity with `kg_save`.',
              },
            ];
          }
          const lines = [
            `Knowledge graph: ${value.nodes} entities, ${value.edges} relations · last change ${value.updated_at}`,
          ];
          if (value.types.length > 0) {
            lines.push(`Types: ${value.types.map((item) => `${item.type} ${item.count}`).join(' · ')}`);
          }
          if (value.tags.length > 0) {
            lines.push(`Tags: ${value.tags.map((item) => `${item.tag} (${item.count})`).join(', ')}`);
          }
          if (value.relations.length > 0) {
            lines.push(
              `Relations: ${value.relations.map((item) => `${item.relation} (${item.count})`).join(', ')}`
            );
          }
          if (value.hubs.length > 0) {
            lines.push('Hubs by degree:');
            for (const hub of value.hubs) {
              lines.push(
                `- ${hub.name} [${hub.id}] ${hub.type} · in ${hub.in_degree}, out ${hub.out_degree}`
              );
            }
          }
          if (value.orphans.count > 0) {
            lines.push(
              value.orphans.ids.length > 0
                ? `Orphans (${value.orphans.count}): ${value.orphans.ids.join(', ')}`
                : `${value.orphans.count} orphaned entities (pass \`include_orphans: true\` for ids).`
            );
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const body = asObject(args, 'arguments');
        return overview(store, {
          topK: intArg(body.top_k, 25, 5, 100, 'top_k'),
          includeOrphans: body.include_orphans !== false,
        });
      },
    },

    {
      name: 'kg_search',
      description:
        'Find knowledge-graph entities by text and metadata. Matching ranks names above tags, and tags above descriptions; partial matches count. ' +
        'An empty query lists entities ordered by `sort_by` (default `updated_at`). ' +
        'Returns ids, types, tags, and short excerpts; call `kg_get` for full records and relations.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: text(
            'Words or substring to match. Pass an empty string "" to list entities without text filtering.'
          ),
          type: entityType,
          types: typeList('Only return entities whose type is one of these.'),
          tags: stringList('AND filter: only return entities carrying every listed tag.'),
          tags_any: stringList('OR filter: only return entities carrying at least one listed tag.'),
          sort_by: {
            type: 'string',
            enum: [...SORT_KEYS],
            description:
              'Sort order. Defaults to `relevance` when `query` is non-empty, otherwise `updated_at`.',
          },
          limit: integer('Maximum hits to return, 1-100; defaults to the configured page size.'),
          offset: integer('Zero-based pagination offset; defaults to 0.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['query', 'sort_by', 'offset', 'count', 'total', 'truncated', 'results'],
          properties: {
            query: { type: 'string' },
            sort_by: { type: 'string' },
            offset: { type: 'integer' },
            count: { type: 'integer' },
            total: { type: 'integer' },
            truncated: { type: 'boolean' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'id',
                  'name',
                  'type',
                  'tags',
                  'excerpt',
                  'matched_field',
                  'match_kind',
                  'updated_at',
                  'revision',
                ],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  type: entityType,
                  tags: { type: 'array', items: { type: 'string' } },
                  excerpt: { type: 'string' },
                  matched_field: { type: 'string', enum: ['name', 'tag', 'description', 'recent'] },
                  match_kind: { type: 'string', enum: ['exact', 'prefix', 'substring', 'recent'] },
                  updated_at: { type: 'string' },
                  revision: { type: 'integer' },
                },
              },
            },
          },
        },
        render(_args, value) {
          if (value.total === 0) {
            return [
              {
                type: 'text',
                text:
                  value.query.length === 0
                    ? 'No entity matched those filters. Try another type or tag.'
                    : `No entity matched ${JSON.stringify(value.query)}. Try fewer words, another type filter, or a tag only.`,
              },
            ];
          }
          const first = value.offset + 1;
          const last = value.offset + value.count;
          const more = value.truncated
            ? ` — raise \`limit\` or pass \`offset: ${value.offset + value.count}\``
            : '';
          const lines = [
            `Showing ${first}–${last} of ${value.total} entities · sorted by ${value.sort_by}${more}`,
          ];
          for (const hit of value.results) {
            const tags = hit.tags.length > 0 ? ` · ${hit.tags.join(', ')}` : '';
            const where =
              hit.matched_field === 'recent' ? 'recent' : `${hit.matched_field}:${hit.match_kind}`;
            lines.push(`- ${hit.name} [${hit.id}] ${hit.type}${tags} · ${where}`);
            if (hit.excerpt.length > 0) lines.push(`    ${hit.excerpt}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const body = asObject(args, 'arguments');
        if (typeof body.query !== 'string') {
          throw new GraphError(
            'invalid_args',
            '`query` must be a string; pass "" to list entities without text filtering.'
          );
        }
        const limit = intArg(body.limit, limits.maxSearchResults, 1, 100, 'limit');
        const offset = intArg(body.offset, 0, 0, 1_000_000, 'offset');
        return search(store, {
          query: body.query,
          types: mergeTypes(body.type, body.types),
          tagsAll: validateTagFilter(body.tags, 'tags'),
          tagsAny: validateTagFilter(body.tags_any, 'tags_any'),
          sortBy:
            validateSortKey(body.sort_by) ?? (body.query.trim().length > 0 ? 'relevance' : 'updated_at'),
          limit,
          offset,
        });
      },
    },

    {
      name: 'kg_get',
      description:
        'Read knowledge-graph entities by exact id, including full untruncated descriptions, metadata, attachments, and complete immediate relations. ' +
        'Ids come from `kg_search`, `kg_query`, `kg_overview`, `kg_draw_graph`, or `kg_trace_node`.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['ids'],
        properties: {
          ids: stringList(`Exact entity ids, at most ${MAX_GET_IDS}. Resolve names with kg_search first.`),
          include_edges: boolean('Attach immediate relations; defaults to true.'),
          direction: directionParam(),
          relations: stringList('Only attach relations whose label is one of these.'),
          edge_limit: integer('Maximum relations per direction, 1-500; defaults to 100.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['nodes', 'missing'],
          properties: {
            nodes: { type: 'array', items: nodeViewSchema() },
            missing: { type: 'array', items: { type: 'string' } },
          },
        },
        render(_args, value) {
          if (value.nodes.length === 0) {
            const missing = value.missing.length > 0 ? ` Missing: ${value.missing.join(', ')}.` : '';
            return [{ type: 'text', text: `No entity found.${missing}` }];
          }
          const lines = [];
          for (const node of value.nodes) {
            lines.push(...nodeLines(node));
            lines.push('');
          }
          if (value.missing.length > 0) lines.push(`Missing ids: ${value.missing.join(', ')}`);
          return [{ type: 'text', text: boundedText(lines, limits.maxGetChars) }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const body = asObject(args, 'arguments');
        const ids = arrayOrEmpty(body.ids, 'ids').map((id) => requiredId(id, 'ids[]'));
        if (ids.length === 0) throw new GraphError('invalid_args', '`ids` must name at least one entity.');
        if (ids.length > MAX_GET_IDS) {
          throw new GraphError('invalid_args', `At most ${MAX_GET_IDS} ids may be read in one call.`);
        }
        return store.get({
          ids,
          includeEdges: body.include_edges !== false,
          direction: directionArg(body, 'both'),
          relations: validateRelationList(body.relations, 'relations'),
          edgeLimit: intArg(body.edge_limit, DEFAULT_EDGE_LIMIT, 1, MAX_EDGE_LIMIT, 'edge_limit'),
        });
      },
    },

    {
      name: 'kg_query',
      description:
        'Filter entities by their own attributes (text, type, tags, update window) together with an incident-relation constraint (direction, relation, neighbor id/type/tag), and optionally return full records in the same call. ' +
        'Use it when `kg_search` cannot express "entities of this kind connected to that entity".',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: text('Optional text substring matched against name, tags, or description.'),
          types: typeList('Match entities whose type is one of these.'),
          tags_all: stringList('Entity must carry every one of these tags.'),
          tags_any: stringList('Entity must carry at least one of these tags.'),
          updated_after: text('ISO 8601 lower bound on the entity `updated_at`.'),
          updated_before: text('ISO 8601 upper bound on the entity `updated_at`.'),
          edge_filter: {
            type: 'object',
            additionalProperties: false,
            description: 'Require at least one incident relation matching all of these criteria.',
            properties: {
              direction: directionParam(),
              relations: stringList('Allowed relation labels on the connecting edge.'),
              neighbor_ids: stringList('Require the other endpoint to be one of these entity ids.'),
              neighbor_types: typeList('Require the other endpoint to have one of these types.'),
              neighbor_tags_any: stringList(
                'Require the other endpoint to carry at least one of these tags.'
              ),
            },
          },
          include_full_records: boolean(
            'Return full kg_get-style records (up to 50) instead of one-line results; defaults to false.'
          ),
          limit: integer('Maximum results, 1-100 (1-50 with `include_full_records`); defaults to 25.'),
          offset: integer('Zero-based pagination offset; defaults to 0.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['count', 'total', 'truncated', 'offset', 'results', 'nodes'],
          properties: {
            count: { type: 'integer' },
            total: { type: 'integer' },
            truncated: { type: 'boolean' },
            offset: { type: 'integer' },
            results: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['id', 'name', 'type', 'tags', 'excerpt', 'updated_at', 'revision'],
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  type: entityType,
                  tags: { type: 'array', items: { type: 'string' } },
                  excerpt: { type: 'string' },
                  updated_at: { type: 'string' },
                  revision: { type: 'integer' },
                },
              },
            },
            nodes: { type: 'array', items: nodeViewSchema() },
          },
        },
        render(_args, value) {
          if (value.total === 0) {
            return [
              {
                type: 'text',
                text: 'No entity matched those filters. Loosen the edge filter or the tag list.',
              },
            ];
          }
          const lines = [];
          if (value.nodes.length > 0) {
            for (const node of value.nodes) {
              lines.push(...nodeLines(node));
              lines.push('');
            }
          } else {
            const more = value.truncated ? ` — pass \`offset: ${value.offset + value.count}\`` : '';
            lines.push(
              `Showing ${value.offset + 1}–${value.offset + value.count} of ${value.total} entities${more}`
            );
            for (const hit of value.results) {
              const tags = hit.tags.length > 0 ? ` · ${hit.tags.join(', ')}` : '';
              lines.push(
                `- ${hit.name} [${hit.id}] ${hit.type}${tags} · rev ${hit.revision} · ${hit.updated_at}`
              );
              if (hit.excerpt.length > 0) lines.push(`    ${hit.excerpt}`);
            }
          }
          return [{ type: 'text', text: boundedText(lines, limits.maxGetChars) }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const body = asObject(args, 'arguments');
        const full = body.include_full_records === true;
        const edgeFilter =
          body.edge_filter === undefined
            ? undefined
            : buildEdgeFilter(asObject(body.edge_filter, 'edge_filter'));
        return query(store, {
          query: body.query === undefined ? '' : String(body.query),
          types: validateTypeList(body.types, 'types'),
          tagsAll: validateTagFilter(body.tags_all, 'tags_all'),
          tagsAny: validateTagFilter(body.tags_any, 'tags_any'),
          updatedAfter: validateTimestamp(body.updated_after, 'updated_after'),
          updatedBefore: validateTimestamp(body.updated_before, 'updated_before'),
          edgeFilter,
          includeFullRecords: full,
          limit: intArg(body.limit, 25, 1, full ? 50 : 100, 'limit'),
          offset: intArg(body.offset, 0, 0, 1_000_000, 'offset'),
        });
      },
    },

    {
      name: 'kg_save',
      description:
        'Create or update entities and relations in the knowledge graph, atomically. ' +
        'Create entities before the edges that use them; a `$name` id in `create` is a batch-local reference an edge can use in the same call. ' +
        'An edge is identified by `(from_id, relation, to_id)`, so one pair may hold several relations. ' +
        'Updates name an exact id and change only the fields supplied. Pass `expected_revision` to reject a stale write; omit it to overwrite. Unchanged values do not bump the revision.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodes: {
            type: 'object',
            additionalProperties: false,
            properties: {
              create: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'type'],
                  properties: {
                    id: text(
                      'Optional stable id. A `$alias` value is replaced by a generated id and is usable by edges in this call.'
                    ),
                    name: text('Entity name or statement title, unique only within its own meaning.'),
                    type: entityType,
                    tags: stringList(
                      'Short labels for grouping and search; stored lowercased, deduplicated, and sorted.'
                    ),
                    description: text('What this entity is; Markdown is kept as written.'),
                    attachments: stringList(
                      'Absolute paths or http(s)/file URLs. Relative paths resolve against the session directory.'
                    ),
                  },
                },
              },
              update: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id'],
                  properties: {
                    id: text('Exact entity id from a previous read.'),
                    expected_revision: integer(
                      'Revision the caller last saw; a mismatch fails the whole batch.'
                    ),
                    name: text('Replacement name.'),
                    type: entityType,
                    tags: stringList('Replacement tag list; `[]` clears it.'),
                    description: text('Replacement description.'),
                    attachments: stringList('Replacement attachment list; `[]` clears it.'),
                  },
                },
              },
            },
          },
          edges: {
            type: 'object',
            additionalProperties: false,
            properties: {
              create: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['from_id', 'to_id'],
                  properties: {
                    from_id: text('Source entity id or `$alias` from this call.'),
                    to_id: text('Target entity id or `$alias` from this call.'),
                    relation: text('Lowercase relation label such as `works_for`; defaults to `related_to`.'),
                    description: text('What this relation means or the evidence for it.'),
                  },
                },
              },
              update: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['from_id', 'to_id'],
                  properties: {
                    from_id: text('Existing edge source id.'),
                    to_id: text('Existing edge target id.'),
                    relation: text(
                      'Selects which relation between the pair to change; with a single relation between the pair it is also the legacy replacement label.'
                    ),
                    new_relation: text('Rename the relation label itself.'),
                    expected_revision: integer(
                      'Revision the caller last saw; a mismatch fails the whole batch.'
                    ),
                    description: text('Replacement description.'),
                  },
                },
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'nodes', 'edges'],
          properties: {
            ok: { type: 'boolean' },
            nodes: {
              type: 'object',
              additionalProperties: false,
              required: ['created', 'updated', 'unchanged'],
              properties: {
                created: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'name'],
                    properties: { id: { type: 'string' }, name: { type: 'string' } },
                  },
                },
                updated: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'name', 'revision'],
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                      revision: { type: 'integer' },
                    },
                  },
                },
                unchanged: { type: 'array', items: { type: 'string' } },
              },
            },
            edges: {
              type: 'object',
              additionalProperties: false,
              required: ['created', 'updated', 'unchanged'],
              properties: {
                created: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['from_id', 'relation', 'to_id'],
                    properties: {
                      from_id: { type: 'string' },
                      relation: { type: 'string' },
                      to_id: { type: 'string' },
                    },
                  },
                },
                updated: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['from_id', 'relation', 'to_id', 'revision'],
                    properties: {
                      from_id: { type: 'string' },
                      relation: { type: 'string' },
                      to_id: { type: 'string' },
                      revision: { type: 'integer' },
                    },
                  },
                },
                unchanged: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['from_id', 'relation', 'to_id'],
                    properties: {
                      from_id: { type: 'string' },
                      relation: { type: 'string' },
                      to_id: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        render(_args, value) {
          const lines = [
            `Saved: ${value.nodes.created.length} entities created, ${value.nodes.updated.length} updated, ` +
              `${value.nodes.unchanged.length} unchanged; ${value.edges.created.length} relations created, ` +
              `${value.edges.updated.length} updated.`,
          ];
          for (const node of value.nodes.created) lines.push(`+ ${node.name} [${node.id}]`);
          for (const node of value.nodes.updated)
            lines.push(`~ ${node.name} [${node.id}] revision ${node.revision}`);
          for (const edge of value.edges.created)
            lines.push(`+ ${edge.from_id} —${edge.relation}→ ${edge.to_id}`);
          for (const edge of value.edges.updated) {
            lines.push(`~ ${edge.from_id} —${edge.relation}→ ${edge.to_id} revision ${edge.revision}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return store.save(args, { sessionId: sessionOf(exec), cwd: cwdOf(exec) });
      },
    },

    {
      name: 'kg_delete',
      description:
        'Delete explicitly identified entities or relations from the knowledge graph. ' +
        'Deletion never guesses from a name: pass exact ids, or an exact `(from_id, to_id)` pair with `relation` when that pair holds more than one relation. ' +
        'An entity with connected relations is refused unless `cascade_edges` is true, which deletes those relations too but never neighboring entities or attached files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodes: {
            type: 'array',
            description: 'Entities to delete.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id'],
              properties: {
                id: text('Exact entity id.'),
                expected_revision: integer('Revision the caller last saw.'),
              },
            },
          },
          edges: {
            type: 'array',
            description: 'Relations to delete.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['from_id', 'to_id'],
              properties: {
                from_id: text('Edge source id.'),
                to_id: text('Edge target id.'),
                relation: text('Which relation to delete; required when the pair holds more than one.'),
                expected_revision: integer('Revision the caller last saw.'),
              },
            },
          },
          cascade_edges: boolean('Also delete relations attached to the deleted entities.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'deleted', 'counts'],
          properties: {
            ok: { type: 'boolean' },
            deleted: {
              type: 'object',
              additionalProperties: false,
              required: ['nodes', 'edges'],
              properties: {
                nodes: { type: 'array', items: { type: 'string' } },
                edges: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['from_id', 'relation', 'to_id'],
                    properties: {
                      from_id: { type: 'string' },
                      relation: { type: 'string' },
                      to_id: { type: 'string' },
                    },
                  },
                },
              },
            },
            counts: {
              type: 'object',
              additionalProperties: false,
              required: ['nodes', 'edges'],
              properties: { nodes: { type: 'integer' }, edges: { type: 'integer' } },
            },
          },
        },
        render(_args, value) {
          const parts = [`Deleted ${value.counts.nodes} entit${value.counts.nodes === 1 ? 'y' : 'ies'}`];
          parts.push(`${value.counts.edges} relation${value.counts.edges === 1 ? '' : 's'}`);
          return [{ type: 'text', text: `${parts.join(' and ')}.` }];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const body = asObject(args, 'arguments');
        const nodes = arrayOrEmpty(body.nodes, 'nodes');
        const edges = arrayOrEmpty(body.edges, 'edges');
        if (nodes.length === 0 && edges.length === 0) {
          throw new GraphError('invalid_args', 'Pass at least one entry in `nodes` or `edges`.');
        }
        return store.remove(body, { sessionId: sessionOf(exec) });
      },
    },

    {
      name: 'kg_merge',
      description:
        'Atomically merge one entity into another (or rename its id when the target does not exist), rewiring every incident relation onto the target, unioning tags and attachments, combining descriptions, dropping the self-loops that merging creates, and folding duplicate relations. ' +
        'Use it to deduplicate entities and to fix inconsistent ids without deleting history.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['source_id', 'target_id'],
        properties: {
          source_id: text('Existing entity id to be merged and removed.'),
          target_id: text('Existing entity id to merge into, or an unused id to rename the source to.'),
          description_strategy: {
            type: 'string',
            enum: [...DESCRIPTION_STRATEGIES],
            description: 'How to combine descriptions when the target exists; defaults to `append`.',
          },
          merged_description: text(
            'Explicit replacement description for the target (overrides `description_strategy`).'
          ),
          merged_name: text('Explicit replacement name for the target.'),
          expected_source_revision: integer('Optional optimistic lock on the source.'),
          expected_target_revision: integer('Optional optimistic lock on the target.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'mode', 'source_id', 'target_id', 'revision', 'nodes', 'edges'],
          properties: {
            ok: { type: 'boolean' },
            mode: { type: 'string', enum: ['merged', 'renamed'] },
            source_id: { type: 'string' },
            target_id: { type: 'string' },
            revision: { type: 'integer' },
            nodes: {
              type: 'object',
              additionalProperties: false,
              required: ['removed', 'written'],
              properties: { removed: { type: 'integer' }, written: { type: 'integer' } },
            },
            edges: {
              type: 'object',
              additionalProperties: false,
              required: ['moved', 'combined', 'dropped'],
              properties: {
                moved: { type: 'integer' },
                combined: { type: 'integer' },
                dropped: { type: 'integer' },
              },
            },
          },
        },
        render(_args, value) {
          const verb = value.mode === 'renamed' ? 'Renamed' : 'Merged';
          return [
            {
              type: 'text',
              text:
                `${verb} ${value.source_id} → ${value.target_id} (revision ${value.revision}); ` +
                `${value.edges.moved} relations moved, ${value.edges.combined} folded into existing relations, ` +
                `${value.edges.dropped} self-loops dropped.`,
            },
          ];
        },
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        return store.merge(args, { sessionId: sessionOf(exec) });
      },
    },

    {
      name: 'kg_history',
      description:
        'Inspect what changed and when. With `id`, returns the chronological revision history of that entity (optionally including its relations). Without `id`, returns a changelog summary of every node and relation created, updated, merged, or deleted since a timestamp or session. ' +
        'Use it to recover a prior value, explain an edit, or review a period of work.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: text('Optional exact entity id to inspect its own revision history.'),
          include_edge_history: boolean(
            'When `id` is given, also include mutations to relations touching that entity; defaults to false.'
          ),
          since: text('ISO 8601 lower bound, e.g. "2026-09-20T00:00:00Z".'),
          until: text('ISO 8601 upper bound.'),
          session_id: text('Only show mutations performed by this session id.'),
          operations: {
            type: 'array',
            items: { type: 'string', enum: ['create', 'update', 'delete', 'merge'] },
            description: 'Only show these mutation kinds.',
          },
          limit: integer('Maximum changelog entries to return, 1-100; defaults to 50.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['mode', 'target', 'since', 'until', 'count', 'total', 'truncated', 'counts', 'entries'],
          properties: {
            mode: { type: 'string', enum: ['entity', 'diff'] },
            target: { type: 'string' },
            since: { type: 'string' },
            until: { type: 'string' },
            count: { type: 'integer' },
            total: { type: 'integer' },
            truncated: { type: 'boolean' },
            counts: {
              type: 'object',
              additionalProperties: false,
              required: ['create', 'update', 'delete', 'merge'],
              properties: {
                create: { type: 'integer' },
                update: { type: 'integer' },
                delete: { type: 'integer' },
                merge: { type: 'integer' },
              },
            },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'seq',
                  'timestamp',
                  'session_id',
                  'target_kind',
                  'target_key',
                  'operation',
                  'revision',
                ],
                properties: {
                  seq: { type: 'integer' },
                  timestamp: { type: 'string' },
                  session_id: { type: 'string' },
                  target_kind: { type: 'string', enum: ['node', 'edge'] },
                  target_key: { type: 'string' },
                  operation: { type: 'string', enum: ['create', 'update', 'delete', 'merge'] },
                  revision: { type: 'integer' },
                  before: { type: 'object' },
                  after: { type: 'object' },
                },
              },
            },
          },
        },
        render(_args, value) {
          if (value.total === 0) {
            const window = value.since.length > 0 ? ` since ${value.since}` : '';
            return [{ type: 'text', text: `No recorded changes${window}.` }];
          }
          const counts = value.counts;
          const header =
            value.mode === 'entity'
              ? `${value.total} recorded change(s) for ${value.target}${value.truncated ? ', most recent shown' : ''}:`
              : `${value.total} recorded change(s)${value.since.length > 0 ? ` since ${value.since}` : ''}: ` +
                `${counts.create} created, ${counts.update} updated, ${counts.delete} deleted, ${counts.merge} merged`;
          const lines = [header];
          for (const entry of value.entries) {
            const kind = entry.target_kind === 'node' ? entry.target_key : edgeLabel(entry.target_key);
            lines.push(
              `- #${entry.seq} ${entry.timestamp} · ${entry.operation} ${entry.target_kind} ${kind} · rev ${entry.revision} · ${entry.session_id}`
            );
            const changes = changeSummary(entry);
            if (changes.length > 0) lines.push(`    ${changes.slice(0, 6).join('; ')}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const body = asObject(args, 'arguments');
        const id = body.id === undefined ? undefined : requiredId(body.id, 'id');
        return store.history({
          id,
          includeEdgeHistory: body.include_edge_history === true,
          since: validateTimestamp(body.since, 'since'),
          until: validateTimestamp(body.until, 'until'),
          sessionId: body.session_id === undefined ? undefined : requiredId(body.session_id, 'session_id'),
          operations: validateOperations(body.operations),
          limit: intArg(body.limit, 50, 1, 100, 'limit'),
        });
      },
    },

    {
      name: 'kg_draw_graph',
      description:
        'Draw the neighborhood of one entity as a tree-like text graph, up to three hops away. ' +
        'Arrows keep each stored edge direction, repeated entities are referenced once, and cycles are marked instead of expanded. ' +
        'Use `exclude_relations` to keep high-frequency relations (such as timeline events) from crowding out the structure you want to see.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['root_id'],
        properties: {
          root_id: text('Exact id of the entity at the center of the drawing.'),
          hops: integer(`How many edges to walk, 0-${MAX_DRAW_HOPS}; defaults to 2.`),
          direction: directionParam(),
          relations: stringList('Only follow these relation labels.'),
          exclude_relations: stringList('Do not follow these relation labels.'),
          max_nodes: integer('Stop after this many distinct entities; defaults to the configured cap.'),
          max_neighbors: integer(
            'Maximum relations expanded per entity before the rest are summarized, 1-200; defaults to 25.'
          ),
          include_edge_descriptions: boolean('Render a short description on each branch; defaults to false.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['root', 'hops', 'direction', 'truncated', 'reasons', 'nodes', 'text'],
          properties: {
            root: nodeRefSchema(),
            hops: { type: 'integer' },
            direction: { type: 'string', enum: [...DIRECTIONS] },
            truncated: { type: 'boolean' },
            reasons: { type: 'array', items: { type: 'string' } },
            nodes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['alias', 'id', 'name', 'type'],
                properties: {
                  alias: { type: 'string' },
                  id: { type: 'string' },
                  name: { type: 'string' },
                  type: entityType,
                },
              },
            },
            text: { type: 'string' },
          },
        },
        render(_args, value) {
          const legend = value.nodes.map((node) => `  ${node.alias} = ${node.id} (${node.name})`);
          const header = `${value.hops} hop${value.hops === 1 ? '' : 's'} · ${value.direction}`;
          const note = value.truncated ? ` · truncated: ${value.reasons.join(', ')}` : '';
          return [
            {
              type: 'text',
              text: `${value.text}\n\n${header}${note}\nNodes:\n${legend.join('\n')}`,
            },
          ];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const body = asObject(args, 'arguments');
        return draw(store, {
          rootId: stringArg(body, 'root_id'),
          hops: intArg(body.hops, 2, 0, MAX_DRAW_HOPS, 'hops'),
          direction: directionArg(body, 'both'),
          relations: validateRelationList(body.relations, 'relations'),
          excludeRelations: validateRelationList(body.exclude_relations, 'exclude_relations'),
          maxNodes: intArg(body.max_nodes, limits.maxDrawNodes, 1, 500, 'max_nodes'),
          maxNeighbors: intArg(body.max_neighbors, 25, 1, 200, 'max_neighbors'),
          includeEdgeDescriptions: body.include_edge_descriptions === true,
          maxChars: limits.maxDrawChars,
          maxEdges: 200,
        });
      },
    },

    {
      name: 'kg_trace_node',
      description:
        'Find one shortest path between two entities, or prove that none exists under the chosen direction and filters. ' +
        'With `direction: both` the result is a connectivity path, not a directed route; each edge records which way it was walked. ' +
        'Returns `not_found_within_hops` when a longer path may exist, and `no_path` when the search space was exhausted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['from_id', 'to_id'],
        properties: {
          from_id: text('Exact id of the start entity.'),
          to_id: text('Exact id of the target entity.'),
          direction: directionParam(),
          max_hops: integer('Maximum edges to walk, 1-32; defaults to 6.'),
          relations: stringList('Only follow these relation labels.'),
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'directed', 'hops', 'examined', 'path'],
          properties: {
            status: {
              type: 'string',
              enum: ['found', 'not_found_within_hops', 'no_path', 'search_limit_reached'],
            },
            directed: { type: 'boolean' },
            hops: { type: 'integer' },
            examined: { type: 'integer' },
            path: {
              type: 'object',
              additionalProperties: false,
              required: ['nodes', 'edges'],
              properties: {
                nodes: { type: 'array', items: nodeRefSchema() },
                edges: { type: 'array', items: pathEdgeSchema() },
              },
            },
          },
        },
        render(_args, value) {
          if (value.status !== 'found') {
            const reason =
              value.status === 'not_found_within_hops'
                ? 'No path of at most the requested hops was found; a longer path may exist. Raise `max_hops` or use `direction: both`.'
                : value.status === 'no_path'
                  ? 'The reachable part of the graph was exhausted, so no such path exists under this direction and filter.'
                  : 'A search limit stopped the walk, so existence is unknown. Narrow the filters or use `kg_draw_graph`.';
            return [{ type: 'text', text: `No path confirmed. ${reason}` }];
          }
          if (value.hops === 0) {
            const node = value.path.nodes[0];
            return [
              {
                type: 'text',
                text: `${node.name} [${node.id}] is the same entity; no edges are needed.`,
              },
            ];
          }
          const kind = value.directed ? 'directed' : 'undirected connectivity';
          const lines = [`Found a ${value.hops}-hop path (${kind}):`];
          value.path.nodes.forEach((node, index) => {
            lines.push(`${index + 1}. ${node.name} [${node.id}] ${node.type}`);
            const edge = value.path.edges[index];
            if (edge === undefined) return;
            const arrow = edge.traversal === 'backward' ? '←' : '→';
            lines.push(`   ${edge.relation} ${arrow}`);
          });
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const body = asObject(args, 'arguments');
        return trace(store, {
          fromId: stringArg(body, 'from_id'),
          toId: stringArg(body, 'to_id'),
          direction: directionArg(body, 'outgoing'),
          maxHops: intArg(
            body.max_hops,
            6,
            1,
            limits.maxTraceHops > 32 ? 32 : limits.maxTraceHops,
            'max_hops'
          ),
          relations: validateRelationList(body.relations, 'relations'),
        });
      },
    },
  ];
}

/**
 * Normalize the `edge_filter` object of `kg_query`.
 * @param filter - raw argument object.
 * @returns the normalized filter.
 */
function buildEdgeFilter(filter) {
  const neighborTypes = validateTypeList(filter.neighbor_types, 'neighbor_types');
  return {
    direction: filter.direction === undefined ? 'both' : directionArg(filter, 'both'),
    relations: validateRelationList(filter.relations, 'relations'),
    neighborIds: validateIdList(filter.neighbor_ids, 'neighbor_ids'),
    neighborTypes,
    neighborTagsAny: validateTagFilter(filter.neighbor_tags_any, 'neighbor_tags_any'),
  };
}

/**
 * Validate an optional id list.
 * @param value - candidate list.
 * @param label - argument path used in the message.
 * @returns the ids, or undefined when not supplied.
 */
function validateIdList(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new GraphError('invalid_args', `\`${label}\` must be an array of ids.`);
  const ids = value.map((id) => requiredId(id, `${label}[]`));
  return ids.length > 0 ? ids : undefined;
}

/**
 * Display text for an edge changelog key.
 * @param key - stored `["from","relation","to"]`.
 * @returns a readable relation label.
 */
function edgeLabel(key) {
  try {
    const value = JSON.parse(key);
    if (Array.isArray(value) && value.length === 3) return `${value[0]} —${value[1]}→ ${value[2]}`;
  } catch {
    // Fall through to the raw key.
  }
  return key;
}
