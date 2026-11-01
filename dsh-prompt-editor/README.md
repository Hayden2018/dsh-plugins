# Prompt Editor (`dsh-prompt-editor`)

A Settings panel and Host system-prompt plugin for DeepSeek Harness that previews each agent mode's assembled system prompt and appends literal, mode-specific instructions for new and resumed sessions.

## What it shows

Under the **Prompt Editor** row on the Plugins page, the configuration view displays three cards:

1. **Agent mode** — A theme-styled mode picker (`HarnessSelect`, with a native `<select>` fallback inside a React error boundary) listing every registered agent preset from `agentPresets.list()`, badging the default mode and surfacing broken preset diagnostics. When agent presets are unavailable, it falls back to `Global (no preset)` (`*`).
2. **Existing system prompt** — A read-only preview assembled on the Host by calling `/prompt-editor/preview?preset=<id>`. The Host acquires the preset's standing scope and calls `systemPrompt.assemble()` without creating a Session or Agent, fills default `provider` and `model` template variables when available, and reports section counts plus any unresolved `{{variable}}` placeholders.
3. **Additional instructions for this mode** — An editor for the literal text appended after all first-party system-prompt sections for the selected mode. If a mode uses a single monolithic complete prompt (`likelyComplete`), the editor card is hidden with an explanatory note.

## What it does

- **Host prompt injection (`prompt-editor:appended`)** — When an Agent is created (`agent/created`), the Host registers a prompt section at `order: 20000` with `interpolate: false` so braces (`{{...}}`) in user-authored instructions are treated as literal text rather than template variables.
- **Blank-session preset switching** — Listens to `agent-preset/selected` so switching presets on a blank session immediately updates that session's captured prompt addition to match the newly selected mode.
- **Volatile live config** — Stores additions in `Config.prompts` (`z.dict(z.string()).default({}).volatile()`), allowing edits in the Web UI to take effect for subsequent sessions without remounting the plugin.
- **Save, Sync to all modes, and Clear** — Save updates only the selected mode; **Sync to all modes** writes the current draft across every listed agent preset in one config update (leaving unlisted/fallback keys untouched); **Clear addition** removes the entry for the current mode.

## Verification

Run syntax and smoke/client registration checks from this directory:

```bash
npm run check
npm test
```

## Limits

- The read-only preview shows `systemPrompt` sections only; tool schemas and dynamic turn/runtime context injected outside `systemPrompt` are not part of the preview.
- Changes apply to newly created or resumed sessions (and blank sessions that switch presets); already-running turns keep the prompt captured when their Agent was created.
- UI copy is provided in English and Chinese (`en` and `zh`).
