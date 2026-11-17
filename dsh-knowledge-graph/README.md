# dsh-knowledge-graph

An installation-wide knowledge graph for DeepSeek Harness. Entities, directed
relations, and a changelog live in one SQLite database built from Node's
`node:sqlite`; the graph is held in memory for reads, and SQLite is touched only
to hydrate at startup, to commit a write, and to read history. Every profile and
session of the same harness home shares the graph.

## Storage

Default location:

```text
<DSH_HOME>/knowledge-graph/graph.sqlite
```

Overrides, highest priority first:

1. `dataDir` in this plugin's Config (relative paths resolve against the profile).
2. `$DSH_KNOWLEDGE_GRAPH_DIR`.
3. The harness home above.

The database is shared by every session and every profile of the installation.
It survives restarts, plugin reloads, and plugin removal; only the maintenance
panel's **Purge graph data** action deletes it.

When one profile writes, another profile's store reloads before its next read
(`PRAGMA data_version`). Writes take SQLite's `BEGIN IMMEDIATE` lock before
planning, so two profiles cannot commit a plan derived from stale state. A
second writer waits up to the configured `busy_timeout` and then reports
`storage_busy` rather than overwriting.

### Migration from the profile-local layout

Earlier versions kept `graph.sqlite` under
`<profile>/data/dsh-knowledge-graph`. On first start at the new location the
plugin picks the richest non-empty legacy database across the installation,
copies it with `VACUUM INTO` (including the write-ahead log), validates it, and
publishes it atomically. The legacy files are renamed with a
`.migrated-YYYY-MM-DD` suffix instead of deleted. A lock serializes two profiles
starting at once, and nothing is imported once the shared database exists, so a
later purge is never undone by a restart.

## Tables

Three application tables exist.

`node` — `id`, `name`, `type`, `tags` (JSON array), `description`,
`attachments` (JSON array), `created_at`, `updated_at`,
`created_by_session_id`, `updated_by_session_id`, `revision`.

`edge` — `from_id`, `relation`, `to_id`, `description`, `created_at`,
`updated_at`, `updated_by_session_id`, `revision`; primary key
`(from_id, relation, to_id)`, so one entity pair may hold several relations in
the same direction (`colleague_of` and `dated`, say).

`history` — append-only changelog: global `seq`, `timestamp`, `session_id`,
`target_kind` (`node`/`edge`), `target_key` (node id, or the JSON triple for an
edge), `operation` (`create`/`update`/`delete`/`merge`), `revision`, and
`before_snapshot`/`after_snapshot` JSON. Every write, delete, and merge appends
its rows in the same transaction as the data it describes, so a committed graph
and its changelog never disagree. The changelog grows with every mutation; the
maintenance panel shows its entry count.

Tags are stored lowercased, deduplicated, and sorted.

Types: `fact`, `person`, `item`, `event`, `quote`, `organization`, `place`,
`concept`, `project`, `document`, `task`, `other`.

## Tools

| Tool            | Purpose                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `kg_overview`   | Cold-start summary: totals, type counts, tags and relation labels in use, hubs by degree, orphans.          |
| `kg_search`     | Ranked search: name → tag → description, exact → prefix → substring; type/tag filters, sorting, pagination. |
| `kg_query`      | Filter by attributes plus an incident-relation constraint, optionally hydrated.                             |
| `kg_get`        | Full records by id, complete descriptions, complete relations.                                              |
| `kg_save`       | Atomic create/update batches for entities and relations.                                                    |
| `kg_delete`     | Explicit deletion by id or by relation triple.                                                              |
| `kg_merge`      | Merge or rename one entity, rewiring its relations.                                                         |
| `kg_history`    | Per-entity revision history, or a graph-wide changelog diff.                                                |
| `kg_draw_graph` | Tree-like text drawing of a neighborhood, up to 3 hops.                                                     |
| `kg_trace_node` | One shortest path between two entities.                                                                     |

Reads run entirely in memory and reload first when another profile committed.
Writes validate and plan under SQLite's write lock, commit in one transaction,
and only then update memory, so a failed write leaves both sides unchanged.

`kg_get` never truncates a stored description; the rendered text is capped only
by `maxGetChars` (200,000 characters by default), and hitting that cap is
reported in the text.

## Upgrading

Schema generation 2 is the first release with the composite edge key and the
changelog. A generation-1 database is upgraded in one transaction on first open:
the edge table is rebuilt, `node.created_by_session_id` is backfilled from
`updated_by_session_id`, and the changelog starts empty. A failed upgrade rolls
back and leaves the file untouched, and the tools then report a storage fault
instead of guessing.

## Maintenance panel

The bundle row's configure page shows the resolved directory, file presence,
size, entity, relation, and changelog counts, and the schema version. **Purge
graph data** requires a second click and deletes the shared database directory
for every profile; the next write recreates it lazily, so purging before
uninstalling leaves no files behind. A purge reports `purge_blocked` while
another profile keeps the database open.

Purge is user-only: it is not exposed as an agent tool.

## Limits

`kg_save`, `kg_delete`, and `kg_merge` are exclusive; the read tools may run in
parallel. `kg_draw_graph` caps nodes, edges, per-node neighbours, and characters,
and reports every cap it hit. `kg_trace_node` reports `not_found_within_hops` when
a longer path may exist and `no_path` only after exhausting the reachable graph.
`kg_history` scans at most 5,000 changelog rows per call and reports when a
result was truncated.
