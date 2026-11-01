/**
 * Shared vocabulary for the knowledge graph.
 *
 * A node is one entity (person, fact, project, ...); an edge is one directed,
 * described relation between two nodes, identified by the triple
 * `(from_id, relation, to_id)` so the same pair may hold several relations.
 * Exactly three application tables exist: `node`, `edge`, and the append-only
 * `history` changelog.
 */

/** The closed set of node kinds written to the `type` column. */
export const NODE_TYPES = Object.freeze([
  'fact',
  'person',
  'item',
  'event',
  'quote',
  'organization',
  'place',
  'concept',
  'project',
  'document',
  'task',
  'other',
]);

/** Fast membership test for the type enum. */
export const NODE_TYPE_SET = new Set(NODE_TYPES);

/** Relation used when the caller does not name one. */
export const DEFAULT_RELATION = 'related_to';

/** Direction options shared by the reading tools. */
export const DIRECTIONS = Object.freeze(['outgoing', 'incoming', 'both']);

/** Orderings accepted by `kg_search` and `kg_query`. */
export const SORT_KEYS = Object.freeze(['relevance', 'updated_at', 'created_at', 'name', 'degree']);

/** Changelog operations recorded by `history`. */
export const HISTORY_OPERATIONS = Object.freeze(['create', 'update', 'delete', 'merge']);

/** How `kg_merge` combines two descriptions. */
export const DESCRIPTION_STRATEGIES = Object.freeze(['keep_target', 'replace_with_source', 'append']);

/** Maximum value accepted by `kg_draw_graph`'s hop parameter. */
export const MAX_DRAW_HOPS = 3;

/**
 * An expected, user-correctable failure. The message is model-facing text, so
 * it names what was wrong and what to do instead.
 */
export class GraphError extends Error {
  /**
   * @param code - stable machine code, e.g. `not_found` or `revision_conflict`.
   * @param message - one sentence naming the problem and the fix.
   * @param details - optional structured extras recorded on the error.
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'GraphError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
