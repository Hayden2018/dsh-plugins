/**
 * Archive purge Client half.
 *
 * One page, contributed as a Plugins-page tab: two counts (all archived
 * sessions, archived sessions inactive for the threshold) and two destructive
 * actions, each requiring a second click. Archive time is not stored by the
 * harness, so the page states plainly that the age test is the session log's
 * latest activity.
 *
 * Deletion is user-only; the page calls the plugin's authenticated Host
 * routes and never exposes an agent tool.
 */

window.__ModuleLoader__.load({
  id: 'dsh-archive-purge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'archivePurge';
    const STATUS_URL = '/archive-purge/status';
    const PURGE_URL = '/archive-purge/purge';
    const PURGE_HEADER = 'x-dsh-archive-purge';

    const en = {
      tab: 'Archive cleanup',
      lead: 'Delete the logs of archived sessions to reclaim disk space. Deletion is permanent, so both actions ask for a second confirmation.',
      definition:
        '“Archived” stores only the session id, not the date it was archived. The second number therefore counts archived sessions whose latest activity — the last write to the session log — is at least {days} days old. It is not the number of sessions archived {days} days ago.',
      definitionCutoff: 'Cutoff: last log write before {date}.',
      totalLabel: 'Archived sessions',
      totalHint: '{size} of session logs on disk.',
      staleLabel: 'Inactive for {days}+ days',
      staleHint: 'Last log write before {date}.',
      missingHint:
        '{count} archived ids have no log left on disk; purging all also clears their archive records.',
      purgeAllTitle: 'Purge every archived session',
      purgeAllHint:
        'Deletes all {count} archived session logs ({size}). Sessions that are in use are skipped.',
      purgeAll: 'Purge all archived sessions',
      confirmAll: 'Click again to delete {count} sessions permanently',
      olderTitle: 'Purge sessions inactive for {days}+ days',
      olderHint:
        'Deletes {count} archived session logs ({size}) whose latest activity is before {date}. Newer archived sessions are kept.',
      olderAction: 'Purge {count} inactive sessions',
      confirmOlder: 'Click again to delete {count} sessions permanently',
      cancel: 'Cancel',
      working: 'Deleting…',
      loading: 'Reading archived sessions…',
      loadFailed: 'Could not read the archived sessions.',
      retry: 'Retry',
      purgeFailed: 'Purge failed.',
      deleted: 'Deleted {count} session logs, freeing {size}.',
      skipped: 'Skipped {count}: {reasons}.',
      reasonActive: 'in use',
      reasonOwned: 'being written',
      reasonNoLog: 'no log left',
      reasonUnsafe: 'unexpected path',
      reasonFailed: 'delete failed',
      reasonUnreadable: 'unreadable',
      reasonCleanup: 'cleanup failed',
      reasonUnknown: 'failed',
      reload: 'Reload the page',
      reloadHint: 'The sidebar keeps its cached session list until the page reloads.',
      attachments: 'Attachments referenced by deleted sessions are not removed.',
      empty: 'No archived sessions to delete.',
    };

    const zh = {
      tab: '归档清理',
      lead: '删除已归档会话的日志以释放磁盘空间。删除不可恢复，两个操作都需要二次确认。',
      definition:
        '“归档”只记录会话 id，不记录归档时间。第二个数字统计的是最近活动（会话日志的最后一次写入）距今至少 {days} 天的已归档会话，而不是 {days} 天前归档的会话。',
      definitionCutoff: '截止时间：日志最后写入早于 {date}。',
      totalLabel: '已归档会话',
      totalHint: '磁盘上的日志共 {size}。',
      staleLabel: '已 {days} 天以上无活动',
      staleHint: '最后一次日志写入早于 {date}。',
      missingHint: '有 {count} 个归档 id 已无日志文件；“清除全部”会同时清理这些归档记录。',
      purgeAllTitle: '清除全部已归档会话',
      purgeAllHint: '删除全部 {count} 个已归档会话日志（{size}）。正在使用中的会话会被跳过。',
      purgeAll: '清除全部已归档会话',
      confirmAll: '再次点击以永久删除 {count} 个会话',
      olderTitle: '清除 {days} 天以上无活动的会话',
      olderHint: '删除最后活动早于 {date} 的 {count} 个已归档会话日志（{size}）；较新的已归档会话会保留。',
      olderAction: '清除 {count} 个无活动会话',
      confirmOlder: '再次点击以永久删除 {count} 个会话',
      cancel: '取消',
      working: '删除中…',
      loading: '正在读取已归档会话…',
      loadFailed: '无法读取已归档会话。',
      retry: '重试',
      purgeFailed: '清除失败。',
      deleted: '已删除 {count} 个会话日志，释放 {size}。',
      skipped: '跳过 {count} 个：{reasons}。',
      reasonActive: '使用中',
      reasonOwned: '正在写入',
      reasonNoLog: '无日志',
      reasonUnsafe: '路径异常',
      reasonFailed: '删除失败',
      reasonUnreadable: '无法读取',
      reasonCleanup: '清理失败',
      reasonUnknown: '失败',
      reload: '重新加载页面',
      reloadHint: '侧边栏会保留缓存的会话列表，直到页面重新加载。',
      attachments: '被删除会话引用的附件不会被移除。',
      empty: '没有可删除的已归档会话。',
    };

    const STYLES = `
      .dap-root {
        display: flex;
        flex-direction: column;
        gap: 16px;
        max-width: 880px;
        color: var(--dsw-alias-label-primary);
      }
      .dap-lead,
      .dap-note,
      .dap-hint,
      .dap-footnote {
        margin: 0;
      }
      .dap-lead { font-size: 13px; line-height: 20px; }
      .dap-note { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dap-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dap-footnote { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dap-note strong { font-weight: 600; color: var(--dsw-alias-label-primary); }
      .dap-stats {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 12px;
      }
      .dap-stat,
      .dap-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1);
      }
      .dap-stat { gap: 4px; }
      .dap-stat-label {
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-label-secondary);
      }
      .dap-stat-value {
        font-size: 28px;
        line-height: 34px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
      }
      .dap-stat-hint {
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-label-secondary);
      }
      .dap-card-title { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600; }
      .dap-card-hint { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
      .dap-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 2px; }
      .dap-button {
        padding: 6px 14px;
        border: 1px solid var(--dsw-alias-border-l2);
        border-radius: 6px;
        background: transparent;
        color: var(--dsw-alias-label-primary);
        font: inherit;
        font-size: 12px;
        cursor: pointer;
      }
      .dap-button:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); }
      .dap-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dap-button:disabled { opacity: 0.5; cursor: default; }
      .dap-button[data-tone='danger'] {
        border-color: var(--dsw-alias-state-error-primary);
        color: var(--dsw-alias-state-error-primary);
      }
      .dap-button[data-tone='solid-danger'] {
        border-color: var(--dsw-alias-state-error-primary);
        background: var(--dsw-alias-bg-layer-2);
        color: var(--dsw-alias-state-error-primary);
        font-weight: 600;
      }
      .dap-status {
        font-size: 12px;
        line-height: 18px;
        color: var(--dsw-alias-state-error-primary);
      }
      .dap-result {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px;
        border: 1px solid var(--dsw-alias-border-l1);
        border-radius: 10px;
        background: var(--dsw-alias-bg-layer-1);
      }
      .dap-result p { margin: 0; font-size: 12px; line-height: 18px; }
    `;

    /** Human-readable byte count. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KiB', 'MiB', 'GiB'];
      let value = bytes;
      let index = 0;
      while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
      }
      return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
    }

    /** Local calendar time for a Host-provided epoch millisecond value. */
    function formatMoment(ms) {
      try {
        return new Intl.DateTimeFormat(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(ms));
      } catch {
        return new Date(ms).toISOString();
      }
    }

    /** Fallback interpolation for the English dictionary when no translator is bound. */
    function interpolate(template, params) {
      if (typeof template !== 'string') return String(template);
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        Object.hasOwn(params, key) ? String(params[key]) : match
      );
    }

    /** Read the two counts without touching any session. */
    async function readStatus() {
      const response = await fetch(STATUS_URL, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error?.message ?? `Request failed (${response.status})`);
      }
      return data.status;
    }

    /** Run one confirmed purge; the Host recomputes the eligible set itself. */
    async function postPurge(scope) {
      const response = await fetch(PURGE_URL, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          [PURGE_HEADER]: 'purge',
        },
        body: JSON.stringify({ confirm: 'purge', scope }),
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error?.message ?? `Request failed (${response.status})`);
      }
      return data.result;
    }

    /** One labelled number. */
    function StatCard({ label, value, hint }) {
      return h(
        'div',
        { className: 'dap-stat' },
        h('span', { className: 'dap-stat-label' }, label),
        h('span', { className: 'dap-stat-value' }, String(value)),
        h('span', { className: 'dap-stat-hint' }, hint)
      );
    }

    /** "1 in use, 2 no log left" for the skipped summary. */
    function reasonSummary(skipped, t) {
      const labels = {
        active: t('reasonActive'),
        owned: t('reasonOwned'),
        'no-log': t('reasonNoLog'),
        'unsafe-path': t('reasonUnsafe'),
        'delete-failed': t('reasonFailed'),
        unreadable: t('reasonUnreadable'),
        'cleanup-failed': t('reasonCleanup'),
      };
      const counts = new Map();
      for (const item of skipped) {
        const key = labels[item.reason] === undefined ? t('reasonUnknown') : labels[item.reason];
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return [...counts].map(([label, count]) => `${count} ${label}`).join(', ');
    }

    /**
     * The page: counts, then two two-step destructive actions.
     * @param props - slot props bound by the locale namespace.
     */
    function ArchivePurgePage(props) {
      const t =
        typeof props?.t === 'function' ? props.t : (key, params) => interpolate(en[key] ?? key, params);

      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [loadError, setLoadError] = React.useState(null);
      const [armed, setArmed] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [actionError, setActionError] = React.useState(null);

      const load = React.useCallback(async () => {
        setLoading(true);
        setLoadError(null);
        try {
          setStatus(await readStatus());
        } catch (error) {
          setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => {
        void load();
      }, [load]);

      const run = async (scope) => {
        setBusy(scope);
        setActionError(null);
        try {
          const outcome = await postPurge(scope);
          setResult(outcome);
          if (outcome.remaining !== null && outcome.remaining !== undefined) setStatus(outcome.remaining);
          setArmed(null);
        } catch (error) {
          setActionError(error instanceof Error ? error.message : String(error));
        } finally {
          setBusy(null);
        }
      };

      const arm = (scope) => {
        if (busy !== null || status === null) return;
        if (armed === scope) {
          void run(scope);
          return;
        }
        setArmed(scope);
        setResult(null);
        setActionError(null);
      };

      const days = status?.olderThanDays ?? 7;
      const total = status?.archived ?? 0;
      const older = status?.older ?? 0;
      const cutoffText = status === null ? '' : formatMoment(status.cutoff);
      const busyAny = busy !== null || loading;
      const allLabel =
        busy === 'all' ? t('working') : armed === 'all' ? t('confirmAll', { count: total }) : t('purgeAll');
      const olderLabel =
        busy === 'older'
          ? t('working')
          : armed === 'older'
            ? t('confirmOlder', { count: older })
            : t('olderAction', { count: older });

      return h(
        'div',
        { className: 'dap-root' },
        h('style', null, STYLES),
        h('p', { className: 'dap-lead' }, t('lead')),
        h('p', { className: 'dap-note' }, t('definition', { days })),
        status !== null
          ? h('p', { className: 'dap-note' }, t('definitionCutoff', { date: cutoffText }))
          : null,

        loading && status === null ? h('p', { className: 'dap-hint' }, t('loading')) : null,
        loadError !== null
          ? h(
              'div',
              { role: 'alert' },
              h('p', { className: 'dap-status' }, `${t('loadFailed')} ${loadError}`),
              h(
                'div',
                { className: 'dap-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dap-button',
                    onClick: () => void load(),
                  },
                  t('retry')
                )
              )
            )
          : null,

        status !== null
          ? h(
              'div',
              { className: 'dap-stats' },
              h(StatCard, {
                label: t('totalLabel'),
                value: total,
                hint: t('totalHint', { size: formatBytes(status.bytes) }),
              }),
              h(StatCard, {
                label: t('staleLabel', { days }),
                value: older,
                hint: t('staleHint', { date: cutoffText }),
              })
            )
          : null,

        status !== null && status.missing > 0
          ? h('p', { className: 'dap-note' }, t('missingHint', { count: status.missing }))
          : null,

        status !== null
          ? h(
              'section',
              { className: 'dap-card' },
              h('h3', { className: 'dap-card-title' }, t('purgeAllTitle')),
              h(
                'p',
                { className: 'dap-card-hint' },
                t('purgeAllHint', {
                  count: total,
                  size: formatBytes(status.bytes),
                })
              ),
              total === 0 ? h('p', { className: 'dap-hint' }, t('empty')) : null,
              h(
                'div',
                { className: 'dap-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dap-button',
                    'data-tone': armed === 'all' ? 'solid-danger' : 'danger',
                    disabled: busyAny || total === 0,
                    onClick: () => arm('all'),
                  },
                  allLabel
                ),
                armed === 'all'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dap-button',
                        disabled: busyAny,
                        onClick: () => setArmed(null),
                      },
                      t('cancel')
                    )
                  : null
              )
            )
          : null,

        status !== null
          ? h(
              'section',
              { className: 'dap-card' },
              h('h3', { className: 'dap-card-title' }, t('olderTitle', { days })),
              h(
                'p',
                { className: 'dap-card-hint' },
                t('olderHint', {
                  count: older,
                  size: formatBytes(status.olderBytes),
                  date: cutoffText,
                })
              ),
              h(
                'div',
                { className: 'dap-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dap-button',
                    'data-tone': armed === 'older' ? 'solid-danger' : 'danger',
                    disabled: busyAny || older === 0,
                    onClick: () => arm('older'),
                  },
                  olderLabel
                ),
                armed === 'older'
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'dap-button',
                        disabled: busyAny,
                        onClick: () => setArmed(null),
                      },
                      t('cancel')
                    )
                  : null
              )
            )
          : null,

        result !== null
          ? h(
              'div',
              { className: 'dap-result', role: 'status' },
              h(
                'p',
                null,
                t('deleted', {
                  count: result.deleted,
                  size: formatBytes(result.bytesFreed),
                })
              ),
              result.skipped.length > 0
                ? h(
                    'p',
                    null,
                    t('skipped', {
                      count: result.skipped.length,
                      reasons: reasonSummary(result.skipped, t),
                    })
                  )
                : null,
              h(
                'div',
                { className: 'dap-actions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dap-button',
                    onClick: () => {
                      window.location.reload();
                    },
                  },
                  t('reload')
                ),
                h('span', { className: 'dap-hint' }, t('reloadHint'))
              )
            )
          : null,

        actionError !== null
          ? h('p', { className: 'dap-status', role: 'alert' }, `${t('purgeFailed')} ${actionError}`)
          : null,

        h('p', { className: 'dap-footnote' }, t('attachments'))
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'archive-purge: dictionaries');
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.tab', () =>
              ctx.slots.register(
                {
                  name: 'plugins.tab',
                  id: 'archive-purge',
                  order: 10,
                  label: () => t('tab'),
                  locale: NS,
                  inject: () => ({}),
                },
                ArchivePurgePage
              )
            ),
          'archive-purge: plugin tab'
        );
      },
    };
  },
});
