# DeepSeek Harness Personal Plugin Collection

This repository is a personal collection of plugins designed for **DeepSeek Harness (DSH)**. Every plugin in this workspace was built through a human-spec, agent-implemented workflow: the requirements, architecture, edge cases, and behavioral boundaries are defined in detail by me, while the actual implementation is mostly done by the **DeepSeek V4.1 Flash (1017 checkpoint)** model running inside DeepSeek Harness itself.

---

## Plugins

### `dsh-playwright`

A major rewrite of [`whklwhkl/dsh-playwright`](https://github.com/whklwhkl/dsh-playwright) providing browser automation for DeepSeek Harness powered directly by `playwright-core` in the Host process, with no external bridge service required. It provides a suite of `browser_*` tools for navigating pages, clicking and filling elements, evaluating JavaScript, extracting raw text or HTML, managing tabs, and capturing screenshots. Beyond launching an isolated Chromium instance on demand, it can attach at runtime over CDP to an already-running Chrome or Edge browser—reusing your active logins, cookies, extensions, and open tabs without restarting the harness. It also ships with an on-demand `playwright-browser-tips` skill backed by a structured site map for per-site tactics and selector recovery, while leaving CAPTCHAs and anti-bot challenges strictly to the user.

### `dsh-knowledge-graph`

A profile-local, persistent knowledge graph backed by Node's built-in `node:sqlite` paired with an in-memory graph engine. The graph is hydrated into memory at startup for fast, zero-I/O parallel reads, while writes validate first and commit atomically to SQLite alongside an append-only revision changelog. It models typed entities (such as people, facts, projects, concepts, and documents) connected by directed, labeled edges that allow multiple distinct relationships between the same pair of nodes. Agents get 10 `kg_*` tools for cold-start overviews, ranked search, relational queries, batch creates/updates, entity merging, changelog inspection, ASCII neighborhood trees, and shortest-path tracing, paired with a Web UI panel for storage status and two-step data purge.

### `dsh-prompt-editor`

A Web UI settings panel and Host prompt injector for customizing system prompts per agent mode (preset). It previews any mode's assembled system prompt read-only on the Host without spawning a session, and lets you append custom mode-specific instructions (or sync them across all modes) that are automatically attached to new and resumed sessions.

### `dsh-truncate-session`

Adds a **Truncate** (scissors) button to the assistant action bar on completed turns before the end of a conversation. Clicking it rewinds the session in one step: it forks the transcript at that turn, switches immediately to the new fork while keeping the original title, archives the old session, and restores the dropped user prompt into the input box if only the last turn was cut.

### `dsh-archive-purge`

Adds an **Archive cleanup** tab to the Plugins page to reclaim disk space from archived session logs. It displays total count and disk usage for all archived sessions as well as those inactive for 7+ days, with two-step confirmation buttons to permanently delete either set while safely skipping live sessions.

---

## Installation Guide

### Prerequisites

- **Node.js**: `>= 22.19.0` (required by `node:sqlite` in `dsh-knowledge-graph` and the local UI bundles; `dsh-playwright` supports `>= 20.0.0`).
- **pnpm**: Required for installing package dependencies before linking local checkouts.

### 1. Prepare Plugin Dependencies

For plugins that declare runtime dependencies (`dsh-playwright`, `dsh-knowledge-graph`, and `dsh-prompt-editor`), install their dependencies inside each plugin directory first:

```bash
cd dsh-playwright && pnpm install
```

If you plan to let `dsh-playwright` launch its own Chromium browser rather than attaching to an existing Chrome/Edge instance via `PW_CDP_ENDPOINT` or `PW_CHROMIUM_PATH`, download the matching Chromium build once:

```bash
cd dsh-playwright
pnpm exec playwright-core install chromium
```

### 2. Install into a DeepSeek Harness Profile

#### Option A: Using the `dsh` CLI

Add any plugin directory to your target profile (for example, `web`):

```bash
# Install a plugin into the "web" profile
dsh plugin --profile web add /path/to/dsh-plugins/dsh-playwright
dsh plugin --profile web add /path/to/dsh-plugins/dsh-knowledge-graph
dsh plugin --profile web add /path/to/dsh-plugins/dsh-prompt-editor
dsh plugin --profile web add /path/to/dsh-plugins/dsh-truncate-session
dsh plugin --profile web add /path/to/dsh-plugins/dsh-archive-purge
```

For local development, prefix the path with `link:` to symlink the checkout into the profile:

```bash
dsh plugin --profile web add link:/path/to/dsh-plugins/dsh-playwright
```

Restart DeepSeek Harness after CLI installation so the profile loads the newly added bundles.

#### Option B: Inside a Running Harness Session

From within a DeepSeek Harness session (with `danger-full-access` or approval enabled), ask the agent to install any plugin directory using the built-in `plugin_manager` tool:

```json
{
  "action": "install_bundle",
  "target": "/path/to/dsh-plugins/dsh-knowledge-graph"
}
```

Live profiles apply `install_bundle` changes immediately without requiring a server restart.
