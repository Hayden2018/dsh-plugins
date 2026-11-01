export const SITE_MAP_PLACEHOLDER = '{{SITE_MAP}}';

const TABLE_HEADERS = ['Site', 'Task', 'Behavior', 'Tactic', 'Verified'];
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkField(label, field, value, errors) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${label}: "${field}" must be a non-empty string`);
    return false;
  }
  return true;
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Validate the version-1 site-map shape and return English diagnostics. */
export function validateSiteMap(map) {
  const errors = [];
  if (!isRecord(map)) return ['root must be a JSON object'];

  if (map.version !== 1) errors.push(`"version" must be 1, got ${JSON.stringify(map.version)}`);
  if (!Array.isArray(map.sites) || map.sites.length === 0) {
    errors.push('"sites" must be a non-empty array');
    return errors;
  }

  const seen = new Set();
  for (const [index, site] of map.sites.entries()) {
    const label = `sites[${index}]`;
    if (!isRecord(site)) {
      errors.push(`${label}: must be a JSON object`);
      continue;
    }

    for (const field of ['domain', 'site', 'task', 'behavior', 'tactic']) {
      checkField(label, field, site[field], errors);
    }
    if (typeof site.domain === 'string' && !/^[a-z0-9.-]+$/.test(site.domain)) {
      errors.push(
        `${label}: "domain" must be a bare lowercase hostname such as "example.com", got ${JSON.stringify(site.domain)}`
      );
    }
    if (!isCalendarDate(site.lastVerified)) {
      errors.push(
        `${label}: "lastVerified" must be a real calendar date in YYYY-MM-DD format, got ${JSON.stringify(site.lastVerified)}`
      );
    }
    if (site.verifiedBy !== undefined) checkField(label, 'verifiedBy', site.verifiedBy, errors);
    if (site.manualIntervention !== undefined && site.manualIntervention !== true) {
      errors.push(
        `${label}: "manualIntervention" must be true when present, got ${JSON.stringify(site.manualIntervention)}`
      );
    }
    if (typeof site.domain === 'string' && typeof site.task === 'string') {
      const key = `${site.domain}/${site.task}`;
      if (seen.has(key)) errors.push(`${label}: duplicate domain+task "${key}"`);
      seen.add(key);
    }
  }
  return errors;
}

function cell(text) {
  return text.replace(/\|/g, '\\|').replace(/\r\n?|\n/g, '<br>');
}

/** Render the site entries as a Markdown table, preserving their priority order. */
export function renderSiteTable(sites) {
  const rows = sites.map(
    (site) =>
      `| ${cell(site.site)} | ${cell(site.task)} | ${cell(site.behavior)} | ${cell(site.tactic)} | ${cell(site.lastVerified)} |`
  );
  return [`| ${TABLE_HEADERS.join(' | ')} |`, `|${TABLE_HEADERS.map(() => '---').join('|')}|`, ...rows].join(
    '\n'
  );
}

/** Replace the one required site-map token with the rendered table. */
export function renderSkillTemplate(template, sites) {
  const occurrences = template.split(SITE_MAP_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `English skill template must contain ${SITE_MAP_PLACEHOLDER} exactly once; found ${occurrences}`
    );
  }
  return template.replace(SITE_MAP_PLACEHOLDER, () => renderSiteTable(sites));
}
