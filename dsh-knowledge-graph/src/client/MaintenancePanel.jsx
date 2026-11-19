/**
 * The bundle row's configure page: storage status and the user-only purge.
 *
 * Runs only from the Plugins settings page, so it keeps its own inline styles
 * rather than the graph panel's style sheet.
 */
import React from 'react';

const ADMIN_URL = '/knowledge-graph/admin';

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
 * @returns the maintenance page.
 */
export function MaintenancePanel(props) {
  const t = typeof props?.t === 'function' ? props.t : (key) => key;
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

  if (props?.view === 'summary') return <span>{t('summary')}</span>;

  const rows =
    status === null
      ? []
      : [
          [
            t('location'),
            <span style={styles.value}>
              <code style={styles.code}>{status.dataDir}</code>
            </span>,
          ],
          [t('file'), <span style={styles.value}>{status.exists ? t('present') : t('absent')}</span>],
          [t('size'), <span style={styles.value}>{formatBytes(status.bytes)}</span>],
          [t('entitiesLabel'), <span style={styles.value}>{String(status.nodes)}</span>],
          [t('relationsLabel'), <span style={styles.value}>{String(status.edges)}</span>],
          [t('revisions'), <span style={styles.value}>{String(status.revisions ?? 0)}</span>],
          [t('schema'), <span style={styles.value}>{String(status.schemaVersion)}</span>],
        ];

  return (
    <div style={styles.page}>
      <p style={styles.hint}>{t('description')}</p>

      <div style={styles.card}>
        <div style={styles.header}>
          <h3 style={styles.title}>{t('title')}</h3>
          <button
            type="button"
            style={styles.subtle}
            disabled={loading || purging}
            onClick={() => void load()}
          >
            {loading ? t('refreshing') : t('refresh')}
          </button>
        </div>
        {loading && status === null ? (
          <p style={styles.hint} role="status">
            …
          </p>
        ) : null}
        {loadError !== null ? (
          <div role="alert">
            <p style={styles.error}>{`${t('loadFailed')} ${loadError}`}</p>
          </div>
        ) : null}
        {status !== null ? (
          <div style={styles.grid}>
            {rows.flatMap(([label, value], index) => [
              <span key={`l${index}`} style={styles.label}>
                {label}
              </span>,
              <span key={`v${index}`} style={styles.value}>
                {value}
              </span>,
            ])}
          </div>
        ) : null}
        {status !== null && status.fault.length > 0 ? (
          <div role="alert">
            <p style={styles.error}>{`${t('fault')}: ${status.fault}`}</p>
          </div>
        ) : null}
      </div>

      <div style={styles.dangerCard}>
        <h3 style={styles.title}>{t('purgeTitle')}</h3>
        <p style={styles.warning}>{t('purgeHint')}</p>
        <p style={styles.hint}>{t('sharedNote')}</p>
        <div style={styles.actions}>
          <button
            type="button"
            style={confirming ? styles.danger : styles.subtle}
            disabled={loading || purging}
            onClick={() => {
              setNotice(null);
              setActionError(null);
              if (confirming) void purge();
              else setConfirming(true);
            }}
          >
            {purging ? t('purging') : confirming ? t('purgeConfirm') : t('purge')}
          </button>
          {confirming && !purging ? (
            <button type="button" style={styles.subtle} onClick={() => setConfirming(false)}>
              {t('purgeCancel')}
            </button>
          ) : null}
        </div>
        {notice !== null ? (
          <p style={styles.notice} role="status">
            {notice}
          </p>
        ) : null}
        {actionError !== null ? (
          <p style={styles.error} role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
