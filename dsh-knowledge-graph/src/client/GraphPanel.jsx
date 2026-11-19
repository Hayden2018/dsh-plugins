/**
 * The right-Sidebar knowledge-graph canvas.
 *
 * Reads the compact snapshot from `/knowledge-graph/graph`, renders it with
 * Cytoscape + fcose, and fetches an entity's or relation's full record only when
 * its inspector opens. Filtering, selection, neighborhood focus and label
 * visibility stay local. The inspectors can edit an entity's name, type, tags,
 * and description, and can create, rename, or delete one relation through the
 * guarded node and edge routes; every other field stays read-only.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { cytoscape, ensureFcose } from './graph-engine.js';
import { buildStyle, typeColor, TYPE_ORDER } from './graph-style.js';

const GRAPH_URL = '/knowledge-graph/graph';
const NODE_URL = '/knowledge-graph/node';
const EDGE_URL = '/knowledge-graph/edge';
/** Mirrors the host's relation-label syntax for immediate form feedback. */
const RELATION_PATTERN = /^[a-z][a-z0-9_:-]{0,63}$/;

/** Stable fallback for a standalone mount without the theme service. */
const FALLBACK_THEME = { active: { colorScheme: 'light' } };
const FALLBACK_THEME_SOURCE = {
  subscribe: () => () => {},
  getSnapshot: () => FALLBACK_THEME,
};

/** Read one JSON envelope from the host. */
async function readJson(url, signal) {
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
    signal,
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data?.ok !== true) {
    const error = new Error(data?.error?.message ?? `Request failed (${response.status})`);
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

/** Send one JSON mutation and preserve the host's error code. */
async function postJson(url, body, headers, signal) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok || data?.ok !== true) {
    const error = new Error(data?.error?.message ?? `Request failed (${response.status})`);
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

/** Headers shared by every Web mutation route. */
function mutationHeaders(action, sessionId) {
  const headers = { 'x-dsh-kg-action': action };
  if (typeof sessionId === 'string' && sessionId.length > 0) {
    headers['x-dsh-kg-session'] = sessionId;
  }
  return headers;
}

/** Immutable identity of one relation inside a graph snapshot. */
function edgeIdentity(edge) {
  return `${edge.source}\u0000${edge.relation}\u0000${edge.target}`;
}

/** Read one relation's full inspector record. */
function edgeDetailUrl(edge) {
  const params = new URLSearchParams({
    from_id: edge.source,
    relation: edge.relation,
    to_id: edge.target,
  });
  return `${EDGE_URL}?${params.toString()}`;
}

/** Short local date for the inspector footer. */
function formatDate(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Re-run the force-directed layout. */
function runLayout(cy) {
  if (cy.nodes().length === 0) return;
  cy.layout({
    name: 'fcose',
    animate: true,
    animationDuration: 550,
    randomize: true,
    fit: true,
    padding: 52,
    nodeRepulsion: 18000,
    idealEdgeLength: 122,
    edgeElasticity: 0.42,
    gravity: 0.18,
    nodeSeparation: 96,
    numIter: 2500,
    tile: true,
    packComponents: true,
    quality: 'default',
  }).run();
}

/** Refresh glyph. */
function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </svg>
  );
}

/** Fit glyph. */
function FitIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </svg>
  );
}

/** Layout glyph. */
function LayoutIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <path d="M8.1 7.8 10.3 16M15.9 7.8 13.7 16M8.2 7h7.6" />
    </svg>
  );
}

/** Label glyph. */
function LabelIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Z" />
      <circle cx="7.5" cy="7.5" r="1.3" />
    </svg>
  );
}

/** Neighborhood-focus glyph. */
function FocusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </svg>
  );
}

/** Close glyph. */
function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  );
}

/** Edit glyph. */
function EditIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="m13.5 6.5 4 4" />
    </svg>
  );
}

/** Add-relation glyph. */
function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/** Delete-relation glyph. */
function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" />
    </svg>
  );
}

/** A compact icon-only control. */
function IconButton({ label, onClick, disabled, active, children }) {
  return (
    <button
      type="button"
      className={`kg-icon-btn${active ? ' is-active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Loading ring. */
function Spinner() {
  return <span className="kg-spinner" aria-hidden="true" />;
}

/** One outgoing or incoming relation inside the inspector. */
function RelationRow({ edge, t, onSelectEdge }) {
  const name = edge.neighbor?.name || edge.neighbor?.id || edge.traversal;
  const arrow = edge.traversal === 'forward' ? '→' : '←';
  return (
    <button
      type="button"
      className="kg-relation"
      onClick={() => onSelectEdge(edge.from_id, edge.relation, edge.to_id)}
      title={name}
    >
      <span className="kg-relation-top">
        <span className="kg-rel-label">{edge.relation}</span>
        <span className="kg-rel-arrow">{arrow}</span>
        <span className="kg-rel-name">{name}</span>
      </span>
      {edge.description ? <span className="kg-rel-desc">{edge.description}</span> : null}
    </button>
  );
}

/** One endpoint of the selected relation, clickable like a node relation. */
function EndpointRow({ role, node, t, onSelect }) {
  const name = node?.name || node?.id || '';
  return (
    <button type="button" className="kg-relation" onClick={() => onSelect(node.id)} title={name}>
      <span className="kg-relation-top">
        <span className="kg-dot" style={{ background: typeColor(node?.type) }} />
        <span className="kg-rel-label">{t(role)}</span>
        <span className="kg-rel-name">{name}</span>
      </span>
      <span className="kg-rel-desc">{node?.type ?? 'other'}</span>
    </button>
  );
}

/** Create one entity. The store generates the stable id. */
function NodeCreateForm({ t, sessionId, onCancel, onCreated }) {
  const [name, setName] = useState('');
  const [type, setType] = useState('other');
  const [tags, setTags] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    const nextName = name.trim();
    if (nextName.length === 0) {
      setError(t('nameRequired'));
      return;
    }
    const nextTags = Array.from(
      new Set(
        tags
          .split(',')
          .map((tag) => tag.trim().toLowerCase())
          .filter((tag) => tag.length > 0)
      )
    ).sort();
    setSaving(true);
    setError(null);
    try {
      const data = await postJson(
        NODE_URL,
        { name: nextName, type, tags: nextTags, description },
        mutationHeaders('create', sessionId)
      );
      onCreated(data.node);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="kg-form" onSubmit={submit}>
      <label className="kg-field">
        <span className="kg-field-label">{t('name')}</span>
        <input
          className="kg-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={200}
          autoFocus
        />
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('type')}</span>
        <select className="kg-select" value={type} onChange={(event) => setType(event.target.value)}>
          {TYPE_ORDER.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('tags')}</span>
        <input
          className="kg-input"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={t('tagsHint')}
        />
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('descriptionLabel')}</span>
        <textarea
          className="kg-textarea"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={20_000}
          rows={6}
        />
      </label>
      {error !== null ? <p className="kg-error-line">{error}</p> : null}
      <div className="kg-form-actions">
        <button type="button" className="kg-button" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </button>
        <button type="submit" className="kg-primary" disabled={saving}>
          {saving ? t('saving') : t('create')}
        </button>
      </div>
    </form>
  );
}

/** Drawer wrapper for the entity creation form. */
function NodeCreateDrawer({ t, sessionId, onClose, onCreated }) {
  return (
    <aside className="kg-drawer" role="dialog" aria-modal="false" aria-label={t('createEntity')}>
      <div className="kg-drawer-head">
        <h3 className="kg-drawer-title">{t('createEntity')}</h3>
        <IconButton label={t('close')} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      <div className="kg-drawer-body">
        <NodeCreateForm t={t} sessionId={sessionId} onCancel={onClose} onCreated={onCreated} />
      </div>
    </aside>
  );
}

/** The editable fields of one entity. */
function NodeEditForm({ node, sessionId, t, onCancel, onSaved }) {
  const [name, setName] = useState(node.name ?? '');
  const [type, setType] = useState(node.type ?? 'other');
  const [tags, setTags] = useState((node.tags ?? []).join(', '));
  const [description, setDescription] = useState(node.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    const nextName = name.trim();
    if (nextName.length === 0) {
      setError(t('nameRequired'));
      return;
    }
    const nextTags = Array.from(
      new Set(
        tags
          .split(',')
          .map((tag) => tag.trim().toLowerCase())
          .filter((tag) => tag.length > 0)
      )
    ).sort();
    const headers = mutationHeaders('update', sessionId);
    setSaving(true);
    setError(null);
    try {
      const data = await postJson(
        NODE_URL,
        {
          id: node.id,
          expected_revision: node.revision,
          patch: { name: nextName, type, tags: nextTags, description },
        },
        headers,
        undefined
      );
      onSaved(data.node);
    } catch (cause) {
      setError(
        cause?.code === 'revision_conflict'
          ? t('revisionConflict')
          : cause instanceof Error
            ? cause.message
            : String(cause)
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="kg-form" onSubmit={submit}>
      <label className="kg-field">
        <span className="kg-field-label">{t('name')}</span>
        <input
          className="kg-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoFocus
        />
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('type')}</span>
        <select className="kg-select" value={type} onChange={(event) => setType(event.target.value)}>
          {TYPE_ORDER.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('tags')}</span>
        <input
          className="kg-input"
          value={tags}
          onChange={(event) => setTags(event.target.value)}
          placeholder={t('tagsHint')}
        />
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('descriptionLabel')}</span>
        <textarea
          className="kg-textarea"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      {error !== null ? <p className="kg-error-line">{error}</p> : null}
      <div className="kg-form-actions">
        <button type="button" className="kg-button" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </button>
        <button type="submit" className="kg-primary" disabled={saving}>
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </form>
  );
}

/** Map one entity deletion failure to actionable inspector copy. */
function nodeDeleteError(cause, t) {
  switch (cause?.code) {
    case 'revision_conflict':
      return t('revisionConflict');
    case 'has_edges':
      return t('nodeHasEdges');
    default:
      return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Map one edge mutation failure to actionable inspector copy. */
function edgeErrorText(cause, t, notFoundKey = 'relationMissing') {
  switch (cause?.code) {
    case 'already_exists':
      return t('relationExists');
    case 'invalid_relation':
      return t('relationInvalid');
    case 'revision_conflict':
      return t('edgeRevisionConflict');
    case 'not_found':
      return t(notFoundKey);
    default:
      return cause instanceof Error ? cause.message : String(cause);
  }
}

/** Edit one relation's label and description. Endpoints stay fixed. */
function EdgeEditForm({ edge, siblings, t, sessionId, onCancel, onSaved }) {
  const [relation, setRelation] = useState(edge.relation);
  const [description, setDescription] = useState(edge.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    const nextRelation = relation.trim();
    if (!RELATION_PATTERN.test(nextRelation)) {
      setError(t('relationInvalid'));
      return;
    }
    if (nextRelation !== edge.relation && siblings.some((sibling) => sibling.relation === nextRelation)) {
      setError(t('relationExists'));
      return;
    }
    const body = {
      from_id: edge.from_id,
      to_id: edge.to_id,
      relation: edge.relation,
      expected_revision: edge.revision,
      description,
    };
    if (nextRelation !== edge.relation) body.new_relation = nextRelation;
    setSaving(true);
    setError(null);
    try {
      const data = await postJson(EDGE_URL, body, mutationHeaders('update', sessionId));
      onSaved(data.edge);
    } catch (cause) {
      setError(edgeErrorText(cause, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="kg-form" onSubmit={submit}>
      <p className="kg-footnote">
        {edge.from?.name ?? edge.from_id} → {edge.to?.name ?? edge.to_id}
      </p>
      <label className="kg-field">
        <span className="kg-field-label">{t('relation')}</span>
        <input
          className="kg-input"
          value={relation}
          onChange={(event) => setRelation(event.target.value)}
          maxLength={64}
          spellCheck={false}
          autoFocus
        />
        <span className="kg-field-hint">{t('relationHint')}</span>
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('descriptionLabel')}</span>
        <textarea
          className="kg-textarea"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={20_000}
          rows={6}
        />
      </label>
      {error !== null ? <p className="kg-error-line">{error}</p> : null}
      <div className="kg-form-actions">
        <button type="button" className="kg-button" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </button>
        <button type="submit" className="kg-primary" disabled={saving}>
          {saving ? t('saving') : t('save')}
        </button>
      </div>
    </form>
  );
}

/** Create one outgoing relation from an entity to another graph entity. */
function EdgeCreateForm({ fromNode, nodes, t, sessionId, onCancel, onCreated }) {
  const targets = useMemo(
    () =>
      nodes
        .filter((node) => node.id !== fromNode.id)
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    [nodes, fromNode.id]
  );
  const [toId, setToId] = useState(targets[0]?.id ?? '');
  const [relation, setRelation] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    if (saving) return;
    if (toId.length === 0) {
      setError(t('targetRequired'));
      return;
    }
    const nextRelation = relation.trim();
    if (!RELATION_PATTERN.test(nextRelation)) {
      setError(t('relationInvalid'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const data = await postJson(
        EDGE_URL,
        {
          from_id: fromNode.id,
          to_id: toId,
          relation: nextRelation,
          description,
        },
        mutationHeaders('create', sessionId)
      );
      onCreated(data.edge);
    } catch (cause) {
      setError(edgeErrorText(cause, t, 'entityMissing'));
    } finally {
      setSaving(false);
    }
  };

  if (targets.length === 0) {
    return (
      <div className="kg-form">
        <p className="kg-empty-line">{t('noOtherEntities')}</p>
        <div className="kg-form-actions">
          <button type="button" className="kg-button" onClick={onCancel}>
            {t('close')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="kg-form" onSubmit={submit}>
      <p className="kg-footnote">{fromNode.name}</p>
      <label className="kg-field">
        <span className="kg-field-label">{t('target')}</span>
        <select className="kg-select" value={toId} onChange={(event) => setToId(event.target.value)}>
          {targets.map((node) => (
            <option key={node.id} value={node.id}>
              {node.name}
            </option>
          ))}
        </select>
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('relation')}</span>
        <input
          className="kg-input"
          value={relation}
          onChange={(event) => setRelation(event.target.value)}
          placeholder="works_for"
          maxLength={64}
          spellCheck={false}
          autoFocus
        />
        <span className="kg-field-hint">{t('relationHint')}</span>
      </label>
      <label className="kg-field">
        <span className="kg-field-label">{t('descriptionLabel')}</span>
        <textarea
          className="kg-textarea"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={20_000}
          rows={5}
        />
      </label>
      {error !== null ? <p className="kg-error-line">{error}</p> : null}
      <div className="kg-form-actions">
        <button type="button" className="kg-button" onClick={onCancel} disabled={saving}>
          {t('cancel')}
        </button>
        <button type="submit" className="kg-primary" disabled={saving}>
          {saving ? t('saving') : t('create')}
        </button>
      </div>
    </form>
  );
}

/** The inspector drawer for one entity. */
function EntityDrawer({
  detail,
  meta,
  nodes,
  t,
  sessionId,
  onClose,
  onSelectEdge,
  onNodeUpdated,
  onNodeDeleted,
  onEdgeChanged,
}) {
  const node = detail?.node;
  const shown = node ?? meta;
  const color = typeColor(shown?.type ?? 'other');
  const [editing, setEditing] = useState(false);
  const [creatingRelation, setCreatingRelation] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  useEffect(() => {
    setEditing(false);
    setCreatingRelation(false);
    setConfirmingDelete(false);
    setDeleting(false);
    setDeleteError(null);
  }, [node?.id]);

  const remove = async () => {
    if (node === undefined || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const data = await postJson(
        NODE_URL,
        {
          id: node.id,
          expected_revision: node.revision,
          cascade_edges: node.degree > 0,
        },
        mutationHeaders('delete', sessionId)
      );
      onNodeDeleted(data.deleted);
      onClose();
    } catch (cause) {
      setDeleteError(nodeDeleteError(cause, t));
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <aside className="kg-drawer" role="dialog" aria-modal="false" aria-label={shown?.name ?? t('entity')}>
      <div className="kg-drawer-head">
        <span className="kg-dot" style={{ background: color }} />
        <h3 className="kg-drawer-title">
          {creatingRelation ? t('createRelation') : editing ? t('editEntity') : (shown?.name ?? t('entity'))}
        </h3>
        {node !== undefined && !editing && !creatingRelation && !confirmingDelete ? (
          <IconButton label={t('addRelation')} onClick={() => setCreatingRelation(true)}>
            <PlusIcon />
          </IconButton>
        ) : null}
        {node !== undefined && !editing && !creatingRelation && !confirmingDelete ? (
          <IconButton label={t('edit')} onClick={() => setEditing(true)}>
            <EditIcon />
          </IconButton>
        ) : null}
        {node !== undefined && !editing && !creatingRelation && !confirmingDelete ? (
          <IconButton label={t('deleteEntity')} onClick={() => setConfirmingDelete(true)}>
            <TrashIcon />
          </IconButton>
        ) : null}
        <IconButton label={t('close')} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      <div className="kg-drawer-body">
        {creatingRelation && node !== undefined ? (
          <EdgeCreateForm
            fromNode={node}
            nodes={nodes}
            t={t}
            sessionId={sessionId}
            onCancel={() => setCreatingRelation(false)}
            onCreated={() => {
              setCreatingRelation(false);
              onEdgeChanged();
            }}
          />
        ) : editing && node !== undefined ? (
          <NodeEditForm
            node={node}
            sessionId={sessionId}
            t={t}
            onCancel={() => setEditing(false)}
            onSaved={(updated) => {
              setEditing(false);
              onNodeUpdated(updated);
            }}
          />
        ) : (
          <>
            {detail === null || detail.loading === true ? (
              <p className="kg-loading-line">
                <Spinner /> {t('loadingEntity')}
              </p>
            ) : null}
            {detail?.error ? <p className="kg-error-line">{detail.error}</p> : null}
            {node !== undefined ? (
              <>
                <div className="kg-meta">
                  <span className="kg-badge">
                    <span className="kg-dot" style={{ background: color }} />
                    {node.type}
                  </span>
                  <span>
                    {node.degree} {t('relations')}
                  </span>
                  {node.revision ? (
                    <span>
                      {t('revision')} {node.revision}
                    </span>
                  ) : null}
                </div>
                {deleteError !== null ? <p className="kg-error-line">{deleteError}</p> : null}
                {confirmingDelete ? (
                  <div className="kg-confirm">
                    <p className="kg-confirm-title">{t('deleteEntityConfirm')}</p>
                    <p className="kg-footnote">
                      {node.degree > 0 ? t('deleteEntityWithRelations') : t('deleteEntityHint')}
                    </p>
                    <div className="kg-form-actions">
                      <button
                        type="button"
                        className="kg-button"
                        onClick={() => setConfirmingDelete(false)}
                        disabled={deleting}
                      >
                        {t('cancel')}
                      </button>
                      <button
                        type="button"
                        className="kg-primary kg-danger-solid"
                        onClick={remove}
                        disabled={deleting}
                      >
                        {deleting ? t('deleting') : t('deleteEntity')}
                      </button>
                    </div>
                  </div>
                ) : null}
                {node.tags.length > 0 ? (
                  <div className="kg-tags">
                    {node.tags.map((tag) => (
                      <span key={tag} className="kg-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                <p className={node.description ? 'kg-desc' : 'kg-empty-line'}>
                  {node.description || t('noDescription')}
                </p>

                <h4 className="kg-section-title">{t('relationsTitle')}</h4>
                {node.edges.outgoing.length === 0 && node.edges.incoming.length === 0 ? (
                  <p className="kg-empty-line">{t('noRelations')}</p>
                ) : null}
                {node.edges.outgoing.length > 0 ? (
                  <div className="kg-relations">
                    {node.edges.outgoing.map((edge) => (
                      <RelationRow
                        key={`out-${edge.relation}-${edge.to_id}`}
                        edge={edge}
                        t={t}
                        onSelectEdge={onSelectEdge}
                      />
                    ))}
                  </div>
                ) : null}
                {node.edges.incoming.length > 0 ? (
                  <div className="kg-relations">
                    {node.edges.incoming.map((edge) => (
                      <RelationRow
                        key={`in-${edge.relation}-${edge.from_id}`}
                        edge={edge}
                        t={t}
                        onSelectEdge={onSelectEdge}
                      />
                    ))}
                  </div>
                ) : null}
                {node.edges.truncated ? <p className="kg-empty-line">{t('relationsTruncated')}</p> : null}

                {node.attachments.length > 0 ? (
                  <>
                    <h4 className="kg-section-title">{t('attachments')}</h4>
                    <ul className="kg-attachments">
                      {node.attachments.map((attachment) => (
                        <li key={attachment} className="kg-attachment">
                          {attachment}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}

                <p className="kg-footnote">
                  {t('updated')} {formatDate(node.updated_at)}
                </p>
              </>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

/** The inspector drawer for one relation. */
function EdgeDrawer({ edge, siblings, nodeById, t, sessionId, onClose, onSelectNode, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setLoading(true);
    setError(null);
    setEditing(false);
    setConfirming(false);
    readJson(edgeDetailUrl(edge), controller.signal)
      .then((data) => setDetail(data.edge))
      .catch((cause) => {
        if (cause?.name !== 'AbortError') setError(edgeErrorText(cause, t));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [edge.source, edge.relation, edge.target, t]);

  const current = detail ?? {
    from_id: edge.source,
    to_id: edge.target,
    relation: edge.relation,
    description: edge.description,
    from: nodeById.get(edge.source),
    to: nodeById.get(edge.target),
  };
  const from = current.from ?? nodeById.get(current.from_id);
  const to = current.to ?? nodeById.get(current.to_id);
  const fromNode = from ?? { id: current.from_id, name: current.from_id, type: 'other' };
  const toNode = to ?? { id: current.to_id, name: current.to_id, type: 'other' };

  const remove = async () => {
    if (deleting || detail === null) return;
    setDeleting(true);
    setError(null);
    try {
      await postJson(
        EDGE_URL,
        {
          from_id: detail.from_id,
          to_id: detail.to_id,
          relation: detail.relation,
          expected_revision: detail.revision,
        },
        mutationHeaders('delete', sessionId)
      );
      onChanged();
      onClose();
    } catch (cause) {
      setError(edgeErrorText(cause, t));
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <aside className="kg-drawer" role="dialog" aria-modal="false" aria-label={current.relation}>
      <div className="kg-drawer-head">
        <span className="kg-dot" style={{ background: typeColor(from?.type) }} />
        <h3 className="kg-drawer-title">{editing ? t('editRelation') : t('relation')}</h3>
        {detail !== null && !editing && !confirming ? (
          <IconButton label={t('editRelation')} onClick={() => setEditing(true)}>
            <EditIcon />
          </IconButton>
        ) : null}
        {detail !== null && !editing && !confirming ? (
          <IconButton label={t('deleteRelation')} onClick={() => setConfirming(true)}>
            <TrashIcon />
          </IconButton>
        ) : null}
        <IconButton label={t('close')} onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>
      <div className="kg-drawer-body">
        {editing && detail !== null ? (
          <EdgeEditForm
            edge={detail}
            siblings={siblings}
            t={t}
            sessionId={sessionId}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
          />
        ) : (
          <>
            {loading ? (
              <p className="kg-loading-line">
                <Spinner /> {t('loadingRelation')}
              </p>
            ) : null}
            {error !== null ? <p className="kg-error-line">{error}</p> : null}
            <div className="kg-relation-top kg-relation-headline">
              <button type="button" className="kg-link" onClick={() => onSelectNode(current.from_id)}>
                {from?.name ?? current.from_id}
              </button>
              <span className="kg-rel-label">{current.relation}</span>
              <span className="kg-rel-arrow">→</span>
              <button type="button" className="kg-link" onClick={() => onSelectNode(current.to_id)}>
                {to?.name ?? current.to_id}
              </button>
            </div>
            <p className={current.description ? 'kg-desc' : 'kg-empty-line'}>
              {current.description || t('noDescription')}
            </p>
            {detail !== null ? (
              <div className="kg-meta">
                {detail.revision ? (
                  <span>
                    {t('revision')} {detail.revision}
                  </span>
                ) : null}
                {detail.updated_at ? (
                  <span>
                    {t('updated')} {formatDate(detail.updated_at)}
                  </span>
                ) : null}
              </div>
            ) : null}
            <h4 className="kg-section-title">{t('connectedEntities')}</h4>
            <div className="kg-relations">
              <EndpointRow role="sourceNode" node={fromNode} t={t} onSelect={onSelectNode} />
              <EndpointRow role="targetNode" node={toNode} t={t} onSelect={onSelectNode} />
            </div>
            <p className="kg-footnote">{t('edgeHint')}</p>
            {confirming ? (
              <div className="kg-confirm">
                <p className="kg-confirm-title">{t('deleteRelationConfirm')}</p>
                <p className="kg-footnote">{t('deleteRelationHint')}</p>
                <div className="kg-form-actions">
                  <button
                    type="button"
                    className="kg-button"
                    onClick={() => setConfirming(false)}
                    disabled={deleting}
                  >
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    className="kg-primary kg-danger-solid"
                    onClick={remove}
                    disabled={deleting}
                  >
                    {deleting ? t('deleting') : t('deleteRelation')}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

/** CSS for the panel, scoped by the `kg-` class prefix. */
const CSS = `
.kg-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;position:relative;overflow:hidden}
.kg-header{display:flex;flex-direction:column;gap:8px;padding:10px 12px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.kg-heading{display:flex;align-items:center;gap:8px;min-height:26px}
.kg-heading-icon{width:16px;height:16px;color:var(--dsw-alias-brand-primary);display:flex;flex:none}
.kg-heading-icon svg{width:100%;height:100%}
.kg-heading-title{font-size:13px;font-weight:600;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.kg-heading-count{margin-left:2px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}
.kg-heading-spacer{flex:1}
.kg-search{box-sizing:border-box;width:100%;height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;outline:none}
.kg-search:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.kg-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;flex:none}
.kg-icon-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.kg-icon-btn.is-active{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.kg-icon-btn:disabled{opacity:.35;cursor:default}
.kg-icon-btn svg{width:14px;height:14px}
.kg-icon-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.kg-banner{padding:5px 12px;font-size:10px;color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.kg-canvas-wrap{position:relative;flex:1;min-height:0;overflow:hidden;background:radial-gradient(circle at 50% 40%,var(--dsw-alias-bg-layer-1),transparent 72%)}
.kg-canvas{position:absolute;inset:0}
.kg-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-base) 78%,transparent);backdrop-filter:blur(2px);z-index:2}
.kg-overlay p{margin:0}
.kg-overlay-error{color:var(--dsw-alias-state-error-primary)}
.kg-overlay-soft{pointer-events:none;background:transparent;backdrop-filter:none;justify-content:flex-start;padding-top:18px}
.kg-error-detail{font-size:11px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow-wrap:anywhere}
.kg-button{height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer}
.kg-button:hover{background:var(--dsw-alias-bg-layer-2)}
.kg-canvas-actions{position:absolute;top:8px;right:8px;display:flex;flex-direction:column;gap:4px;z-index:3;padding:3px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 82%,transparent);border:1px solid var(--dsw-alias-border-l1);backdrop-filter:blur(4px)}
.kg-drawer-scrim{position:absolute;inset:0;background:rgba(2,6,23,.2);z-index:4}
.kg-drawer{position:absolute;top:0;right:0;bottom:0;width:min(88%,360px);z-index:5;display:flex;flex-direction:column;background:var(--dsw-alias-bg-overlay);border-left:1px solid var(--dsw-alias-border-l1);box-shadow:-12px 0 32px rgba(2,6,23,.18);animation:kg-slide-in .18s ease-out}
@keyframes kg-slide-in{from{transform:translateX(16px);opacity:.4}to{transform:none;opacity:1}}
.kg-drawer-head{display:flex;align-items:flex-start;gap:8px;padding:12px 12px 8px;flex:none}
.kg-drawer-head .kg-dot{margin-top:6px}
.kg-drawer-title{flex:1;min-width:0;font-size:14px;font-weight:600;margin:0;overflow-wrap:anywhere}
.kg-drawer-body{overflow:auto;padding:0 12px 16px;display:flex;flex-direction:column;gap:11px}
.kg-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px}
.kg-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px}
.kg-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
.kg-tags{display:flex;flex-wrap:wrap;gap:4px}
.kg-tag{padding:2px 6px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10px}
.kg-section-title{margin:2px 0 0;font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.06em}
.kg-field-hint{font-size:10px;color:var(--dsw-alias-label-secondary);line-height:1.4}
.kg-desc{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55}
.kg-empty-line{margin:0;color:var(--dsw-alias-label-secondary);font-style:italic;font-size:11px}
.kg-relations{display:flex;flex-direction:column;gap:4px}
.kg-relation{display:flex;flex-direction:column;gap:2px;text-align:left;padding:7px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:inherit;cursor:pointer;font:inherit;min-width:0}
.kg-relation:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.kg-relation-top{display:flex;align-items:baseline;gap:6px;min-width:0}
.kg-relation-headline{flex-wrap:wrap;font-size:12px;line-height:1.45}
.kg-rel-label{font-size:10px;font-weight:600;color:var(--dsw-alias-brand-primary);white-space:nowrap}
.kg-rel-arrow{color:var(--dsw-alias-label-secondary);font-size:10px;flex:none}
.kg-rel-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.kg-rel-desc{font-size:10px;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.kg-attachments{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none}
.kg-attachment{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:10px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kg-form{display:flex;flex-direction:column;gap:9px}
.kg-field{display:flex;flex-direction:column;gap:4px}
.kg-field-label{font-size:10px;font-weight:600;color:var(--dsw-alias-label-secondary);text-transform:uppercase;letter-spacing:.05em}
.kg-input,.kg-select,.kg-textarea{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:6px 8px;outline:none}
.kg-input:focus,.kg-select:focus,.kg-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.kg-textarea{min-height:150px;resize:vertical;line-height:1.5}
.kg-form-actions{display:flex;justify-content:flex-end;gap:6px;margin-top:2px}
.kg-primary{height:26px;padding:0 12px;border:1px solid var(--dsw-alias-brand-primary);border-radius:6px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.kg-primary:disabled,.kg-button:disabled{opacity:.5;cursor:default}
.kg-danger-solid{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
.kg-confirm{display:flex;flex-direction:column;gap:6px;padding:9px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l1));border-radius:7px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,var(--dsw-alias-bg-layer-1))}
.kg-confirm p{margin:0}
.kg-confirm-title{font-size:12px;font-weight:600}
.kg-error-line{margin:0;color:var(--dsw-alias-state-error-primary);font-size:11px}
.kg-footnote{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:10px}
.kg-link{padding:0;border:0;background:none;color:var(--dsw-alias-brand-primary);font:inherit;text-align:left;cursor:pointer;overflow-wrap:anywhere}
.kg-link:hover{text-decoration:underline}
.kg-loading-line{display:flex;align-items:center;gap:7px;margin:6px 0;color:var(--dsw-alias-label-secondary);font-size:11px}
.kg-spinner{width:13px;height:13px;border:1.7px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;display:inline-block;animation:kg-spin .8s linear infinite;flex:none}
@keyframes kg-spin{to{transform:rotate(360deg)}}
.kg-legend{display:flex;align-items:center;gap:5px;padding:7px 10px 3px;border-top:1px solid var(--dsw-alias-border-l1);overflow-x:auto;scrollbar-width:none;flex:none}
.kg-legend::-webkit-scrollbar{display:none}
.kg-chip{display:inline-flex;align-items:center;gap:4px;flex:none;height:22px;padding:0 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:10px;cursor:pointer;white-space:nowrap}
.kg-chip:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.kg-chip.is-on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.kg-chip.is-off{opacity:.38;text-decoration:line-through}
.kg-chip-count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.kg-status{padding:4px 12px 8px;color:var(--dsw-alias-label-secondary);font-size:10px;flex:none;font-variant-numeric:tabular-nums}
`;

/**
 * The canvas, controls and inspector.
 * @param props - slot props: translated copy and the theme source.
 * @returns the graph panel.
 */
export function GraphPanel({ t, theme, sessionId }) {
  const themeSource = useMemo(() => theme ?? FALLBACK_THEME_SOURCE, [theme]);
  const themeSnapshot = useSyncExternalStore(
    themeSource.subscribe,
    themeSource.getSnapshot,
    themeSource.getSnapshot
  );
  const dark = themeSnapshot?.active?.colorScheme === 'dark';
  const darkRef = useRef(dark);
  darkRef.current = dark;

  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [disabledTypes, setDisabledTypes] = useState(() => new Set());
  const [labelsOn, setLabelsOn] = useState(true);
  const [focusMode, setFocusMode] = useState(false);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [creatingNode, setCreatingNode] = useState(false);

  const containerRef = useRef(null);
  const cyRef = useRef(null);
  const detailCacheRef = useRef(new Map());

  // Load the compact snapshot.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    readJson(GRAPH_URL, controller.signal)
      .then((data) => {
        // Accept the current `{ graph: { nodes, edges } }` envelope and the
        // earlier flat `{ nodes, edges }` shape, so a client/Host version
        // skew fails visibly in the panel rather than crashing the slot.
        const raw = data?.graph ?? (Array.isArray(data?.nodes) ? data : undefined);
        if (raw === undefined || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
          throw new Error('The graph endpoint returned an unexpected payload.');
        }
        setGraph({
          nodes: raw.nodes,
          edges: raw.edges,
          totals: raw.totals ?? { nodes: raw.nodes.length, edges: raw.edges.length },
          truncated: raw.truncated === true,
        });
        detailCacheRef.current.clear();
        setSelected(null);
      })
      .catch((cause) => {
        if (cause?.name !== 'AbortError') setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [reloadKey]);

  // Mount Cytoscape once.
  useEffect(() => {
    ensureFcose();
    const container = containerRef.current;
    if (container === null) return undefined;
    const cy = cytoscape({
      container,
      elements: [],
      style: buildStyle(darkRef.current),
      layout: { name: 'preset' },
      minZoom: 0.12,
      maxZoom: 3,
      wheelSensitivity: 0.18,
      boxSelectionEnabled: false,
      selectionType: 'single',
    });
    cyRef.current = cy;
    const onNode = (event) => setSelected({ kind: 'node', id: event.target.id() });
    const onEdge = (event) => setSelected({ kind: 'edge', id: event.target.id() });
    const onBackground = (event) => {
      if (event.target === cy) setSelected(null);
    };
    const onDouble = (event) => {
      const node = event.target;
      cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.1) }, { duration: 260 });
    };
    cy.on('tap', 'node', onNode);
    cy.on('tap', 'edge', onEdge);
    cy.on('tap', onBackground);
    cy.on('dbltap', 'node', onDouble);
    let measuredWidth = 0;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            const rect = container.getBoundingClientRect();
            cy.resize();
            // A tab mounted while the Sidebar is collapsed measures zero; fit
            // once when it first gains real space so the graph is not off-screen.
            if (measuredWidth === 0 && rect.width > 0 && cy.nodes().length > 0) {
              cy.fit(cy.elements(), 48);
            }
            measuredWidth = rect.width;
          });
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Rebuild the style when the host theme flips.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy !== null) cy.style(buildStyle(dark));
  }, [dark]);

  // Replace the graph, keeping positions when the topology did not grow.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null || graph === null) return;
    const nodes = graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.name,
        name: node.name,
        type: node.type,
        tags: node.tags,
        in: node.in,
        out: node.out,
        degree: node.degree,
        size: 26 + Math.min(34, Math.sqrt(Math.max(0, node.degree)) * 10),
        color: typeColor(node.type),
        updated_at: node.updated_at,
      },
    }));
    const edges = graph.edges.map((edge) => ({
      data: {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        relation: edge.relation,
        label: edge.relation,
        description: edge.description,
      },
    }));
    const nodeIds = nodes.map((node) => node.data.id).sort();
    const edgeIds = edges.map((edge) => edge.data.id).sort();
    const currentNodes = cy
      .nodes()
      .map((node) => node.id())
      .sort();
    const currentEdges = cy
      .edges()
      .map((edge) => edge.id())
      .sort();
    const sameTopology =
      nodeIds.length === currentNodes.length &&
      edgeIds.length === currentEdges.length &&
      nodeIds.every((id, index) => id === currentNodes[index]) &&
      edgeIds.every((id, index) => id === currentEdges[index]);

    if (sameTopology) {
      // An edit changes data, not structure: update in place so the viewport
      // and node positions do not jump.
      cy.batch(() => {
        for (const definition of nodes) cy.getElementById(definition.data.id).data(definition.data);
        for (const definition of edges) cy.getElementById(definition.data.id).data(definition.data);
      });
      return;
    }

    const positions = new Map();
    cy.nodes().forEach((node) => positions.set(node.id(), { ...node.position() }));
    const missing = nodes.some((node) => !positions.has(node.data.id));
    cy.batch(() => {
      cy.elements().remove();
      cy.add([...nodes, ...edges]);
    });
    if (!missing) {
      cy.nodes().forEach((node) => {
        const position = positions.get(node.id());
        if (position !== undefined) node.position(position);
      });
    }
    if (missing || nodes.length === 0) runLayout(cy);
    else cy.fit(cy.elements(), 48);
  }, [graph]);

  // Apply search, type filters, neighborhood focus and selection classes.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) return;
    const needle = query.trim().toLowerCase();
    const matches = new Set();
    cy.nodes().forEach((node) => {
      const data = node.data();
      const haystack = `${data.name} ${data.type} ${(data.tags ?? []).join(' ')}`.toLowerCase();
      const visible = !disabledTypes.has(data.type) && (needle.length === 0 || haystack.includes(needle));
      node.toggleClass('kg-dim', !visible);
      if (visible) matches.add(node.id());
    });
    cy.edges().forEach((edge) => {
      const visible = matches.has(edge.source().id()) && matches.has(edge.target().id());
      edge.toggleClass('kg-dim', !visible);
    });
    cy.elements().removeClass('kg-hidden');
    if (focusMode && selected?.kind === 'node') {
      const node = cy.getElementById(selected.id);
      if (node.nonempty()) {
        cy.elements().addClass('kg-hidden');
        node.closedNeighborhood().removeClass('kg-hidden');
      }
    }
    cy.elements().removeClass('kg-selected');
    if (selected !== null) {
      const element = cy.getElementById(selected.id);
      if (element.nonempty()) element.addClass('kg-selected');
    }
    cy.elements().toggleClass('kg-labels-off', !labelsOn);
  }, [graph, query, disabledTypes, selected, focusMode, labelsOn]);

  // Fit the focused neighborhood when focus mode or the selection changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null || selected?.kind !== 'node' || !focusMode) return;
    const node = cy.getElementById(selected.id);
    if (node.nonempty()) {
      cy.animate({ fit: { eles: node.closedNeighborhood(), padding: 44 } }, { duration: 320 });
    }
  }, [focusMode, selected]);

  // Fetch the selected entity's full record.
  useEffect(() => {
    if (selected?.kind !== 'node') {
      setDetail(null);
      return undefined;
    }
    const id = selected.id;
    const cached = detailCacheRef.current.get(id);
    if (cached !== undefined) {
      setDetail({ node: cached });
      return undefined;
    }
    const controller = new AbortController();
    setDetail({ loading: true });
    readJson(`${NODE_URL}?id=${encodeURIComponent(id)}`, controller.signal)
      .then((data) => {
        detailCacheRef.current.set(id, data.node);
        setDetail({ node: data.node });
      })
      .catch((cause) => {
        if (cause?.name !== 'AbortError') {
          setDetail({ error: cause instanceof Error ? cause.message : String(cause) });
        }
      });
    return () => controller.abort();
  }, [selected]);

  // Escape closes the inspector.
  useEffect(() => {
    if (selected === null) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // Neighborhood focus only means something while an entity is selected.
  useEffect(() => {
    if (selected?.kind !== 'node') setFocusMode(false);
  }, [selected]);

  const typeCounts = useMemo(() => {
    const counts = new Map();
    for (const node of graph?.nodes ?? []) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    return TYPE_ORDER.filter((type) => counts.has(type)).map((type) => [type, counts.get(type)]);
  }, [graph]);

  const visibleCount = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (graph?.nodes ?? []).filter((node) => {
      if (disabledTypes.has(node.type)) return false;
      if (needle.length === 0) return true;
      return `${node.name} ${node.type} ${node.tags.join(' ')}`.toLowerCase().includes(needle);
    }).length;
  }, [graph, query, disabledTypes]);

  const nodeById = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.id, node])), [graph]);
  const selectedEdge = useMemo(() => {
    if (selected?.kind !== 'edge') return null;
    if (selected.edge !== undefined) return selected.edge;
    if (graph === null) return null;
    return graph.edges.find((edge) => edge.id === selected.id) ?? null;
  }, [selected, graph]);

  const fitGraph = useCallback(() => {
    const cy = cyRef.current;
    if (cy !== null && cy.nodes().length > 0) {
      cy.animate({ fit: { eles: cy.elements(), padding: 48 } }, { duration: 260 });
    }
  }, []);

  const relayout = useCallback(() => {
    const cy = cyRef.current;
    if (cy !== null) runLayout(cy);
  }, []);

  const toggleType = useCallback((type) => {
    setDisabledTypes((previous) => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  }, []);

  const selectNode = useCallback((id) => setSelected({ kind: 'node', id }), []);

  const selectEdge = useCallback(
    (fromId, relation, toId) => {
      const edge = graph?.edges.find(
        (candidate) =>
          candidate.source === fromId && candidate.relation === relation && candidate.target === toId
      );
      if (edge !== undefined) {
        setSelected({ kind: 'edge', id: edge.id });
        return;
      }
      // The edge can be outside a capped snapshot. Keep the edge inspector
      // usable by carrying the immutable triple until its detail is fetched.
      setSelected({
        kind: 'edge',
        id: `virtual:${fromId}:${relation}:${toId}`,
        edge: { source: fromId, relation, target: toId, description: '' },
      });
    },
    [graph]
  );

  const refreshGraph = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  const onNodeUpdated = useCallback((updated) => {
    detailCacheRef.current.set(updated.id, updated);
    setDetail({ node: updated });
    setGraph((previous) => {
      if (previous === null) return previous;
      return {
        ...previous,
        nodes: previous.nodes.map((node) =>
          node.id === updated.id
            ? {
                ...node,
                name: updated.name,
                type: updated.type,
                tags: [...(updated.tags ?? [])],
                updated_at: updated.updated_at,
              }
            : node
        ),
      };
    });
  }, []);

  return (
    <div className="kg-root">
      <style>{CSS}</style>
      <div className="kg-header">
        <div className="kg-heading">
          <span className="kg-heading-icon">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="6" cy="7" r="2.1" />
              <circle cx="18" cy="7" r="2.1" />
              <circle cx="12" cy="18" r="2.1" />
              <path d="M8 7h8M7 8.8l4 7.4M17 8.8l-4 7.4" />
            </svg>
          </span>
          <span className="kg-heading-title">{t('graphTitle')}</span>
          <span className="kg-heading-count">
            {graph === null ? '' : `${graph.nodes.length} · ${graph.edges.length}`}
          </span>
          <span className="kg-heading-spacer" />
          <IconButton
            label={t('addEntity')}
            onClick={() => {
              setSelected(null);
              setCreatingNode(true);
            }}
          >
            <PlusIcon />
          </IconButton>
          <IconButton label={t('refresh')} onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </div>
        <input
          className="kg-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('searchPlaceholder')}
          aria-label={t('searchPlaceholder')}
          spellCheck={false}
        />
      </div>

      {graph?.truncated ? (
        <div className="kg-banner">
          {t('partialView')} {graph.nodes.length}/{graph.totals?.nodes ?? graph.nodes.length} ·{' '}
          {graph.edges.length}/{graph.totals?.edges ?? graph.edges.length}
        </div>
      ) : null}

      <div className="kg-canvas-wrap">
        <div ref={containerRef} className="kg-canvas" />

        {loading ? (
          <div className="kg-overlay" role="status">
            <Spinner />
            <p>{t('loading')}</p>
          </div>
        ) : null}
        {!loading && error !== null ? (
          <div className="kg-overlay kg-overlay-error" role="alert">
            <p>{t('loadFailed')}</p>
            <p className="kg-error-detail">{error}</p>
            <button type="button" className="kg-button" onClick={() => setReloadKey((key) => key + 1)}>
              {t('retry')}
            </button>
          </div>
        ) : null}
        {!loading && error === null && graph !== null && graph.nodes.length === 0 ? (
          <div className="kg-overlay">
            <p>{t('empty')}</p>
          </div>
        ) : null}
        {!loading && error === null && graph !== null && graph.nodes.length > 0 && visibleCount === 0 ? (
          <div className="kg-overlay kg-overlay-soft">
            <p>{t('noMatches')}</p>
          </div>
        ) : null}

        <div className="kg-canvas-actions">
          <IconButton
            label={t('fit')}
            onClick={fitGraph}
            disabled={graph === null || graph.nodes.length === 0}
          >
            <FitIcon />
          </IconButton>
          <IconButton
            label={t('relayout')}
            onClick={relayout}
            disabled={graph === null || graph.nodes.length === 0}
          >
            <LayoutIcon />
          </IconButton>
          <IconButton label={t('labels')} active={labelsOn} onClick={() => setLabelsOn((value) => !value)}>
            <LabelIcon />
          </IconButton>
          <IconButton
            label={t('focus')}
            active={focusMode}
            disabled={selected?.kind !== 'node'}
            onClick={() => setFocusMode((value) => !value)}
          >
            <FocusIcon />
          </IconButton>
        </div>

        {selected !== null || creatingNode ? (
          <div
            className="kg-drawer-scrim"
            onClick={() => {
              setSelected(null);
              setCreatingNode(false);
            }}
            aria-hidden="true"
          />
        ) : null}
        {creatingNode ? (
          <NodeCreateDrawer
            t={t}
            sessionId={sessionId}
            onClose={() => setCreatingNode(false)}
            onCreated={() => {
              setCreatingNode(false);
              refreshGraph();
            }}
          />
        ) : null}
        {selected?.kind === 'node' ? (
          <EntityDrawer
            key={selected.id}
            detail={detail}
            meta={nodeById.get(selected.id)}
            nodes={graph?.nodes ?? []}
            t={t}
            sessionId={sessionId}
            onClose={() => setSelected(null)}
            onSelectEdge={selectEdge}
            onNodeUpdated={onNodeUpdated}
            onNodeDeleted={refreshGraph}
            onEdgeChanged={refreshGraph}
          />
        ) : null}
        {selected?.kind === 'edge' && selectedEdge !== null ? (
          <EdgeDrawer
            key={edgeIdentity(selectedEdge)}
            edge={selectedEdge}
            siblings={(graph?.edges ?? []).filter(
              (candidate) =>
                candidate.source === selectedEdge.source &&
                candidate.target === selectedEdge.target &&
                candidate.id !== selectedEdge.id
            )}
            nodeById={nodeById}
            t={t}
            sessionId={sessionId}
            onClose={() => setSelected(null)}
            onSelectNode={selectNode}
            onChanged={refreshGraph}
          />
        ) : null}
      </div>

      <div className="kg-legend">
        <button
          type="button"
          className={`kg-chip${disabledTypes.size === 0 ? ' is-on' : ''}`}
          onClick={() => setDisabledTypes(new Set())}
        >
          {t('all')}
        </button>
        {typeCounts.map(([type, count]) => (
          <button
            key={type}
            type="button"
            className={`kg-chip${disabledTypes.has(type) ? ' is-off' : ''}`}
            onClick={() => toggleType(type)}
            title={`${type} (${count})`}
          >
            <span className="kg-dot" style={{ background: typeColor(type) }} />
            <span>{type}</span>
            <span className="kg-chip-count">{count}</span>
          </button>
        ))}
      </div>
      <div className="kg-status">
        {t('entities')} {graph?.nodes.length ?? 0} · {t('relations')} {graph?.edges.length ?? 0}
        {query.trim().length > 0 || disabledTypes.size > 0 ? ` · ${visibleCount} ${t('shown')}` : ''}
        {focusMode && selected?.kind === 'node' ? ` · ${t('focusOn')}` : ''}
      </div>
    </div>
  );
}
