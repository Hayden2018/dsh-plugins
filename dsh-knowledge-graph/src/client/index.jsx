/**
 * Knowledge Graph client half.
 *
 * Registers three surfaces against the public extension seats:
 * - the right-Sidebar `knowledge-graph` page (a guide card opens it),
 * - its keyed body, which renders the Cytoscape canvas,
 * - the bundle row's configure page with storage status and purge.
 *
 * Graph data is read through the host's `/knowledge-graph/*` routes. The
 * entity and relation inspectors mutate only through the guarded Web routes.
 */
import React from 'react';
import { ensureFcose } from './graph-engine.js';
import { GraphPanel } from './GraphPanel.jsx';
import { MaintenancePanel } from './MaintenancePanel.jsx';

const NS = 'knowledgeGraph';
const TAB_ID = 'dsh-knowledge-graph';
const TAB_KIND = 'knowledge-graph';
const ROW_CONFIG_KEY = 'dsh-knowledge-graph#knowledge-graph';

const en = {
  summary: 'Local SQLite knowledge graph with search, traversal, and purge controls.',
  title: 'Knowledge graph',
  description:
    'Entities and relations are stored in one SQLite database shared by every profile and session on this installation.',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  location: 'Location',
  file: 'Database file',
  present: 'present',
  absent: 'not created yet',
  size: 'Size on disk',
  entitiesLabel: 'Entities',
  relationsLabel: 'Relations',
  revisions: 'Changelog entries',
  schema: 'Schema version',
  loadFailed: 'Could not read the graph.',
  fault: 'Storage problem',
  purgeTitle: 'Delete all graph data',
  purgeHint:
    'This permanently removes every entity, relation, changelog entry, and the database file itself for every DSH profile. Referenced attachments are left untouched, and a later write starts a new empty database.',
  purge: 'Purge graph data',
  purgeConfirm: 'Click again to delete permanently',
  purgeCancel: 'Cancel',
  purging: 'Purging…',
  purged: 'All graph data was deleted. Nothing remains on disk until the next write.',
  purgeFailed: 'Purge failed.',
  sharedNote:
    'The plugin keeps no backup copy. Removing the plugin after a purge leaves no graph files behind in the harness home.',

  graphTitle: 'Knowledge graph',
  graphDescription: 'Explore entities and their relations as an interactive graph.',
  searchPlaceholder: 'Search entities or tags…',
  fit: 'Fit graph',
  relayout: 'Re-run layout',
  labels: 'Toggle labels',
  focus: 'Focus neighborhood',
  all: 'All',
  entities: 'entities',
  relations: 'relations',
  loading: 'Loading graph…',
  retry: 'Retry',
  empty: 'No entities yet. Use + to add one, or ask the agent to save something.',
  noMatches: 'No entities match the current filters.',
  partialView: 'Partial view',
  entity: 'Entity',
  loadingEntity: 'Loading entity…',
  relation: 'Relation',
  noDescription: 'No description.',
  relationsTitle: 'Relations',
  noRelations: 'No relations yet.',
  relationsTruncated: 'Some relations were omitted from this inspector.',
  attachments: 'Attachments',
  updated: 'Updated',
  revision: 'rev',
  close: 'Close',
  edit: 'Edit entity',
  editEntity: 'Edit entity',
  name: 'Name',
  type: 'Type',
  tags: 'Tags',
  tagsHint: 'Comma-separated, e.g. career, 2027',
  descriptionLabel: 'Description',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  nameRequired: 'Name must not be empty.',
  revisionConflict: 'This entity changed elsewhere. Close and reopen it, then retry.',
  edgeHint: 'Click either endpoint to inspect that entity.',
  connectedEntities: 'Connected entities',
  sourceNode: 'Source',
  targetNode: 'Target',
  addEntity: 'Add entity',
  createEntity: 'New entity',
  deleteEntity: 'Delete entity',
  deleteEntityConfirm: 'Delete this entity?',
  deleteEntityHint: 'This removes the entity and records the deletion in the changelog.',
  deleteEntityWithRelations:
    'This entity has connected relations. Deleting it also deletes those relations; the other entities stay.',
  nodeHasEdges: 'This entity gained connected relations. Close and reopen it, then retry.',
  editRelation: 'Edit relation',
  createRelation: 'New relation',
  addRelation: 'Add relation',
  loadingRelation: 'Loading relation…',
  target: 'Target entity',
  targetRequired: 'Choose a target entity.',
  noOtherEntities: 'There is no other entity to connect to yet.',
  relationHint: 'Lowercase snake_case, e.g. works_for',
  relationInvalid: 'Use a lowercase snake_case label such as works_for.',
  relationExists: 'That relation already exists between these entities. Edit it instead.',
  edgeRevisionConflict: 'This relation changed elsewhere. Close and reopen it, then retry.',
  relationMissing: 'This relation no longer exists. Refresh the graph.',
  entityMissing: 'One of these entities no longer exists. Refresh the graph.',
  deleteRelation: 'Delete relation',
  deleteRelationConfirm: 'Delete this relation?',
  deleteRelationHint: 'Only the relation is removed; both entities and their other relations stay.',
  deleting: 'Deleting…',
  create: 'Create',
  shown: 'shown',
  focusOn: 'neighborhood',
};

const zh = {
  summary: '本地 SQLite 知识图谱，支持搜索、遍历与清除。',
  title: '知识图谱',
  description: '实体与关系保存在本安装共享的同一个 SQLite 数据库中，所有配置与会话共用。',
  refresh: '刷新',
  refreshing: '刷新中…',
  location: '存储位置',
  file: '数据库文件',
  present: '已存在',
  absent: '尚未创建',
  size: '磁盘占用',
  entitiesLabel: '实体数',
  relationsLabel: '关系数',
  revisions: '变更记录',
  schema: '架构版本',
  loadFailed: '无法读取图谱。',
  fault: '存储异常',
  purgeTitle: '删除全部图谱数据',
  purgeHint:
    '将永久删除所有配置下的全部实体、关系、变更记录以及数据库文件本身。被引用的附件不会被删除；之后的写入会重新创建一个空数据库。',
  purge: '清除图谱数据',
  purgeConfirm: '再次点击以永久删除',
  purgeCancel: '取消',
  purging: '正在清除…',
  purged: '图谱数据已全部删除；在下一次写入前磁盘上不会留下任何文件。',
  purgeFailed: '清除失败。',
  sharedNote: '该插件不保留任何备份。清除后再卸载插件，不会在 Harness 主目录中留下图谱文件。',

  graphTitle: '知识图谱',
  graphDescription: '以交互式图形浏览实体与它们之间的关系。',
  searchPlaceholder: '搜索实体或标签…',
  fit: '适应视图',
  relayout: '重新布局',
  labels: '显示/隐藏标签',
  focus: '聚焦邻域',
  all: '全部',
  entities: '实体',
  relations: '关系',
  loading: '正在加载图谱…',
  retry: '重试',
  empty: '还没有任何实体。点击 + 添加，或让 Agent 保存一些内容。',
  noMatches: '没有符合当前筛选条件的实体。',
  partialView: '部分视图',
  entity: '实体',
  loadingEntity: '正在加载实体…',
  relation: '关系',
  noDescription: '暂无描述。',
  relationsTitle: '关系',
  noRelations: '暂无关系。',
  relationsTruncated: '此检查器省略了部分关系。',
  attachments: '附件',
  updated: '更新于',
  revision: '版本',
  close: '关闭',
  edit: '编辑实体',
  editEntity: '编辑实体',
  name: '名称',
  type: '类型',
  tags: '标签',
  tagsHint: '用逗号分隔，例如 career, 2027',
  descriptionLabel: '描述',
  save: '保存',
  saving: '保存中…',
  cancel: '取消',
  nameRequired: '名称不能为空。',
  revisionConflict: '该实体已在别处被修改。请关闭后重新打开再试。',
  edgeHint: '点击任意一端可查看该实体。',
  connectedEntities: '关联实体',
  sourceNode: '起点',
  targetNode: '终点',
  addEntity: '添加实体',
  createEntity: '新建实体',
  deleteEntity: '删除实体',
  deleteEntityConfirm: '删除这个实体？',
  deleteEntityHint: '将删除该实体，并在变更记录中记下这次删除。',
  deleteEntityWithRelations: '该实体有关联关系。删除实体时也会删除这些关系；其他实体都会保留。',
  nodeHasEdges: '该实体新增了关联关系。请关闭后重新打开再试。',
  editRelation: '编辑关系',
  createRelation: '新建关系',
  addRelation: '添加关系',
  loadingRelation: '正在加载关系…',
  target: '目标实体',
  targetRequired: '请选择目标实体。',
  noOtherEntities: '还没有其他实体可以连接。',
  relationHint: '小写 snake_case，例如 works_for',
  relationInvalid: '请使用小写 snake_case 标签，例如 works_for。',
  relationExists: '这两个实体之间已存在该关系，请改为编辑现有关系。',
  edgeRevisionConflict: '该关系已在别处被修改。请关闭后重新打开再试。',
  relationMissing: '该关系已不存在，请刷新图谱。',
  entityMissing: '其中一个实体已不存在，请刷新图谱。',
  deleteRelation: '删除关系',
  deleteRelationConfirm: '删除这条关系？',
  deleteRelationHint: '只会删除关系，两个实体及它们的其他关系都会保留。',
  deleting: '删除中…',
  create: '创建',
  shown: '显示',
  focusOn: '邻域',
};

/** Guide-card glyph. */
function GraphIcon({ className, style } = {}) {
  return (
    <svg
      className={className}
      style={style}
      width="100%"
      height="100%"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="7" r="2.1" />
      <circle cx="18" cy="7" r="2.1" />
      <circle cx="12" cy="18" r="2.1" />
      <path d="M8 7h8M7 8.8l4 7.4M17 8.8l-4 7.4" />
    </svg>
  );
}

/** Browser services required by the three registrations. */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'theme'];

/**
 * Register the right-Sidebar tab type, its body, and the maintenance page.
 * @param ctx - client root context.
 */
export function apply(ctx) {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'knowledge-graph: dictionaries');
  ensureFcose();

  const themeSource = {
    getSnapshot: () => ctx.theme.getTheme(),
    subscribe: (listener) => ctx.on('theme/change', listener),
  };

  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        keepMounted: true,
        title: () => t('graphTitle'),
        guide: [
          {
            id: 'graph',
            order: 30,
            title: () => t('graphTitle'),
            description: () => t('graphDescription'),
            icon: GraphIcon,
          },
        ],
      }),
    'knowledge-graph: graph tab type'
  );

  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            inject: (sessionId) => ({ theme: themeSource, sessionId }),
          },
          GraphPanel
        )
      ),
    'knowledge-graph: graph tab body'
  );

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
          MaintenancePanel
        )
      ),
    'knowledge-graph: plugin row page'
  );
}
