/**
 * Truncate-session Host half.
 *
 * The capability is entirely a Client operation: it composes the public
 * Session Controller, Conversation, and Workspace services from the page
 * (fork at a turn boundary, open the fork, seed the restored prompt, archive
 * the source), so no Host route, tool, or service is registered here.
 */

/** @param _ctx - Host context; nothing is registered. */
export function apply(_ctx) {}
