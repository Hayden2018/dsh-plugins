/** Playwright host plugin: compose one browser session with the public tools. */
import fs from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { createBrowserSession } from './browser-session.js';
import { createOperations } from './operations.js';
import { SHOT_DIR } from './settings.js';
import { registerBrowserTools } from './tool-definitions.js';
import { AUTO_APPROVE_SUPPORTED } from './win-cdp-auto-approve.js';

export const name = 'playwright-browser';
export const inject = ['tools'];

// No volatile field on unsupported hosts means no settings namespace or toggle,
// regardless of the OS of the phone/browser displaying the Harness page.
export const Config = z.object(
  AUTO_APPROVE_SUPPORTED
    ? {
        attemptAutoApprove: z
          .boolean()
          .default(false)
          .volatile()
          .description('Attempt auto approve on browser attachment'),
      }
    : {}
);

export function apply(ctx, config = {}) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const session = createBrowserSession({
    autoApprove: () => AUTO_APPROVE_SUPPORTED && config.attemptAutoApprove?.get() === true,
    onAutoApproveError: (error) => ctx.logger.warn('Chrome auto-approval unavailable: %s', error.message),
  });
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber));
  });
  // A connected user's browser is only detached; only our own instance is quit.
  ctx.effect(() => () => session.disconnect());
  registerBrowserTools(ctx, createOperations(ctx, session));
}
