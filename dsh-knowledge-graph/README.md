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

## Graph visualization (right Sidebar)

The Web client registers a `knowledge-graph` page in the right Sidebar. Open it
from the Sidebar's add control and pick the **Knowledge graph** guide card (or
`ctx.sidebarRight.openTab('knowledge-graph')` from another client plugin).

The page is read-only outside its inspector editors. It uses five same-origin
routes, all guarded by the same connection check as the maintenance route:

| Route                                                                | Purpose                                                                                 |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `GET /knowledge-graph/graph`                                         | Compact snapshot: nodes with type, tags and degree, plus relation previews.             |
| `GET /knowledge-graph/node?id=<id>`                                  | One entity's full record: description, tags, attachments, both edge directions, degree. |
| `POST /knowledge-graph/node`                                         | Create, update, or delete one entity.                                                   |
| `GET /knowledge-graph/edge?from_id=<id>&relation=<label>&to_id=<id>` | One relation's full description, timestamps, revision, and endpoint summaries.          |
| `POST /knowledge-graph/edge`                                         | Create, rename, or delete one relation.                                                 |

The node route dispatches on `x-dsh-kg-action`:

- `create` takes `{ "name": "...", "type": "...", "tags": [...], "description": "..." }`
  and lets the store generate the stable id.
- `update` takes `{ "id": "...", "expected_revision": 10, "patch": { ... } }`.
  Only `name`, `type`, `tags`, and `description` may appear in the patch.
- `delete` takes `{ "id": "...", "expected_revision": 10 }` and optionally
  `cascade_edges: true`. Without cascade, an entity with relations is refused
  with `409 has_edges`; with cascade, those relations are removed too while
  neighbouring entities stay.

All three `x-dsh-kg-session` headers are optional and feed the changelog writer.
The writes go through the same `GraphStore.save`/`remove` paths as the agent
tools, so revision checks, atomic commits, and changelog behavior are preserved.
A stale revision returns `409 revision_conflict`.

The edge mutation route dispatches on `x-dsh-kg-action`:

- `create` takes `{ "from_id": "...", "to_id": "...", "relation": "...", "description": "..." }`.
- `update` takes the original `from_id`, `relation`, and `to_id`, plus
  `expected_revision`, and optionally `new_relation` and/or `description`.
- `delete` takes the exact triple plus `expected_revision`.

The Web route refuses a rename that would land on another relation already
stored on the same directed pair, returning `409 already_exists` before writing.
That guard is deliberately Web-only; the model-facing `kg_save` behavior is
unchanged. All successful edge mutations go through the store's normal atomic
commit and changelog path.

The snapshot never carries full node descriptions, and edge descriptions are
clipped to a 600-character preview. The inspector fetches the selected entity or
relation (descriptions are clipped at 40,000 and 20,000 characters respectively),
then caches entities for the life of the panel.

### Configuration

| Field           | Default | Meaning                                                  |
| --------------- | ------- | -------------------------------------------------------- |
| `maxGraphNodes` | `2000`  | Entities one snapshot may include, highest degree first. |
| `maxGraphEdges` | `8000`  | Relations one snapshot may include.                      |

Raise these if the partial-view banner appears and the browser remains
comfortable; the canvas is client-rendered, so very large graphs trade memory
for completeness. The existing `kg_draw_graph` tool remains the token-bounded
text view for agents.

## Maintenance panel

The bundle row's configure page shows the resolved directory, file presence,
size, entity, relation, and changelog counts, and the schema version. **Purge
graph data** requires a second click and deletes the shared database directory
for every profile; the next write recreates it lazily, so purging before
uninstalling leaves no files behind. A purge reports `purge_blocked` while
another profile keeps the database open.

Purge is user-only: it is not exposed as an agent tool.

## Building the Web client

`dist/client.js` is generated; do not edit it by hand. Its source lives in
`src/client/`:

| Path                              | Role                                                                        |
| --------------------------------- | --------------------------------------------------------------------------- |
| `src/client/index.jsx`            | Locale dictionaries, tab-type registration, slot registrations, guide card. |
| `src/client/GraphPanel.jsx`       | The right-Sidebar canvas, toolbar, inspector drawers, and panel CSS.        |
| `src/client/graph-style.js`       | Type colours and the Cytoscape style sheet for light/dark.                  |
| `src/client/graph-engine.js`      | Cytoscape import and one-time fcose registration.                           |
| `src/client/MaintenancePanel.jsx` | The bundle row's storage/purge page.                                        |

The build exists because the visualization bundles **Cytoscape 3** and
**cytoscape-fcose**, while React remains external (the DSH client module table
provides `react` and `react/jsx-runtime`). The output is wrapped in the same
`window.__ModuleLoader__.load({ id, factory })` envelope the first-party client
packages emit, so the Host serves it exactly like any other client half. The
generated `dist/client.js` is roughly 600 KB minified.

```bash
pnpm install
pnpm build      # writes dist/client.js
pnpm watch      # rebuilds dist/client.js on source changes
```

`dist/` is ignored by Git; only `src/client/` is source. A fresh checkout has
no browser bundle until the build runs. `pnpm pack` also runs the `prepack`
script, so a tarball always contains `dist/client.js`. Do not commit the old
root-level `client.js`; it is a legacy build output and is ignored too.

pnpm may report `Ignored build scripts: esbuild` during install; esbuild's
platform binary is installed as an optional dependency and the build still
runs. If it does not, run `pnpm approve-builds` and allow `esbuild`.

`esbuild`, `cytoscape`, and `cytoscape-fcose` are `devDependencies` because they
are compiled into `dist/client.js`; the installed plugin needs only Node's
built-in `node:sqlite`. `package.json` keeps `./client` pointing at
`dist/client.js`, and `dsh.client.inject` now includes the Sidebar and theme
client packages.

After changing the Host half (`index.js`), reload the plugin (or restart DSH) so
the new routes are mounted; the Web client reloads `dist/client.js` independently
and can otherwise run against the previous Host route shape.
