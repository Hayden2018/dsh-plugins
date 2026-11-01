/**
 * Argument validation and normalization.
 *
 * Every value that reaches SQLite or the in-memory index passes through here
 * first, so the store can assume well-typed, trimmed, bounded input.
 */

import { isAbsolute, resolve } from 'node:path';
import { DESCRIPTION_STRATEGIES, GraphError, HISTORY_OPERATIONS, NODE_TYPE_SET, SORT_KEYS } from './types.js';

/** Longest accepted node name. */
export const MAX_NAME_LENGTH = 200;
/** Longest accepted description. */
export const MAX_DESCRIPTION_LENGTH = 20_000;
/** Most tags allowed on one node. */
export const MAX_TAGS = 32;
/** Longest accepted single tag. */
export const MAX_TAG_LENGTH = 48;
/** Most attachment references allowed on one node. */
export const MAX_ATTACHMENTS = 32;
/** Longest accepted attachment reference. */
export const MAX_ATTACHMENT_LENGTH = 2_000;
/** Longest accepted node/edge id. */
export const MAX_ID_LENGTH = 128;
/** Most ids accepted by one `kg_get` call. */
export const MAX_GET_IDS = 50;

const RELATION_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/;

/**
 * Case-folded comparison form. Used for search and duplicate detection only;
 * the stored text keeps its original spelling.
 * @param value - any value; non-strings are stringified.
 * @returns the NFC-normalized, lowercased, trimmed text.
 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFC')
    .toLowerCase()
    .trim();
}

/**
 * Reject a non-object argument in a way the model can act on.
 * @param value - candidate value.
 * @param label - argument path used in the message.
 * @returns the same value, narrowed.
 */
export function asObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GraphError('invalid_args', `\`${label}\` must be an object.`);
  }
  return value;
}

/**
 * Read an optional array argument.
 * @param value - candidate value; `undefined` means "not supplied".
 * @param label - argument path used in the message.
 * @returns the array, or an empty array.
 */
export function arrayOrEmpty(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new GraphError('invalid_args', `\`${label}\` must be an array.`);
  return value;
}

/**
 * Validate a required id.
 * @param value - candidate id.
 * @param label - argument path used in the message.
 * @returns the trimmed id.
 */
export function requiredId(value, label) {
  const id = optionalId(value);
  if (id === undefined) throw new GraphError('invalid_args', `\`${label}\` must be a non-empty string.`);
  return id;
}

/**
 * Validate an optional id.
 * @param value - candidate id; `undefined` means "not supplied".
 * @returns the trimmed id, or undefined.
 */
export function optionalId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new GraphError('invalid_args', 'Node and edge ids must be strings.');
  const id = value.trim();
  if (id.length === 0) throw new GraphError('invalid_args', 'Ids must not be empty.');
  if (id.length > MAX_ID_LENGTH) {
    throw new GraphError('invalid_args', `Ids must be at most ${MAX_ID_LENGTH} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(id))
    throw new GraphError('invalid_args', 'Ids must not contain control characters.');
  return id;
}

/**
 * Validate a node type against the enum.
 * @param value - candidate type.
 * @returns the type.
 */
export function validateType(value) {
  if (typeof value !== 'string' || !NODE_TYPE_SET.has(value)) {
    throw new GraphError('invalid_type', '`type` must be one of ' + [...NODE_TYPE_SET].join(', ') + '.');
  }
  return value;
}

/**
 * Validate a single type or an array of types.
 * @param value - candidate type or type array.
 * @param label - argument path used in the message.
 * @returns a deduplicated list of types, or undefined when not supplied.
 */
export function validateTypeList(value, label) {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const types = [];
  for (const entry of list) {
    const type = validateType(entry);
    if (!types.includes(type)) types.push(type);
  }
  return types.length > 0 ? types : undefined;
}

/**
 * Validate and canonicalize a node name.
 * @param value - candidate name.
 * @returns the trimmed name.
 */
export function validateName(value) {
  if (typeof value !== 'string') throw new GraphError('invalid_args', '`name` must be a string.');
  const name = value.trim();
  if (name.length === 0) throw new GraphError('invalid_args', '`name` must not be empty.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new GraphError('invalid_args', '`name` must be at most ' + MAX_NAME_LENGTH + ' characters.');
  }
  return name;
}

/**
 * Validate a description.
 * @param value - candidate description.
 * @returns the description.
 */
export function validateDescription(value) {
  if (typeof value !== 'string') throw new GraphError('invalid_args', '`description` must be a string.');
  if (value.length > MAX_DESCRIPTION_LENGTH) {
    throw new GraphError(
      'invalid_args',
      '`description` must be at most ' + MAX_DESCRIPTION_LENGTH + ' characters.'
    );
  }
  return value;
}

/**
 * Validate tags: lowercased, trimmed, deduplicated, sorted.
 *
 * The canonical form keeps tag filters and `kg_overview` counts stable; the
 * display form is therefore lowercase too.
 * @param value - candidate tag array.
 * @returns the canonical tag array.
 */
export function validateTags(value) {
  if (!Array.isArray(value)) throw new GraphError('invalid_args', '`tags` must be an array of strings.');
  /** @type {Map<string, string>} */
  const byKey = new Map();
  for (const entry of value) {
    if (typeof entry !== 'string') throw new GraphError('invalid_args', 'Every tag must be a string.');
    const tag = entry.trim().toLowerCase();
    if (tag.length === 0) continue;
    if (tag.length > MAX_TAG_LENGTH) {
      throw new GraphError('invalid_args', 'Tags must be at most ' + MAX_TAG_LENGTH + ' characters.');
    }
    const key = normalizeText(tag);
    if (!byKey.has(key)) byKey.set(key, tag);
  }
  const tags = [...byKey.values()].sort();
  if (tags.length > MAX_TAGS)
    throw new GraphError('invalid_args', 'At most ' + MAX_TAGS + ' tags are allowed.');
  return tags;
}

/**
 * Validate tag filters: trimmed, lowercased, deduplicated.
 * @param value - candidate tag array.
 * @param label - argument path used in the message.
 * @returns the canonical filter list, or undefined when empty.
 */
export function validateTagFilter(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new GraphError('invalid_args', '`' + label + '` must be an array of strings.');
  const tags = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new GraphError('invalid_args', 'Every entry in `' + label + '` must be a string.');
    }
    const tag = normalizeText(entry);
    if (tag.length > 0 && !tags.includes(tag)) tags.push(tag);
  }
  return tags.length > 0 ? tags : undefined;
}

/**
 * Validate attachment references. Absolute paths and `file:`/`http:`/`https:`
 * URLs are kept verbatim; any other path is resolved against the calling
 * session's working directory, so a stored reference never depends on where a
 * later session happens to run.
 * @param value - candidate attachment array.
 * @param cwd - directory used to resolve relative paths.
 * @returns the canonical attachment array.
 */
export function validateAttachments(value, cwd) {
  if (!Array.isArray(value))
    throw new GraphError('invalid_args', '`attachments` must be an array of strings.');
  const attachments = [];
  for (const entry of value) {
    if (typeof entry !== 'string') throw new GraphError('invalid_args', 'Every attachment must be a string.');
    const text = entry.trim();
    if (text.length === 0) continue;
    if (text.length > MAX_ATTACHMENT_LENGTH) {
      throw new GraphError(
        'invalid_args',
        'Attachments must be at most ' + MAX_ATTACHMENT_LENGTH + ' characters.'
      );
    }
    const canonical = normalizeAttachment(text, cwd);
    if (!attachments.includes(canonical)) attachments.push(canonical);
  }
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new GraphError('invalid_args', 'At most ' + MAX_ATTACHMENTS + ' attachments are allowed.');
  }
  return attachments;
}

/**
 * Keep URLs as written, make local paths absolute.
 * @param text - non-empty trimmed reference.
 * @param cwd - directory used for relative paths.
 * @returns the canonical reference.
 */
export function normalizeAttachment(text, cwd) {
  let url;
  try {
    url = new URL(text);
  } catch {
    url = undefined;
  }
  if (
    url !== undefined &&
    (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:')
  ) {
    return url.href;
  }
  if (isAbsolute(text)) return text;
  return resolve(cwd ?? process.cwd(), text);
}

/**
 * Validate a relation label.
 * @param value - candidate label.
 * @returns the label.
 */
export function validateRelation(value) {
  if (typeof value !== 'string' || !RELATION_PATTERN.test(value)) {
    throw new GraphError(
      'invalid_relation',
      '`relation` must be a lowercase snake_case label such as `works_for` (letters, digits, `_`, `:`, `-`).'
    );
  }
  return value;
}

/**
 * Validate an optional relation allowlist.
 * @param value - candidate list.
 * @param label - argument path used in the message.
 * @returns the list, or undefined when empty.
 */
export function validateRelationList(value, label) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new GraphError('invalid_args', '`' + label + '` must be an array of relation labels.');
  const relations = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new GraphError('invalid_args', 'Every entry in `' + label + '` must be a non-empty string.');
    }
    const relation = entry.trim();
    if (!relations.includes(relation)) relations.push(relation);
  }
  return relations.length > 0 ? relations : undefined;
}

/**
 * Validate an optimistic-concurrency revision.
 * @param value - candidate revision; `undefined` means "do not check".
 * @returns the revision, or undefined.
 */
export function expectedRevision(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new GraphError('invalid_args', '`expected_revision` must be a positive integer.');
  }
  return value;
}

/**
 * Validate one ISO-8601 timestamp and normalize it to UTC.
 *
 * Normalizing matters: changelog bounds are compared as strings in SQL, which
 * is only correct when every stored value shares the `Z` form.
 * @param value - candidate timestamp.
 * @param label - argument path used in the message.
 * @returns the UTC ISO string, or undefined when not supplied.
 */
export function validateTimestamp(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GraphError('invalid_args', '`' + label + '` must be an ISO 8601 timestamp string.');
  }
  const time = Date.parse(value.trim());
  if (!Number.isFinite(time)) {
    throw new GraphError(
      'invalid_args',
      '`' + label + '` must be a valid ISO 8601 timestamp, e.g. 2026-09-20T00:00:00Z.'
    );
  }
  return new Date(time).toISOString();
}

/**
 * Validate a changelog operation filter.
 * @param value - candidate operation list.
 * @returns the operations, or undefined when empty.
 */
export function validateOperations(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new GraphError('invalid_args', '`operations` must be an array.');
  const operations = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !HISTORY_OPERATIONS.includes(entry)) {
      throw new GraphError(
        'invalid_args',
        '`operations` must be a subset of ' + HISTORY_OPERATIONS.join(', ') + '.'
      );
    }
    if (!operations.includes(entry)) operations.push(entry);
  }
  return operations.length > 0 ? operations : undefined;
}

/**
 * Validate a sort key.
 * @param value - candidate sort key.
 * @returns the key, or undefined when not supplied.
 */
export function validateSortKey(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !SORT_KEYS.includes(value)) {
    throw new GraphError('invalid_args', '`sort_by` must be one of ' + SORT_KEYS.join(', ') + '.');
  }
  return value;
}

/**
 * Validate a merge description strategy.
 * @param value - candidate strategy.
 * @returns the strategy, or undefined when not supplied.
 */
export function validateDescriptionStrategy(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DESCRIPTION_STRATEGIES.includes(value)) {
    throw new GraphError(
      'invalid_args',
      '`description_strategy` must be one of ' + DESCRIPTION_STRATEGIES.join(', ') + '.'
    );
  }
  return value;
}

/**
 * Validate the node fields of one create or update operation.
 * @param input - raw argument object.
 * @param options - `partial` keeps omitted fields untouched.
 * @param options.partial - whether missing fields mean "leave unchanged".
 * @param options.cwd - directory used for relative attachment paths.
 * @returns only the fields that were supplied.
 */
export function nodeFields(input, { partial, cwd }) {
  const fields = {};
  if (input.name !== undefined) fields.name = validateName(input.name);
  else if (!partial) throw new GraphError('invalid_args', 'A new node requires `name`.');

  if (input.type !== undefined) fields.type = validateType(input.type);
  else if (!partial) throw new GraphError('invalid_args', 'A new node requires `type`.');

  if (input.tags !== undefined) fields.tags = validateTags(input.tags);
  else if (!partial) fields.tags = [];

  if (input.description !== undefined) fields.description = validateDescription(input.description);
  else if (!partial) fields.description = '';

  if (input.attachments !== undefined) fields.attachments = validateAttachments(input.attachments, cwd);
  else if (!partial) fields.attachments = [];

  return fields;
}

/**
 * Validate the mutable fields of one edge.
 * @param input - raw argument object.
 * @param options - `partial` keeps omitted fields untouched.
 * @param options.partial - whether missing fields mean "leave unchanged".
 * @param options.defaultRelation - relation used by a create with none supplied.
 * @returns only the fields that were supplied.
 */
export function edgeFields(input, { partial, defaultRelation }) {
  const fields = {};
  if (input.relation !== undefined) fields.relation = validateRelation(input.relation);
  else if (!partial) fields.relation = defaultRelation;

  if (input.description !== undefined) fields.description = validateDescription(input.description);
  else if (!partial) fields.description = '';

  return fields;
}
