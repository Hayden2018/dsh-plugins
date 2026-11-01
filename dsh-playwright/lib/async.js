import { RTT_BUDGET_MS } from './settings.js';

function abortError() {
  const error = new Error('aborted: the turn was interrupted');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal) {
  if (signal && signal.aborted) throw abortError();
}

export function withAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(abortError());
  }

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // This settles the caller promptly; it does not forcibly stop the underlying operation.
  // Promise.race keeps late rejections handled, while finally removes the abort listener.
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

export function withBudget(promise, ms, fallback) {
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => value,
      () => fallback
    ),
    expired,
  ]).finally(() => clearTimeout(timer));
}

export async function titleOf(page, signal) {
  throwIfAborted(signal);
  let timer;
  let timedOut = false;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve('');
    }, RTT_BUDGET_MS);
  });
  const titlePromise = Promise.resolve()
    .then(() => page.title())
    .then(
      (title) => String(title || ''),
      (error) => {
        throwIfAborted(signal);
        return '';
      }
    );
  try {
    const title = await withAbort(Promise.race([titlePromise, expired]), signal);
    return { title, unresponsive: timedOut };
  } finally {
    clearTimeout(timer);
  }
}
