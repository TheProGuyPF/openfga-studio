import { describe, it, expect } from 'vitest';
import { exportAsScript, slugify } from './exportScript';
import type { MigrationTemplate } from './migrationTransform';

const sample: MigrationTemplate = {
  name: 'User memberships',
  description: 'is_active users → admin/member on institution',
  rowFilters: [{ column: 'is_active', mode: 'include', truthyValues: ['true'], caseInsensitive: true }],
  requiredColumns: ['id', 'institution_id'],
  dedupe: false,
  validationMode: 'drop-tuple',
  rules: [
    {
      id: 'membership',
      whenColumnsPresent: [],
      user: { type: 'user', column: 'id' },
      relation: { enum: { column: 'admin', caseInsensitive: true, map: { true: 'admin' }, default: 'member' } },
      object: { type: 'institution', column: 'institution_id' },
    },
  ],
};

describe('exportAsScript', () => {
  it('embeds the template and is a runnable standalone .mjs', () => {
    const out = exportAsScript(sample);
    expect(out.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(out).toContain('const TEMPLATE = {');
    expect(out).toContain('"name": "User memberships"');
    expect(out).toContain('import { parse } from "csv-parse/sync"');
    expect(out).toContain('on_duplicate: "ignore"');
    expect(out).toContain('async function main()');
  });

  it('is deterministic for a given template (snapshot)', () => {
    expect(exportAsScript(sample)).toMatchSnapshot();
  });
});

describe('slugify', () => {
  it('produces a filesystem-safe slug', () => {
    expect(slugify('User memberships')).toBe('user-memberships');
    expect(slugify('  weird / name!! ')).toBe('weird-name');
    expect(slugify('')).toBe('migration');
  });
});
