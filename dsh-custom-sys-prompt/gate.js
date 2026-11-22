/**
 * Preset-side system-prompt gate for the bundled gated modes (Agent and
 * Chat).
 *
 * Each gated preset mounts this row so its prompt contains exactly what Custom
 * System Prompt supplies for the mode and nothing else. The editor publishes
 * that text as the `custom_system_prompt` prompt variable, resolved per
 * assembly from the Agent's live preset and the plugin's current config; this
 * row reads the resolved value and returns it as the only section.
 *
 * Reading the variable — instead of the editor's per-agent captured section —
 * keeps a mode correct regardless of when the editor attached to the Agent,
 * across profile reloads, and after a preset switch on a blank session. Because
 * the variable resolves through the Agent's composed preset, the same row and
 * the same variable serve every gated mode: Agent renders its entry in
 * the plugin's `prompts` map and Chat renders its own.
 *
 * The listener is prepended so it sees the final assembly after every other
 * listener has contributed, then drops everything but the editor's text.
 *
 * The variable name is written literally here and in `index.js` rather than
 * imported: a live profile re-imports edited plugin modules individually, so a
 * new named export shared between them cannot always be re-linked without a
 * restart. Keep the two literals identical.
 */

import { SECTION_NAME } from './sections.js';

/** Cordis plugin name for loader diagnostics. */
export const name = 'prompt-editor-gate';

/** The prompt registry owns the assembly this row rewrites. */
export const inject = ['systemPrompt'];

/** Prompt variable the editor publishes; the gate renders only this text. */
export const PROMPT_VARIABLE = 'custom_system_prompt';

/**
 * Placement of the gate's sole contribution.
 *
 * An assembled section's `order` is copied into the admitted `system/message`
 * source metadata. That payload must be losslessly JSON-serializable, so an
 * omitted order becomes an `undefined` property and the first turn fails with
 * "session event \"system/message\" carries non-JSON-serializable data".
 * Keep this finite and aligned with the editor's appended-section placement.
 */
const SECTION_ORDER = 20_000;

/**
 * Replace the whole prompt with the editor's text for the mode.
 * @param ctx - preset scope context; the listener is admitted for this scope
 *   and its descendant agent scopes.
 */
export function apply(ctx) {
  ctx.on(
    'system-prompt/assemble',
    async (_assembly, _context, next) => {
      const assembly = await next();
      // The editor publishes this variable on every assembly once it is mounted,
      // even when the mode has no text. Its presence is therefore authoritative:
      // an empty value means "no prompt", not "fall back to a captured section".
      if (Object.hasOwn(assembly.variables, PROMPT_VARIABLE)) {
        const text = assembly.variables[PROMPT_VARIABLE];
        const resolved = typeof text === 'string' ? text : '';
        return {
          ...assembly,
          sections: resolved.length > 0
            ? [{ name: SECTION_NAME, order: SECTION_ORDER, text: resolved, interpolate: false }]
            : [],
        };
      }
      // Older/disabled editor without the variable: keep whatever its per-agent
      // section captured, if any.
      return {
        ...assembly,
        sections: assembly.sections.filter(
          (section) => section.name === SECTION_NAME && section.text.length > 0
        ),
      };
    },
    { prepend: true }
  );
}
