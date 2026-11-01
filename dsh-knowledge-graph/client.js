/**
 * Knowledge Graph Client half.
 *
 * Adds the bundle row's maintenance page: storage status, a manual refresh, and
 * an explicit two-step purge. The purge is user-only; it is not exposed as an
 * agent tool.
 */

window.__ModuleLoader__.load({
  id: 'dsh-knowledge-graph',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'settings.knowledgeGraph';
    const ROW_CONFIG_KEY = 'dsh-knowledge-graph#knowledge-graph';
    const ADMIN_URL = '/knowledge-graph/admin';

    const en = {
      summary: 'Local SQLite knowledge graph with search, traversal, and purge controls.',
      title: 'Knowledge graph',
      description:
        'Entities and relations are stored in one SQLite database inside this profile. Every session in the profile shares it.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      location: 'Location',
      file: 'Database file',
      present: 'present',
      absent: 'not created yet',
      size: 'Size on disk',
      entities: 'Entities',
      relations: 'Relations',
      revisions: 'Changelog entries',
      schema: 'Schema version',
      loadFailed: 'Could not read the storage status.',
      fault: 'Storage problem',
      purgeTitle: 'Delete all graph data',
      purgeHint:
        'This permanently removes every entity, relation, changelog entry, and the database file itself. Referenced attachments are left untouched, and a later write starts a new empty database.',
      purge: 'Purge graph data',
      purgeConfirm: 'Click again to delete permanently',
      purgeCancel: 'Cancel',
      purging: 'Purging…',
      purged: 'All graph data was deleted. Nothing remains on disk until the next write.',
      purgeFailed: 'Purge failed.',
      sharedNote:
        'The plugin keeps no backup copy. Removing the plugin after a purge leaves no graph files behind.',
    };

    const zh = {
      summary: '本地 SQLite 知识图谱，支持搜索、遍历与清除。',
      title: '知识图谱',
      description: '实体与关系保存在该配置内的同一个 SQLite 数据库中，同一配置下的所有会话共享它。',
      refresh: '刷新',
      refreshing: '刷新中…',
      location: '存储位置',
      file: '数据库文件',
      present: '已存在',
      absent: '尚未创建',
      size: '磁盘占用',
      entities: '实体数',
      relations: '关系数',
      revisions: '变更记录',
      schema: '架构版本',
      loadFailed: '无法读取存储状态。',
      fault: '存储异常',
      purgeTitle: '删除全部图谱数据',
      purgeHint:
        '将永久删除所有实体、关系、变更记录以及数据库文件本身。被引用的附件不会被删除；之后的写入会重新创建一个空数据库。',
      purge: '清除图谱数据',
      purgeConfirm: '再次点击以永久删除',
      purgeCancel: '取消',
      purging: '正在清除…',
      purged: '图谱数据已全部删除；在下一次写入前磁盘上不会留下任何文件。',
      purgeFailed: '清除失败。',
      sharedNote: '该插件不保留任何备份。清除后再卸载插件，不会留下图谱文件。',
    };

    const styles = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        color: 'var(--dsw-alias-label-primary)',
        boxSizing: 'border-box',
        maxWidth: '820px',
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '16px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      dangerCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        padding: '16px',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        borderRadius: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      header: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      title: { margin: 0, fontSize: '14px', fontWeight: 600 },
      hint: {
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      warning: {
        margin: 0,
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '12px',
        lineHeight: 1.5,
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: '6px 16px',
        alignItems: 'baseline',
      },
      label: { color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      value: { fontSize: '12px', wordBreak: 'break-all' },
      code: {
        fontFamily: 'var(--dsw-font-family-mono, ui-monospace, monospace)',
        fontSize: '11px',
        padding: '2px 6px',
        borderRadius: 'var(--dsw-radius-sm, 4px)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      actions: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      primary: {
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      subtle: {
        padding: '6px 12px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: '12px',
        cursor: 'pointer',
      },
      danger: {
        padding: '6px 14px',
        borderRadius: 'var(--dsw-radius-md, 6px)',
        border: '1px solid var(--dsw-alias-state-error-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-state-error-primary)',
        font: 'inherit',
        fontSize: '12px',
        fontWeight: 600,
        cursor: 'pointer',
      },
      error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
      notice: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
    };

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

    /** Read the maintenance endpoint. */
    async function readStatus() {
      const response = await fetch(ADMIN_URL, {
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

    /** Delete every graph-owned file. */
    async function purgeGraph() {
      const response = await fetch(ADMIN_URL, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-dsh-kg-action': 'purge',
        },
        body: JSON.stringify({ confirm: 'purge' }),
      });
      const data = await response.json().catch(() => undefined);
      if (!response.ok || data?.ok !== true) {
        throw new Error(data?.error?.message ?? `Request failed (${response.status})`);
      }
      return data.status;
    }

    /**
     * The bundle row's configure page.
     * @param props - slot owner props plus the localized translator.
     */
    function KnowledgeGraphPanel(props) {
      const t = typeof props?.t === 'function' ? props.t : (key) => (en[key] !== undefined ? en[key] : key);

      const [status, setStatus] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [loadError, setLoadError] = React.useState(null);
      const [confirming, setConfirming] = React.useState(false);
      const [purging, setPurging] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
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

      const purge = React.useCallback(async () => {
        setPurging(true);
        setActionError(null);
        setNotice(null);
        try {
          setStatus(await purgeGraph());
          setNotice(t('purged'));
          setConfirming(false);
        } catch (error) {
          setActionError(`${t('purgeFailed')} ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          setPurging(false);
        }
      }, [t]);

      if (props?.view === 'summary') return h('span', null, t('summary'));

      const rows =
        status === null
          ? []
          : [
              [
                t('location'),
                h('span', { style: styles.value }, h('code', { style: styles.code }, status.dataDir)),
              ],
              [t('file'), h('span', { style: styles.value }, status.exists ? t('present') : t('absent'))],
              [t('size'), h('span', { style: styles.value }, formatBytes(status.bytes))],
              [t('entities'), h('span', { style: styles.value }, String(status.nodes))],
              [t('relations'), h('span', { style: styles.value }, String(status.edges))],
              [t('revisions'), h('span', { style: styles.value }, String(status.revisions ?? 0))],
              [t('schema'), h('span', { style: styles.value }, String(status.schemaVersion))],
            ];

      return h(
        'div',
        { style: styles.page },
        h('p', { style: styles.hint }, t('description')),

        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.header },
            h('h3', { style: styles.title }, t('title')),
            h(
              'button',
              {
                type: 'button',
                style: styles.subtle,
                disabled: loading || purging,
                onClick: () => void load(),
              },
              loading ? t('refreshing') : t('refresh')
            )
          ),
          loading && status === null ? h('p', { style: styles.hint, role: 'status' }, '…') : null,
          loadError !== null
            ? h('div', { role: 'alert' }, h('p', { style: styles.error }, `${t('loadFailed')} ${loadError}`))
            : null,
          status !== null
            ? h(
                'div',
                { style: styles.grid },
                rows.flatMap(([label, value], index) => [
                  h('span', { key: `l${index}`, style: styles.label }, label),
                  h('span', { key: `v${index}`, style: styles.value }, value),
                ])
              )
            : null,
          status !== null && status.fault.length > 0
            ? h('div', { role: 'alert' }, h('p', { style: styles.error }, `${t('fault')}: ${status.fault}`))
            : null
        ),

        h(
          'div',
          { style: styles.dangerCard },
          h('h3', { style: styles.title }, t('purgeTitle')),
          h('p', { style: styles.warning }, t('purgeHint')),
          h('p', { style: styles.hint }, t('sharedNote')),
          h(
            'div',
            { style: styles.actions },
            h(
              'button',
              {
                type: 'button',
                style: confirming ? styles.danger : styles.subtle,
                disabled: loading || purging,
                onClick: () => {
                  setNotice(null);
                  setActionError(null);
                  if (confirming) void purge();
                  else setConfirming(true);
                },
              },
              purging ? t('purging') : confirming ? t('purgeConfirm') : t('purge')
            ),
            confirming && !purging
              ? h(
                  'button',
                  {
                    type: 'button',
                    style: styles.subtle,
                    onClick: () => setConfirming(false),
                  },
                  t('purgeCancel')
                )
              : null
          ),
          notice !== null ? h('p', { style: styles.notice, role: 'status' }, notice) : null,
          actionError !== null ? h('p', { style: styles.error, role: 'alert' }, actionError) : null
        )
      );
    }

    return {
      /**
       * The row page is self-contained: it owns its store and admin route and
       * edits no Host settings namespace. It therefore registers as soon as
       * this client half applies (i.e. while the plugin row is activated) and
       * does not depend on `configForms` serving a `knowledge-graph` namespace
       * — this plugin's Config has no volatile field, so such a namespace never
       * exists and a `whileServed` gate would keep the page hidden forever.
       */
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'knowledge-graph: dictionaries');
        ctx.effect(
          () =>
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.row.config',
                  key: ROW_CONFIG_KEY,
                  locale: NS,
                  inject: () => ({}),
                },
                KnowledgeGraphPanel
              )
            ),
          'knowledge-graph: plugin row page'
        );
      },
    };
  },
});
