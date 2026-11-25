# DeepSeek Harness Personal Plugin Collection

This repository is a personal collection of seven plugins designed for **DeepSeek Harness (DSH)**. Every plugin in this workspace was built through a human-spec, agent-implemented workflow: the requirements, architecture, edge cases, and behavioral boundaries are defined in detail by me, while the actual implementation is mostly done by the **DeepSeek V4.1 Flash (1017 checkpoint)** model running inside DeepSeek Harness itself.

---

## Plugins

### `dsh-playwright`

A major rewrite of [`whklwhkl/dsh-playwright`](https://github.com/whklwhkl/dsh-playwright) providing browser automation for DeepSeek Harness powered directly by `playwright-core` in the Host process, with no external bridge service required. It provides a suite of `browser_*` tools for navigating pages, clicking and filling elements, evaluating JavaScript, extracting raw text or HTML, managing tabs, and capturing screenshots. Beyond launching an isolated Chromium instance on demand, it can attach at runtime over CDP to an already-running Chrome or Edge browser—reusing your active logins, cookies, extensions, and open tabs without restarting the harness. It also ships with an on-demand `playwright-browser-tips` skill backed by a structured site map for per-site tactics and selector recovery, while leaving CAPTCHAs and anti-bot challenges strictly to the user.

### `dsh-knowledge-graph`

An installation-wide, persistent knowledge graph backed by Node's built-in `node:sqlite` paired with an in-memory graph engine. One SQLite database (under the harness home by default) is shared by every session and profile of the installation; the graph is hydrated into memory at startup for fast, zero-I/O parallel reads, while writes validate first and commit atomically to SQLite alongside an append-only revision changelog. It models typed entities (such as people, facts, projects, concepts, and documents) connected by directed, labeled edges that allow multiple distinct relationships between the same pair of nodes. Agents get 10 `kg_*` tools covering cold-start overviews, ranked search, relational queries, full-record reads, atomic batch writes, deletion, entity merging, changelog inspection, ASCII neighborhood trees, and shortest-path tracing. The Web client adds a right-Sidebar graph panel rendered with Cytoscape and bounded by configurable node and edge limits, while the bundle's page reports storage status and offers a two-step graph purge.

### `dsh-custom-sys-prompt`

A Web UI settings panel and Host prompt injector for customizing system prompts per agent mode (preset). It previews any mode's assembled system prompt read-only on the Host without spawning a session, and lets you append custom mode-specific instructions (or sync them across all modes) that are automatically attached to new and resumed sessions. The bundle also ships two gated modes: **Agent** (`custom`), a copy of the shipped Standard composition with no base system prompt, and **Chat** (`chat`), a deliberately small composition limited to `web_search`, `web_fetch`, the `kg_*` tools, and `generate_image` for chat-style research and image generation. Both modes render the editor's text as the `custom_system_prompt` prompt variable through the gate (`dsh-custom-sys-prompt/gate`), so each mode follows the live config and composition rather than a creation-time capture. With no editor text the request carries no system prompt, and with text that text is the entire system prompt. `AGENTS.md` and the runtime-context reminder still arrive as user-role messages.

### `dsh-gemini-image`

Adds one model-facing `generate_image` tool for generating and editing images with Google's **Gemini Nano Banana 2.1** model, using the `GOOGLE_API_KEY` credential the profile already stores for its Google chat provider (configurable through the plugin's `credentialRef`). A call takes a prompt, one of 14 aspect ratios, `1K` or `2K` output, and up to four reference images for character or product consistency or to edit an existing image. The JPEG is written to the package's `generated/` folder and attached to the transcript so a vision-capable model sees it. To keep context predictable, only the newest generated image stays in context by default—older images become placeholder text in later requests while their files remain on disk—and a plugin setting can keep every generated image instead. Requires DSH `0.2.3-alpha.2` or newer.

### `dsh-file-io`

Adds two-way file transfer between a remote browser and the Sidebar. Every file the document preview renders—PDF, XLSX, DOCX, images, HTML, Markdown, text, or media—gains a **Download** action that streams it as an attachment through an authenticated `/api/file-download` route, in chunks and with `Range` support so an interrupted transfer resumes; the empty "unpreviewable" state gets the same button. The files page gains an upload control that sends one file (up to 100 MiB) into the directory it displays through `/api/file-upload`: the route confines the destination to the Session workspace, stages the body and renames it into place so no partial entry appears, refuses to overwrite an existing name, and allows one upload per Session at a time. Derived from [`dsh-file-download`](https://github.com/wilsonchengassistant/dsh-file-download) by Wilson Cheng; this bundle adds the upload direction.

### `dsh-truncate-session`

Adds a **Truncate** (scissors) button to the assistant action bar on every completed turn except the current tail. Clicking it rewinds the session in one step: it forks the transcript at that turn, switches immediately to the new fork while keeping the original title, archives the old session, and restores the dropped user prompt into the input box when the cut takes exactly that one prompt. The original log stays on disk and can be unarchived from the sidebar.

### `dsh-archive-purge`

Adds an **Archive cleanup** tab to the Plugins page to reclaim disk space from archived session logs. It shows the total count and on-disk size of all archived sessions as well as those whose latest log write is 7+ days old, with two-step confirmation buttons to permanently delete either set. A purge unloads idle resident sessions first and skips sessions with a running turn or a log held by another writer; shared content-addressed attachments are left in place.
