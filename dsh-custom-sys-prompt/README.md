# Custom System Prompt (`dsh-custom-sys-prompt`)

A Settings panel and Host system-prompt plugin for DeepSeek Harness that previews each agent mode's assembled system prompt and appends literal, mode-specific instructions for new and resumed sessions. The same bundle also declares the **Custom** agent mode, whose system prompt is exactly what the editor supplies for it.

## The bundled Custom mode

The bundle ships two patch files. `cordis.patch.yml` mounts the editor itself; `presets/custom.patch.yml` declares the `custom` agent preset (display name **Custom**, roster order `1.5`, right after Standard):

- It is a copy of the shipped `standard` preset's plugin list with an empty persona — when the shipped preset changes on a DSH upgrade, re-copy that list here.
- Its first row is `dsh-custom-sys-prompt/gate`. The Host half publishes the mode's text as the `custom_system_prompt` prompt variable, resolved for each assembly from the Agent's live composition and the plugin's current config; the gate renders that resolved value as the only section and drops every other contribution: harness identity, tool guidance, plan policy, and file-reference guidance. With no editor text the request carries no system prompt; with text, that text is the entire system prompt.
- The variable is read at assembly time, so the mode is correct even when the Agent was created before the editor mounted, survived a profile reload, or switched presets on a blank session.
- The declaration is disabled when the composition has no `agentPresets` service, so installing this bundle into another profile cannot leave a row waiting forever.

The editor also keeps its per-agent `prompt-editor:appended` section for the other modes (Standard, PTC, and so on); the Custom mode replaces the whole presentation with the variable's value. To stop using the mode without uninstalling the bundle, disable the `preset-custom-mode` row from the profile patch.

To opt into the mode, select **Custom** in the new-session mode chip or send `"agentPreset": "custom"` to a Webhook/SDK session request.

### What still reaches the model in Custom mode

Tool schemas (provider-owned, not prompt sections), the runtime-context `<system-reminder>` user message (working directory, permission/sandbox policy), `AGENTS.md` messages from `dsh-agent-instructions`, and periodic time-context messages remain. They are user-role context, not the system prompt.

## What it shows

Under the **Custom System Prompt** row on the Plugins page, the configuration view displays three cards:

1. **Agent mode** — A theme-styled mode picker (`HarnessSelect`, with a native `<select>` fallback inside a React error boundary) listing every registered agent preset from `agentPresets.list()`, by name only. A broken preset's diagnostic still appears beneath its name.
2. **Existing system prompt** — A read-only preview assembled on the Host by calling `/prompt-editor/preview?preset=<id>`. The Host acquires the preset's standing scope and calls `systemPrompt.assemble()` without creating a Session or Agent, fills default `provider` and `model` template variables when available, and reports section counts plus any unresolved `{{variable}}` placeholders.
3. **Additional instructions for this mode** — An editor for the literal text appended after all first-party system-prompt sections for the selected mode. If a mode uses a single monolithic complete prompt (`likelyComplete`), the editor card is hidden with an explanatory note.

For the **Custom** mode the preview shows no base sections, because the gate drops them at that scope too; the gate's kept section only exists once an Agent is created. The editor's text box is the source of truth for what the model receives.

## What it does

- **Host prompt injection (`prompt-editor:appended`)** — When an Agent is created (`agent/created`), the Host registers a prompt section at `order: 20000` with `interpolate: false` so braces (`{{...}}`) in user-authored instructions are treated as literal text rather than template variables.
- **Live text variable (`custom_system_prompt`)** — The Host publishes the selected mode's text as a prompt variable. Its provider runs once per assembly with that assembly's Agent, so it uses the live composition and the current config rather than the creation-time capture. The Custom mode's gate renders this value as its whole prompt, which also makes editor edits apply to ongoing sessions.
- **Preset gate (`dsh-custom-sys-prompt/gate`)** — The Custom mode's first row; replaces the assembled prompt with the `custom_system_prompt` variable's value. See above.
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
- The Custom mode's plugin list is a copy of the shipped `standard` preset. A DSH upgrade that adds or changes a row there is not reflected automatically.
- UI copy is provided in English and Chinese (`en` and `zh`).
