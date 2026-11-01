#!/usr/bin/env node
/**
 * Validate assets/site-map.json against SITE-MAP-SPEC.md. Exit code 0 with a
 * summary, or 1 with the list of violations. Run before submitting map changes:
 *
 *   node scripts/validate-site-map.js
 */

import { readFile } from 'node:fs/promises';
import { renderSkillTemplate, renderSiteTable, validateSiteMap } from '../lib/site-map.js';

const errors = [];
const mapUrl = new URL('../assets/site-map.json', import.meta.url);
const templateUrl = new URL('../assets/skill-template.en.md', import.meta.url);
let map;
try {
  map = JSON.parse(await readFile(mapUrl, 'utf8'));
} catch (error) {
  console.error(`site-map: invalid JSON or unreadable map: ${error.message}`);
  process.exit(1);
}

errors.push(...validateSiteMap(map));

let template;
try {
  template = await readFile(templateUrl, 'utf8');
} catch (error) {
  errors.push(`English skill template could not be read: ${error.message}`);
}

const hasHan = /\p{Script=Han}/u;
if (template !== undefined && hasHan.test(template.replaceAll('{{SITE_MAP}}', ''))) {
  errors.push('English skill template contains Han characters in plugin-owned prose');
}

if (Array.isArray(map && map.sites)) {
  for (const [index, site] of map.sites.entries()) {
    if (!site || typeof site !== 'object' || Array.isArray(site)) continue;
    for (const field of ['site', 'task', 'behavior', 'tactic', 'verifiedBy']) {
      if (typeof site[field] === 'string' && hasHan.test(site[field])) {
        errors.push(`sites[${index}]: "${field}" contains Han characters; keep site-map prose English-only`);
      }
    }
  }
}

// Check the template's exact token and compare the rendered insertion with the
// site table. Then check every individual row in source priority order; equal
// rows from different domains remain allowed by the schema.
if (template !== undefined && Array.isArray(map && map.sites) && errors.length === 0) {
  try {
    const rendered = renderSkillTemplate(template, map.sites);
    const table = renderSiteTable(map.sites);
    const placeholderIndex = template.indexOf('{{SITE_MAP}}');
    const prefix = template.slice(0, placeholderIndex);
    const suffix = template.slice(placeholderIndex + '{{SITE_MAP}}'.length);
    const actualTable = rendered.slice(prefix.length, rendered.length - suffix.length);
    if (actualTable !== table) errors.push('render: site table differs from the expected rendered table');

    const actualRows = actualTable.split('\n').slice(2);
    if (actualRows.length !== map.sites.length) {
      errors.push(`render: expected ${map.sites.length} site rows, found ${actualRows.length}`);
    } else {
      for (const [index, site] of map.sites.entries()) {
        const expectedRow = renderSiteTable([site]).split('\n')[2];
        if (actualRows[index] !== expectedRow) {
          errors.push(`render: site row ${index} does not match its map entry`);
        }
      }
    }
  } catch (error) {
    errors.push(`render: ${error.message}`);
  }
}

if (errors.length > 0) {
  console.error(`site-map: ${errors.length} violation(s):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
const count = map.sites.length;
console.log(
  `site-map OK: ${count} site${count === 1 ? '' : 's'}, schema valid, English template placeholder and rows valid`
);
