import { chromium } from 'playwright-core';
import {
  BROWSER_LOCALE,
  CDP_ENDPOINT,
  CDP_PAGE,
  CHROMIUM_PATH,
  CLOSE_BUDGET_MS,
  CONNECT_TIMEOUT_MS,
  RTT_BUDGET_MS,
} from './settings.js';
import { cdpCandidates, diagnoseEndpoint } from './cdp.js';
import { throwIfAborted, titleOf, withAbort, withBudget } from './async.js';

function supersededError() {
  return new Error('Browser setup was superseded by a newer session operation');
}

export function createBrowserSession() {
  let browser = null;
  let page = null;
  let context = null;
  let mode = 'none';
  let attachedEndpoint = null;
  let endpointOverride;
  let generation = 0;
  const matchedHints = new WeakMap();

  function resolveEndpoint() {
    return (endpointOverride !== undefined ? endpointOverride : CDP_ENDPOINT) || null;
  }

  function clearState() {
    const previous = { browser, mode };
    browser = null;
    page = null;
    context = null;
    mode = 'none';
    attachedEndpoint = null;
    return previous;
  }

  function assertCurrent(token, signal) {
    throwIfAborted(signal);
    if (token !== generation) throw supersededError();
  }

  function disposeOnce(dispose) {
    let disposed = false;
    return async (resource) => {
      if (disposed) return;
      disposed = true;
      try {
        await dispose(resource);
      } catch {
        // Cleanup is best-effort; setup errors remain the reported failure.
      }
    };
  }

  async function closeBrowserBounded(target, signal) {
    if (!target) return;
    const closing = Promise.resolve()
      .then(() => target.close())
      .catch(() => undefined);
    const bounded = withBudget(closing, CLOSE_BUDGET_MS, undefined);
    if (signal) await withAbort(bounded, signal);
    else await bounded;
  }

  async function closePageBounded(target) {
    if (!target) return;
    await withBudget(
      Promise.resolve()
        .then(() => target.close())
        .catch(() => undefined),
      CLOSE_BUDGET_MS,
      undefined
    );
  }

  async function closeContextBounded(target) {
    if (!target) return;
    await withBudget(
      Promise.resolve()
        .then(() => target.close())
        .catch(() => undefined),
      CLOSE_BUDGET_MS,
      undefined
    );
  }

  async function rollbackBrowser(target, signal, token) {
    if (!target) return;
    if ((signal && signal.aborted) || token !== generation) {
      // Cleanup continues safely in the background, while the cancelled/stale call settles now.
      void closeBrowserBounded(target);
      return;
    }
    const cleanup = closeBrowserBounded(target);
    if (signal) {
      try {
        await withAbort(cleanup, signal);
      } catch {
        // Preserve the original setup error; the bounded cleanup continues in the background.
      }
    } else {
      await cleanup;
    }
  }

  async function rollbackContext(target, signal, token) {
    if (!target) return;
    if ((signal && signal.aborted) || token !== generation) {
      void closeContextBounded(target);
      return;
    }
    const cleanup = closeContextBounded(target);
    if (signal) {
      try {
        await withAbort(cleanup, signal);
      } catch {
        // Preserve the original setup error; the bounded cleanup continues in the background.
      }
    } else {
      await cleanup;
    }
  }

  async function acquire(factory, signal, token, dispose) {
    throwIfAborted(signal);
    const cleanup = disposeOnce(dispose);
    let abandoned = false;
    const pending = Promise.resolve().then(() => {
      assertCurrent(token, signal);
      return factory();
    });
    pending.then(
      (resource) => {
        if (abandoned || (signal && signal.aborted) || token !== generation) {
          void cleanup(resource);
        }
      },
      () => {}
    );
    try {
      const resource = await withAbort(pending, signal);
      if ((signal && signal.aborted) || token !== generation) {
        abandoned = true;
        void cleanup(resource);
        assertCurrent(token, signal);
      }
      return resource;
    } catch (error) {
      abandoned = true;
      // The pending operation may have resolved just before the abort race rejected.
      pending.then(
        (resource) => cleanup(resource),
        () => {}
      );
      throw error;
    }
  }

  async function pickAttachedPage(targetContext, hint, strict, signal) {
    throwIfAborted(signal);
    const needle = hint || CDP_PAGE;
    const pages = targetContext.pages().filter((candidate) => !candidate.isClosed());
    if (!pages.length) {
      if (strict && hint !== undefined) throw new Error(`no tab matching: ${hint}`);
      return null;
    }
    if (needle) {
      let unresponsive = 0;
      for (const candidate of pages) {
        throwIfAborted(signal);
        const { title, unresponsive: stuck } = await titleOf(candidate, signal);
        if (stuck) unresponsive++;
        if (`${candidate.url()} ${title}`.includes(needle)) {
          matchedHints.set(candidate, needle);
          return candidate;
        }
      }
      if (strict && hint) {
        throw new Error(
          `no tab matching: ${hint}` +
            (unresponsive ? ` (${unresponsive} tab(s) did not respond, so a match cannot be ruled out)` : '')
        );
      }
    }
    const web = pages.filter((candidate) => /^https?:/.test(candidate.url()));
    const pool = web.length ? web : pages;
    return pool[pool.length - 1];
  }

  async function createPage(targetContext, signal, token) {
    const created = await acquire(() => targetContext.newPage(), signal, token, closePageBounded);
    try {
      assertCurrent(token, signal);
      return created;
    } catch (error) {
      // The page exists but must never escape a stale setup; do not delay abort settlement.
      void closePageBounded(created);
      throw error;
    }
  }

  async function publishPage(created, token, signal) {
    try {
      assertCurrent(token, signal);
    } catch (error) {
      void closePageBounded(created);
      throw error;
    }
    page = created;
    return created;
  }

  async function launchBrowser(signal, token) {
    const launchOptions = {
      headless: process.env.PW_HEADLESS !== 'false',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    };
    if (CHROMIUM_PATH) launchOptions.executablePath = CHROMIUM_PATH;

    let localBrowser;
    try {
      localBrowser = await acquire(() => chromium.launch(launchOptions), signal, token, closeBrowserBounded);
      assertCurrent(token, signal);
      const localContext = await acquire(
        () =>
          localBrowser.newContext({
            viewport: { width: 1280, height: 800 },
            locale: BROWSER_LOCALE,
          }),
        signal,
        token,
        closeContextBounded
      );
      const localPage = await createPage(localContext, signal, token);
      assertCurrent(token, signal);
      browser = localBrowser;
      context = localContext;
      page = localPage;
      mode = 'launched';
      attachedEndpoint = null;
      return localPage;
    } catch (error) {
      await rollbackBrowser(localBrowser, signal, token);
      throw error;
    }
  }

  async function attachBrowser(endpoint, hint, strict, signal, token) {
    const candidates = cdpCandidates(endpoint);
    if (!candidates.length) {
      throw new Error(
        `No usable CDP endpoint from ${endpoint}. For a channel name, open chrome://inspect/#remote-debugging and enable "Allow remote debugging for this browser instance" first.`
      );
    }
    const tried = [];
    for (const candidate of candidates) {
      assertCurrent(token, signal);
      let localBrowser;
      try {
        localBrowser = await acquire(
          () => chromium.connectOverCDP(candidate, { timeout: CONNECT_TIMEOUT_MS }),
          signal,
          token,
          closeBrowserBounded
        );
      } catch (error) {
        assertCurrent(token, signal);
        const { blob, stopRetrying } = await diagnoseEndpoint(candidate, error, signal);
        assertCurrent(token, signal);
        tried.push(`${candidate}:\n${blob}`);
        if (stopRetrying) break;
        continue;
      }

      let localContext;
      let ownsContext = false;
      try {
        assertCurrent(token, signal);
        localContext = localBrowser.contexts()[0] || null;
        if (!localContext) {
          try {
            localContext = await acquire(() => localBrowser.newContext(), signal, token, closeContextBounded);
            ownsContext = true;
          } catch (error) {
            assertCurrent(token, signal);
            localContext = null;
          }
        }
        if (!localContext) {
          await rollbackBrowser(localBrowser, signal, token);
          assertCurrent(token, signal);
          tried.push(`${candidate}:\nconnected but no browser context`);
          continue;
        }
        const localPage = await pickAttachedPage(localContext, hint, strict, signal);
        assertCurrent(token, signal);
        browser = localBrowser;
        context = localContext;
        page = localPage;
        mode = 'attached';
        attachedEndpoint = candidate;
        return localPage;
      } catch (error) {
        if (ownsContext) await rollbackContext(localContext, signal, token);
        await rollbackBrowser(localBrowser, signal, token);
        throw error;
      }
    }
    throw new Error(`CDP attach failed (tried ${tried.length} endpoint(s)):\n${tried.join('\n')}`);
  }

  async function ensurePage(signal) {
    throwIfAborted(signal);
    if (browser && !browser.isConnected()) {
      const token = ++generation;
      const previous = clearState();
      await closeBrowserBounded(previous.browser, signal);
      assertCurrent(token, signal);
    }

    if (browser && browser.isConnected() && context) {
      const token = generation;
      if (page && !page.isClosed()) return page;
      if (mode === 'attached') {
        const next = await pickAttachedPage(context, undefined, false, signal);
        assertCurrent(token, signal);
        if (next) {
          page = next;
          return next;
        }
        // An attached browser can legitimately have no tabs. Create one in its existing
        // context rather than reconnecting and prompting for CDP consent again.
        const created = await createPage(context, signal, token);
        return publishPage(created, token, signal);
      }
      if (mode === 'launched') {
        const created = await createPage(context, signal, token);
        return publishPage(created, token, signal);
      }
    }

    if (browser) {
      const token = ++generation;
      const previous = clearState();
      await closeBrowserBounded(previous.browser, signal);
      assertCurrent(token, signal);
    }

    const token = ++generation;
    const endpoint = resolveEndpoint();
    if (!endpoint) return launchBrowser(signal, token);
    const attachedPage = await attachBrowser(endpoint, undefined, false, signal, token);
    if (attachedPage) return attachedPage;
    assertCurrent(token, signal);
    const created = await createPage(context, signal, token);
    return publishPage(created, token, signal);
  }

  async function status(_args, signal) {
    throwIfAborted(signal);
    if (!browser || !browser.isConnected()) {
      const configured = resolveEndpoint();
      return {
        open: false,
        mode,
        endpoint: attachedEndpoint,
        configured,
        needAttach: !!configured,
      };
    }
    if (!page || page.isClosed()) {
      return {
        open: false,
        stalePage: true,
        mode,
        endpoint: attachedEndpoint,
        tabs: context ? context.pages().filter((candidate) => !candidate.isClosed()).length : 0,
      };
    }
    const { title, unresponsive } = await titleOf(page, signal);
    return {
      open: true,
      mode,
      endpoint: mode === 'attached' ? attachedEndpoint : null,
      matched: matchedHints.get(page) || null,
      url: page.url(),
      title,
      unresponsive,
      tabs: context ? context.pages().filter((candidate) => !candidate.isClosed()).length : 1,
    };
  }

  async function attach(args = {}, signal) {
    throwIfAborted(signal);
    const raw = args && args.endpoint !== undefined ? String(args.endpoint).trim() : '';
    if (raw === 'launch' || raw === 'off' || raw === 'local') {
      const token = ++generation;
      endpointOverride = null;
      const previous = clearState();
      await closeBrowserBounded(previous.browser, signal);
      assertCurrent(token, signal);
      return { launched: true };
    }

    const endpoint =
      raw || (mode === 'attached' && attachedEndpoint ? attachedEndpoint : CDP_ENDPOINT || 'auto');
    const hint = args && args.page !== undefined ? String(args.page) : undefined;
    const candidates = cdpCandidates(endpoint);
    const same =
      mode === 'attached' && browser && browser.isConnected() && candidates.includes(attachedEndpoint);
    const token = ++generation;
    endpointOverride = endpoint;

    if (same) {
      const next = await pickAttachedPage(context, hint, hint !== undefined, signal);
      assertCurrent(token, signal);
      if (next) {
        await withAbort(
          withBudget(
            Promise.resolve().then(() => next.bringToFront()),
            RTT_BUDGET_MS * 2,
            undefined
          ),
          signal
        );
        assertCurrent(token, signal);
        page = next;
      } else {
        page = null;
      }
    } else {
      const previous = clearState();
      await closeBrowserBounded(previous.browser, signal);
      assertCurrent(token, signal);
      await attachBrowser(endpoint, hint, hint !== undefined, signal, token);
    }

    const activePage = page;
    const title = activePage ? await titleOf(activePage, signal) : { title: '', unresponsive: false };
    assertCurrent(token, signal);
    return {
      attached: true,
      endpoint: attachedEndpoint,
      matched: activePage ? matchedHints.get(activePage) || null : null,
      url: activePage ? activePage.url() : '',
      title: title.title,
      unresponsive: title.unresponsive,
      tabs: context ? context.pages().filter((candidate) => !candidate.isClosed()).length : 0,
    };
  }

  async function tabs(args = {}, signal) {
    args = args || {};
    const hasIndex = args.index !== undefined && args.index !== null;
    const hasUrl = args.url !== undefined && args.url !== null;
    if (hasIndex && (!Number.isInteger(args.index) || args.index < 0)) {
      throw new Error('index must be a non-negative integer');
    }
    if (hasUrl && (typeof args.url !== 'string' || !args.url.trim())) {
      throw new Error('url must be a non-empty URL or title substring');
    }
    if (hasIndex && hasUrl) throw new Error('pass either index or url, not both');
    if (args.close && !hasIndex && !hasUrl) throw new Error('close:true requires index or url');

    await ensurePage(signal);
    throwIfAborted(signal);
    const pages = context.pages().filter((candidate) => !candidate.isClosed());
    if (hasIndex || hasUrl) {
      let target = null;
      let unresponsive = 0;
      if (hasIndex) {
        target = pages[Number(args.index)] || null;
        if (!target) throw new Error(`tab index out of range: ${args.index} (0-${pages.length - 1})`);
      } else {
        const needle = String(args.url);
        const firstUrlHit = pages.findIndex((candidate) => candidate.url().includes(needle));
        const scanEnd = firstUrlHit >= 0 ? firstUrlHit + 1 : pages.length;
        const titled = await Promise.all(
          pages.slice(0, scanEnd).map((candidate) => titleOf(candidate, signal))
        );
        throwIfAborted(signal);
        unresponsive = titled.filter((entry) => entry.unresponsive).length;
        const hit = pages
          .slice(0, scanEnd)
          .findIndex((candidate, index) => `${candidate.url()} ${titled[index].title}`.includes(needle));
        target = hit >= 0 ? pages[hit] : null;
        if (!target) {
          throw new Error(
            `no tab matching: ${args.url}` +
              (unresponsive
                ? ` (${unresponsive} tab(s) did not respond, so a match cannot be ruled out)`
                : '')
          );
        }
      }
      if (args.close) {
        if (target === page) page = null;
        let closeError = null;
        const outcome = await withAbort(
          withBudget(
            Promise.resolve()
              .then(() => target.close())
              .then(
                () => 'closed',
                (error) => {
                  closeError = error;
                  return 'error';
                }
              ),
            CLOSE_BUDGET_MS,
            'timeout'
          ),
          signal
        );
        if (outcome === 'closed') return { text: null, closed: true };
        if (outcome === 'timeout') return { text: null, closeTimedOut: true };
        return {
          text: null,
          closeFailed: closeError ? String(closeError.message || closeError) : 'unknown',
        };
      }
      page = target;
      await withAbort(
        withBudget(
          Promise.resolve().then(() => page.bringToFront()),
          RTT_BUDGET_MS * 2,
          undefined
        ),
        signal
      );
      const { title, unresponsive: stuck } = await titleOf(page, signal);
      return { switched: true, url: page.url(), title, unresponsive: stuck };
    }

    const titled = await Promise.all(pages.map((candidate) => titleOf(candidate, signal)));
    throwIfAborted(signal);
    const rows = pages.map((candidate, index) => ({
      index,
      url: candidate.url(),
      title: titled[index].title,
      unresponsive: titled[index].unresponsive,
      current: candidate === page,
    }));
    return { tabs: rows };
  }

  async function recoverWedgedPage(target, signal) {
    throwIfAborted(signal);
    if (mode === 'attached' && context) {
      const token = generation;
      const next = await createPage(context, signal, token);
      try {
        await withAbort(
          withBudget(
            Promise.resolve().then(() => next.bringToFront()),
            RTT_BUDGET_MS * 2,
            undefined
          ),
          signal
        );
        assertCurrent(token, signal);
        page = next;
      } catch (error) {
        // A cancelled bringToFront must not wait for a stuck page's close budget.
        void closePageBounded(next);
        throw error;
      }
      return;
    }
    if (target === page) page = null;
    await withAbort(
      withBudget(
        Promise.resolve().then(() => target.close()),
        CLOSE_BUDGET_MS,
        undefined
      ),
      signal
    );
  }

  async function disconnect(signal) {
    throwIfAborted(signal);
    generation++;
    const previous = clearState();
    await closeBrowserBounded(previous.browser, signal);
    return previous.mode;
  }

  return { ensurePage, status, attach, tabs, recoverWedgedPage, disconnect };
}
