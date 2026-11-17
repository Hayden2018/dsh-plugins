/**
 * Preset-side system-prompt gate for the bundled Custom mode.
 *
 * The Custom agent preset mounts this row so its prompt contains exactly what
 * Custom System Prompt supplies for the mode and nothing else. The editor
 * publishes that text as the `custom_system_prompt` prompt variable, resolved
 * per assembly from the Agent's live preset and the plugin's current config;
 * this row reads the resolved value and returns it as the only section.
 *
 * Reading the variable — instead of the editor's per-agent captured section —
 * keeps the mode correct regardless of when the editor attached to the Agent,
 * across profile reloads, and after a preset switch on a blank session.
 *
 * The listener is prepended so it sees the final assembly after every other
 * listener has contributed, then drops everything but the editor's text.
 */

import { SECTION_NAME } from './sections.js';

/** Cordis plugin name for loader diagnostics. */
export const name = 'prompt-editor-gate';

/** The prompt registry owns the assembly this row rewrites. */
export const inject = ['systemPrompt'];

/** Prompt variable the editor publishes; the gate renders only this text. */
export const PROMPT_VARIABLE = 'custom_system_prompt';

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
          sections: resolved.length > 0 ? [{ name: SECTION_NAME, text: resolved, interpolate: false }] : [],
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
