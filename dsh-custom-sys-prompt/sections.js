/**
 * Shared identity of the prompt-editor addition.
 *
 * The Host half registers its per-mode text under this section name, and the
 * preset gate keeps that name. One constant keeps the two from drifting.
 */

/** Section name of the per-mode addition appended by this plugin. */
export const SECTION_NAME = 'prompt-editor:appended';
