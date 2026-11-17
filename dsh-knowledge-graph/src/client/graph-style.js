/**
 * Visual vocabulary for the graph: one stable colour per entity type, and a
 * Cytoscape style sheet that follows the host light/dark palette.
 *
 * Node colours are data colours, so they survive a theme change; labels, edges,
 * selection rings and surfaces are re-read from the theme snapshot whenever it
 * changes.
 */

/** Entity types in display order. */
export const TYPE_ORDER = [
  'person',
  'task',
  'project',
  'concept',
  'organization',
  'place',
  'event',
  'item',
  'document',
  'quote',
  'fact',
  'other',
];

/** Saturated, theme-neutral colours with enough separation at small sizes. */
const TYPE_COLORS = {
  person: '#6366f1',
  task: '#f59e0b',
  project: '#10b981',
  concept: '#8b5cf6',
  organization: '#ef4444',
  place: '#84cc16',
  event: '#ec4899',
  item: '#06b6d4',
  document: '#64748b',
  quote: '#a855f7',
  fact: '#3b82f6',
  other: '#94a3b8',
};

/**
 * Colour for one entity type.
 * @param type - stored entity type.
 * @returns the CSS colour used by nodes and legend dots.
 */
export function typeColor(type) {
  return TYPE_COLORS[type] ?? TYPE_COLORS.other;
}

/**
 * Build the Cytoscape style sheet for one colour scheme.
 * @param dark - whether the resolved host theme is dark.
 * @returns the style array.
 */
export function buildStyle(dark) {
  const label = dark ? '#e5e7eb' : '#1f2328';
  const muted = dark ? 'rgba(203, 213, 225, 0.34)' : 'rgba(71, 85, 105, 0.30)';
  const edgeText = dark ? 'rgba(226, 232, 240, 0.78)' : 'rgba(51, 65, 85, 0.80)';
  const edgeBackground = dark ? '#11151c' : '#ffffff';
  const accent = dark ? '#93c5fd' : '#2563eb';
  const nodeBorder = dark ? 'rgba(255, 255, 255, 0.24)' : 'rgba(15, 23, 42, 0.16)';

  return [
    {
      selector: 'node',
      style: {
        'background-color': 'data(color)',
        'border-width': 1,
        'border-color': nodeBorder,
        width: 'data(size)',
        height: 'data(size)',
        label: 'data(label)',
        'font-size': '10px',
        'font-family': 'system-ui, -apple-system, "Segoe UI", sans-serif',
        color: label,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 5,
        'text-max-width': '110px',
        'text-wrap': 'ellipsis',
        'min-zoomed-font-size': 7,
        'overlay-opacity': 0,
        'transition-property': 'opacity, border-width, border-color',
        'transition-duration': '120ms',
      },
    },
    { selector: 'node.kg-dim', style: { opacity: 0.14 } },
    { selector: 'node.kg-hidden', style: { display: 'none' } },
    {
      selector: 'node.kg-selected',
      style: {
        'border-width': 3,
        'border-color': accent,
        'overlay-opacity': 0.07,
        'overlay-color': accent,
        'overlay-padding': 9,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.3,
        'line-color': muted,
        'target-arrow-color': muted,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.75,
        'curve-style': 'bezier',
        'control-point-step-size': 26,
        'loop-direction': '-45deg',
        'loop-sweep': '90deg',
        label: 'data(label)',
        'font-size': '8px',
        'font-family': 'system-ui, -apple-system, "Segoe UI", sans-serif',
        color: edgeText,
        'text-rotation': 'autorotate',
        'text-margin-y': -3,
        'text-background-color': edgeBackground,
        'text-background-opacity': 0.82,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
        'min-zoomed-font-size': 7,
        'overlay-opacity': 0,
        'transition-property': 'opacity, width, line-color',
        'transition-duration': '120ms',
      },
    },
    { selector: 'edge.kg-dim', style: { opacity: 0.08 } },
    { selector: 'edge.kg-hidden', style: { display: 'none' } },
    {
      selector: 'edge.kg-selected',
      style: {
        width: 2.4,
        'line-color': accent,
        'target-arrow-color': accent,
        'text-background-opacity': 1,
      },
    },
    { selector: 'node.kg-labels-off', style: { 'text-opacity': 0 } },
    { selector: 'edge.kg-labels-off', style: { 'text-opacity': 0, 'text-background-opacity': 0 } },
  ];
}
