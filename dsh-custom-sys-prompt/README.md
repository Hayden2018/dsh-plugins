# Custom System Prompt (`dsh-custom-sys-prompt`)

A Settings panel and Host system-prompt plugin for DeepSeek Harness that previews each agent mode's assembled system prompt and appends literal, mode-specific instructions for new and resumed sessions. The same bundle declares the **Agent** and **Chat** agent modes, whose system prompts are exactly what the editor supplies for them.

## The bundled modes

The bundle ships three patch files. `cordis.patch.yml` mounts the editor itself; `presets/custom.patch.yml` declares the `custom` preset (display name **Agent**, roster order `1.5`, right after Standard); `presets/chat.patch.yml` declares the `chat` preset (display name **Chat**, roster order `1.6`).

Both modes are _gated_: their first row is `dsh-custom-sys-prompt/gate`. The Host half publishes the mode's text as the `custom_system_prompt` prompt variable, resolved for each assembly from the Agent's live composition and the plugin's current config; the gate renders that resolved value as the only section and drops every other contribution: harness identity, tool guidance, plan policy, and file-reference guidance. With no editor text the request carries no system prompt; with text, that text is the entire system prompt. Because the variable resolves through the Agent's composed preset, one variable and one gate row serve both modes — Agent renders its `prompts.custom` entry and Chat renders its `prompts.chat` entry.

### Agent

A copy of the shipped `standard` preset's plugin list with an empty persona — when the shipped preset changes on a DSH upgrade, re-copy that list here. Every standard tool, skill, plan mode, compaction, and delegation row stays.

### Chat

A deliberately small preset for chat-style research:

- **Tools: exactly three families.** `tool-web` mounts `web_search` and `web_fetch` in the preset's scope. The Knowledge Graph bundle's `kg_*` tools are kept because that bundle registers them at the composition root. `dsh-custom-sys-prompt/chat-tools` keeps only those families.
- **Knowledge Graph is optional.** Tools are kept by `kg_` name prefix, not by an enumerated list: without the Knowledge Graph bundle there is simply nothing to keep and nothing to ignore, and the preset still composes.

The editor also keeps its per-agent `prompt-editor:appended` section for the other modes (Standard, PTC, and so on); the gated modes replace the whole presentation with the variable's value. To stop using a mode without uninstalling the bundle, disable its row (`preset-custom-mode` or `preset-chat-mode`) from the profile patch.

### What still reaches the model in a gated mode

Tool schemas (provider-owned, not prompt sections), the runtime-context `<system-reminder>` user message (working directory, permission/sandbox policy), `AGENTS.md` messages from `dsh-agent-instructions`, and periodic time-context messages remain. They are user-role context, not the system prompt. In Chat, only the schemas of the tools that survived the filter (see above) are present.

## What it shows

Under the **Custom System Prompt** row on the Plugins page, the configuration view displays three cards:

1. **Agent mode** — A theme-styled mode picker (`HarnessSelect`, with a native `<select>` fallback inside a React error boundary) listing every registered agent preset from `agentPresets.list()`, by name only. A broken preset's diagnostic still appears beneath its name.
2. **Existing system prompt** — A read-only preview assembled on the Host by calling `/prompt-editor/preview?preset=<id>`. The Host acquires the preset's standing scope and calls `systemPrompt.assemble()` without creating a Session or Agent, fills default `provider` and `model` template variables when available, and reports section counts plus any unresolved `{{variable}}` placeholders.
3. **Additional instructions for this mode** — An editor for the literal text appended after all first-party system-prompt sections for the selected mode. If a mode uses a single monolithic complete prompt (`likelyComplete`), the editor card is hidden with an explanatory note.

For a gated mode the preview shows no base sections, because the gate drops them at that scope too; the gate's kept section only exists once an Agent is created. The editor's text box is the source of truth for what the model receives.

## Limits

- The read-only preview shows `systemPrompt` sections only; tool schemas and dynamic turn/runtime context injected outside `systemPrompt` are not part of the preview.
- Changes apply to newly created or resumed sessions (and blank sessions that switch presets); already-running turns keep the prompt captured when their Agent was created.
- The Agent mode's plugin list is a copy of the shipped `standard` preset. A DSH upgrade that adds or changes a row there is not reflected automatically.
- The Chat filter denies global tools by name, because the tool registry compiles a restriction when it is created. A tool registered later is caught by the `tools/change` sweep; a name already denied stays denied even if its tool unloads and returns.
- The filtered Chat executor is a subclass of the deployment's `NativeToolExecutor`, loaded from the installed Host. If that class cannot be resolved, the filter logs a warning and leaves Agent-scoped tools visible; the registry restriction and the execution guard still apply. A DSH upgrade that renames that export would need this row updated.
- UI copy is provided in English and Chinese (`en` and `zh`).
