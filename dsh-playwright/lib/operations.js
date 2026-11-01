import { withAbort, throwIfAborted, titleOf } from './async.js';
import { captureScreenshot } from './screenshot.js';

function characterLimit(value, fallback) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('limit must be a non-negative integer');
  return limit;
}

/** Query without implicit waiting, preserving the existing missing-selector error. */
async function selectedElement(page, selector, signal) {
  throwIfAborted(signal);
  const pending = page.$(String(selector));
  let element;
  try {
    element = await withAbort(pending, signal);
  } catch (error) {
    // A query can finish after cancellation; dispose its eventual handle too.
    pending.then((late) => late && late.dispose()).catch(() => {});
    throw error;
  }
  if (!element) throw new Error(`selector not found: ${selector}`);
  return element;
}

/** Page actions return raw values; tool registration owns presentation. */
export function createOperations(ctx, session) {
  return {
    async open(args, signal) {
      const page = await session.ensurePage(signal);
      try {
        await page.goto(String(args.url), {
          waitUntil: args.waitUntil || 'domcontentloaded',
          timeout: args.timeout ?? 30000,
          signal,
        });
      } catch (error) {
        // Failed Chrome error-page navigations can wedge subsequent navigation.
        // Replace only on these failures, never on cancellation or plain timeout;
        // in attached mode recovery opens a new tab without closing the user's.
        const message = String((error && error.message) || error);
        if (!(signal && signal.aborted) && /net::ERR_|is interrupted by another navigation/.test(message)) {
          await session.recoverWedgedPage(page, signal).catch(() => {});
        }
        throw error;
      }
      const title = await titleOf(page, signal);
      return { url: page.url(), title: title.title, unresponsive: title.unresponsive };
    },
    status: (args, signal) => session.status(args, signal),
    attach: (args, signal) => session.attach(args, signal),
    tabs: (args, signal) => session.tabs(args, signal),
    async click(args, signal) {
      const page = await session.ensurePage(signal);
      await page.click(String(args.selector), { timeout: args.timeout ?? 10000, signal });
      return { ok: true };
    },
    async type(args, signal) {
      const page = await session.ensurePage(signal);
      await page.click(String(args.selector), { timeout: args.timeout ?? 10000, signal });
      await page.type(String(args.selector), String(args.text), {
        delay: args.delay ?? 0,
        timeout: args.timeout ?? 10000,
        signal,
      });
      return { ok: true };
    },
    async fill(args, signal) {
      const page = await session.ensurePage(signal);
      await page.fill(String(args.selector), String(args.text), {
        timeout: args.timeout ?? 10000,
        signal,
      });
      return { ok: true };
    },
    async press(args, signal) {
      const page = await session.ensurePage(signal);
      throwIfAborted(signal);
      await withAbort(page.keyboard.press(String(args.key)), signal);
      return { ok: true };
    },
    async wait(args, signal) {
      const page = await session.ensurePage(signal);
      throwIfAborted(signal);
      await withAbort(page.waitForTimeout(Number(args.ms ?? 1000)), signal);
      return { ok: true };
    },
    async extract(args, signal) {
      const limit = characterLimit(args.limit, 20000);
      const page = await session.ensurePage(signal);
      throwIfAborted(signal);
      let text;
      if (args.selector) {
        const element = await selectedElement(page, args.selector, signal);
        try {
          text = (await element.innerText({ signal })) || '';
        } finally {
          element.dispose().catch(() => {});
        }
      } else {
        text = await withAbort(
          page.evaluate(() => (document.body ? document.body.innerText : '')),
          signal
        );
      }
      return { text: String(text).slice(0, limit) };
    },
    async html(args, signal) {
      const limit = characterLimit(args.limit, 50000);
      const page = await session.ensurePage(signal);
      throwIfAborted(signal);
      let html;
      if (args.selector) {
        const element = await selectedElement(page, args.selector, signal);
        try {
          html = await withAbort(
            element.evaluate((node) => node.outerHTML),
            signal
          );
        } finally {
          element.dispose().catch(() => {});
        }
      } else {
        html = await withAbort(page.content(), signal);
      }
      return { html: String(html).slice(0, limit) };
    },
    async eval(args, signal) {
      const page = await session.ensurePage(signal);
      throwIfAborted(signal);
      const value = await withAbort(page.evaluate(String(args.expression)), signal);
      if (value !== null && typeof value === 'object') return { value: JSON.stringify(value) };
      return { value: String(value) };
    },
    async screenshot(args, signal) {
      const page = await session.ensurePage(signal);
      return captureScreenshot(ctx, page, args, signal);
    },
    async close(_args, signal) {
      const was = await session.disconnect(signal);
      return { ok: true, detached: was === 'attached' };
    },
  };
}
