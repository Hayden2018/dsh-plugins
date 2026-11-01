/**
 * Truncate-session Client half.
 *
 * One action in the finalized-assistant action strip, beside the shipped
 * branch control. The branch control owns the transcript tail, so this one is
 * offered on every earlier completed turn and hidden at the tail: it forks the
 * Session at that turn's `turn/end` boundary (the same boundary the branch
 * control sends), selects the fork, then archives the original — a truncation
 * that stays recoverable, because archive keeps the log.
 *
 * When the cut takes exactly one prompt with it — the clicked assistant
 * message is then the model message just before the Session's last user
 * message — that prompt returns to the fork's input box, so a retry keeps the
 * user's own words. The test is positional on purpose: an answer that is
 * already streaming is still an answer, and must not cancel the restore.
 *
 * Ordering matters: the fork is selected before the source is archived, since
 * archiving the selected Session clears the main panel.
 */

window.__ModuleLoader__.load({
  id: 'dsh-truncate-session',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'truncateSession';
    const ACTION_ID = 'truncate-session';
    const SLOT = 'conversation.chat.assistant-actions';

    const en = {
      action: 'Truncate here',
      actionWithPrompt: 'Truncate here and put your last prompt back in the input box',
      actionRunning: 'Truncate here (stops the running turn in this Session)',
      errorGeneric: 'Could not truncate the Session.',
      errorUnavailable: 'This Session has no completed turn to cut at.',
      errorMigration: 'Open this Session to finish migrating it before branching.',
      errorNotFound: 'This Session no longer exists.',
      restoreFailed: 'Truncated, but the last prompt could not be put back in the input box.',
      archiveFailed: 'Truncated and opened the new Session, but the original could not be archived:',
    };

    const zh = {
      action: '截断到这里',
      actionWithPrompt: '截断到这里，并把最后一条提问放回输入框',
      actionRunning: '截断到这里（会停止本会话正在运行的回合）',
      errorGeneric: '无法截断会话。',
      errorUnavailable: '该会话没有可用的已完成回合用于截断。',
      errorMigration: '请先打开该会话完成迁移，然后再分叉。',
      errorNotFound: '该会话已不存在。',
      restoreFailed: '已截断，但最后一条提问未能放回输入框。',
      archiveFailed: '已截断并打开新会话，但原会话未能归档：',
    };

    // The row's own metrics: copied from the shipped action strip so the new
    // control is the same 28px hit target with the same glyph size, hover
    // fill, and unavailable treatment. Only alias tokens are required;
    // documented fallbacks keep it rendering after a token rename.
    const STYLES = `
      .dts-action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: calc(28px + var(--dsh-content-font-delta, 0px));
        height: calc(28px + var(--dsh-content-font-delta, 0px));
        padding: 6px;
        border: none;
        border-radius: var(--dsw-radius-sm, 6px);
        background: transparent;
        color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        cursor: pointer;
      }
      .dts-action svg {
        width: calc(17px + var(--dsh-content-font-delta, 0px));
        height: calc(17px + var(--dsh-content-font-delta, 0px));
        display: block;
      }
      @media (hover: hover) {
        .dts-action:hover {
          background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));
          color: var(--dsw-alias-label-secondary);
        }
      }
      .dts-action:focus-visible {
        outline: 2px solid var(--dsw-alias-brand-primary);
        outline-offset: 1px;
      }
      .dts-action[data-unavailable] {
        cursor: default;
        opacity: 0.4;
      }
      @media (hover: hover) {
        .dts-action[data-unavailable]:hover {
          background: transparent;
          color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary));
        }
      }
    `;

    /** Chat rows that only frame a Turn, so they never count as dropped content. */
    const CHROME_KINDS = { 'turn-tail': true, 'turn-process': true, 'turn-max-tokens': true };

    /**
     * The Turn-tail record owning one finalized assistant message.
     * @param snapshot - current Chat snapshot.
     * @param messageId - durable message id handed to this slot entry.
     * @returns its `turn/end` cut seq and the closing message seq, or undefined.
     */
    function tailOf(snapshot, messageId) {
      const timeline = snapshot === undefined || snapshot === null ? undefined : snapshot.timeline;
      const turns = timeline === undefined ? undefined : timeline.turns;
      if (turns === undefined || turns.size === 0) return undefined;
      for (const turn of turns.values()) {
        const data = turn === undefined ? undefined : turn.data;
        const tail = data === undefined || typeof data.get !== 'function' ? undefined : data.get('turn-tail');
        const closing = tail === undefined || tail === null ? undefined : tail.closing;
        const finalNode = closing === undefined || closing === null ? undefined : closing.finalNode;
        if (finalNode === undefined || finalNode === null) continue;
        if (finalNode.messageId !== messageId) continue;
        return { seq: tail.seq, closingSeq: finalNode.seq };
      }
      return undefined;
    }

    /**
     * Loaded Chat rows after one closing assistant message, in order.
     * @param snapshot - current Chat snapshot.
     * @param closingSeq - the closing assistant message seq.
     * @returns rows that would be dropped by a cut at the Turn boundary.
     */
    function laterNodes(snapshot, closingSeq) {
      const out = [];
      const order = snapshot === undefined || snapshot === null ? undefined : snapshot.order;
      if (order === undefined) return out;
      for (const key of order) {
        const node = snapshot.nodes.get(key);
        if (node === undefined) continue;
        if (CHROME_KINDS[node.kind] === true) continue;
        if ((node.anchorSeq === undefined ? -1 : node.anchorSeq) <= closingSeq) continue;
        out.push(node);
      }
      return out;
    }

    /** @returns the `turn/end` seq to cut at, or undefined when this row is not a Turn tail. */
    function cutSeqOf(snapshot, messageId) {
      const tail = tailOf(snapshot, messageId);
      return tail === undefined ? undefined : tail.seq;
    }

    /** @returns whether anything would actually be dropped at this Turn. */
    function hasLaterOf(snapshot, messageId) {
      const tail = tailOf(snapshot, messageId);
      return tail === undefined ? false : laterNodes(snapshot, tail.closingSeq).length > 0;
    }

    /** @param data - one Chat row payload. @returns its plain text, or an empty string. */
    function textOf(data) {
      const content = data === undefined || data === null ? undefined : data.content;
      if (!Array.isArray(content)) return '';
      const parts = [];
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue;
        if (block.type !== 'text' || typeof block.text !== 'string') continue;
        if (block.text.trim() === '') continue;
        parts.push(block.text);
      }
      return parts.join('\n').trim();
    }

    /**
     * The prompt this cut would drop, when the cut takes exactly one prompt
     * with it: the clicked assistant message is then the model message just
     * before the Session's last user message, which is the definition.
     *
     * Deliberately positional. An earlier version also required that no
     * assistant row followed, which silently refused whenever that last
     * prompt was already being answered — a streaming attempt is an assistant
     * row, so the very case the restore exists for was the case it skipped.
     * A dropped tail with two prompts is a longer rewind, so it restores none.
     * @returns that prompt, or an empty string when nothing should be restored.
     */
    function restorePromptOf(snapshot, messageId) {
      const tail = tailOf(snapshot, messageId);
      if (tail === undefined) return '';
      const prompts = laterNodes(snapshot, tail.closingSeq).filter((node) => node.kind === 'user');
      return prompts.length === 1 ? textOf(prompts[0].data) : '';
    }

    /** Scissors: the universal "cut here" mark, and clearly not the branch glyph. */
    function IconScissors() {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
        },
        h('circle', { cx: 5.9, cy: 6.1, r: 2.8 }),
        h('circle', { cx: 5.9, cy: 17.9, r: 2.8 }),
        h('path', { d: 'M19.6 4.4 8.1 15.9' }),
        h('path', { d: 'M14.4 14.4 19.6 19.6' }),
        h('path', { d: 'M8.1 8.1 11.9 11.9' })
      );
    }

    /**
     * One truncate control, offered only where there is something to cut: the
     * shipped branch control owns the transcript tail, so this one is absent
     * there rather than present-but-disabled.
     * @param props - owner message id, Session hooks, locale, and the action face.
     * @returns the control, or nothing when this Turn cannot be truncated.
     */
    function TruncateAction({ messageId, useChat, useSession, useAccess, t, truncate }) {
      const [busy, setBusy] = React.useState(false);
      const cut = useChat((snapshot) => cutSeqOf(snapshot, messageId));
      const hasLater = useChat((snapshot) => hasLaterOf(snapshot, messageId));
      const restore = useChat((snapshot) => restorePromptOf(snapshot, messageId));
      const running = useSession((snapshot) => snapshot !== undefined && snapshot.running === true);
      const allowed = useAccess('session/fork');
      // Hidden without `session/fork` (the shipped branch control hides itself
      // too) and hidden at the transcript tail, where there is nothing to cut.
      if (!allowed || cut === undefined || !hasLater) return null;
      const title = restore !== '' ? t('actionWithPrompt') : running ? t('actionRunning') : t('action');
      return h(
        'button',
        {
          type: 'button',
          className: 'dts-action',
          'aria-label': t('action'),
          'aria-disabled': busy || undefined,
          'data-unavailable': busy || undefined,
          title,
          onClick: busy
            ? undefined
            : () => {
                setBusy(true);
                void Promise.resolve()
                  .then(() => truncate(cut, restore))
                  .catch((error) => {
                    console.warn('truncate session rejected:', error);
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              },
        },
        h(IconScissors)
      );
    }

    /** @param error - any thrown value. @returns its message text. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /**
     * Show one notice on the Session's own composer, which is the shipped
     * surface for a failed user action in this area.
     * @param ctx - Client context.
     * @param sessionId - Session whose composer should report it.
     * @param level - notice severity.
     * @param text - already-localized notice body.
     */
    function notify(ctx, sessionId, level, text) {
      try {
        const binding = ctx.sessions.binding(sessionId);
        const scope = binding !== undefined && binding !== null ? binding.ctx : ctx.sessions.scope(sessionId);
        if (scope !== undefined && scope !== null) {
          ctx.conversation.input.for(scope).notify(level, text);
          return;
        }
      } catch (error) {
        console.warn('truncate-session: could not surface the notice:', error);
      }
      console.warn(`truncate-session: ${text}`);
    }

    /**
     * The one failure wording a fork refusal gets.
     * @param t - bound translator.
     * @param error - the rejected fork.
     * @returns localized, caller-ready text.
     */
    function forkFailureText(t, error) {
      const code =
        error !== null && typeof error === 'object'
          ? error.rpcError === undefined || error.rpcError === null
            ? error.code
            : error.rpcError.code
          : undefined;
      if (code === 'session/migration-required') return t('errorMigration');
      if (code === 'session/fork-unavailable') return t('errorUnavailable');
      if (code === 'session/not-found') return t('errorNotFound');
      return code === undefined ? t('errorGeneric') : `${t('errorGeneric')} (${String(code)})`;
    }

    /** @param ms - delay in milliseconds. @returns a promise that settles after it. */
    function delay(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    /** @param input - the Session input resolver. @param binding - the fork's binding. @returns its draft text, or null when unreadable. */
    function draftOf(input, binding) {
      try {
        return input.for(binding.ctx).state.getSnapshot().draft;
      } catch (error) {
        return null;
      }
    }

    /**
     * Put the prompt into the new Session's input box, surviving a composer
     * that has not mounted yet: the write is attempted again while the box
     * stays empty, and read back each time, because a write accepted by a
     * shell that the composer then replaces would otherwise be lost silently.
     * Anything the user has already typed is left alone.
     * @param ctx - Client context.
     * @param sessionId - the fork.
     * @param prompt - the prompt to adopt.
     * @returns 'applied', 'kept' (the box already had text), or 'failed'.
     */
    async function seedPrompt(ctx, sessionId, prompt) {
      const input = ctx.conversation.input;
      const options = { prompt, whenDraftExists: 'replace' };
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const binding = ctx.sessions.binding(sessionId);
        if (binding !== undefined) {
          const current = draftOf(input, binding);
          if (current === prompt) return 'applied';
          if (current !== null && current !== '') return 'kept';
          try {
            if (input.requestDraftInitialization(binding, options) === 'applied') {
              const after = draftOf(input, binding);
              if (after === prompt || after === null) return 'applied';
            }
          } catch (error) {
            // The composer is not addressable yet; the next attempt retries.
          }
        }
        await delay(attempt === 0 ? 0 : 120);
      }
      return 'failed';
    }

    /**
     * Fork at the cut, select the fork, archive the source, and put the
     * dropped prompt back. Every later step is reported without undoing the
     * earlier ones: the fork is what the user asked for, and archiving keeps
     * the source log.
     * @param ctx - Client context.
     * @param sessionId - the Session being truncated.
     * @param atSeq - the inclusive `turn/end` boundary to keep.
     * @param restorePrompt - prompt text to put in the fork's input box, or ''.
     * @returns the outcome kind, for the caller's busy state only.
     */
    async function runTruncate(ctx, sessionId, atSeq, restorePrompt) {
      const t = ctx.locale.bind(NS);
      let childId;
      try {
        childId = await ctx.sessions.fork({ sessionId, atSeq });
      } catch (error) {
        notify(ctx, sessionId, 'error', forkFailureText(t, error));
        return 'fork-failed';
      }

      // Select the fork first: archiving the currently selected Session is what
      // would blank the main panel.
      ctx.uiWorkspace.openSession(childId);

      // Seed while the archive's Host round-trip runs: the draft write belongs
      // to the new composer and should not wait on the old Session's cleanup.
      const seeding =
        restorePrompt === '' ? Promise.resolve('skipped') : seedPrompt(ctx, childId, restorePrompt);

      let archived = true;
      try {
        // Stop whatever still runs in the source: everything from this Turn on
        // is being dropped, so stopping is the intent, and it avoids the
        // archive's "running work" refusal.
        await ctx.uiWorkspace.archiveSession(sessionId, { stopActivity: true });
      } catch (error) {
        archived = false;
        notify(ctx, childId, 'error', `${t('archiveFailed')} ${messageOf(error)}`);
      }

      const seeded = await seeding;
      if (seeded === 'failed') notify(ctx, childId, 'error', t('restoreFailed'));

      return archived ? 'ok' : 'archive-failed';
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace', 'conversation'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'truncate-session: dictionaries');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-dsh-truncate-session', '');
          style.textContent = STYLES;
          document.head.append(style);
          return () => {
            style.remove();
          };
        }, 'truncate-session: action styles');
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: ACTION_ID,
              // Sits inside the assistant tail's icon row, between copy and the
              // shipped branch control (which draws extra actions in that gap).
              order: 5,
              locale: NS,
              inject: (sessionId) => ({
                truncate: (atSeq, restorePrompt) => runTruncate(ctx, sessionId, atSeq, restorePrompt),
              }),
            },
            TruncateAction
          )
        );
      },
    };
  },
});
