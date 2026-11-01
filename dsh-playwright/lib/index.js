/** Playwright host plugin: compose one browser session with the public tools. */
import fs from 'node:fs';
import { createBrowserSession } from './browser-session.js';
import { createOperations } from './operations.js';
import { SHOT_DIR } from './settings.js';
import { registerBrowserTools } from './tool-definitions.js';

export const name = 'playwright-browser';
export const inject = ['tools'];

export function apply(ctx) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const session = createBrowserSession();
  // A connected user's browser is only detached; only our own instance is quit.
  ctx.effect(() => () => session.disconnect());
  registerBrowserTools(ctx, createOperations(ctx, session));
}
