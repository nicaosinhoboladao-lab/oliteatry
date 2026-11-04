#!/usr/bin/env node
/** Fails CI when pt-BR and en drift apart, or when a value is empty. */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const dir = path.join(process.cwd(), 'src', 'locales');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const catalogs = files.map((f) => [f, JSON.parse(readFileSync(path.join(dir, f), 'utf8'))]);
const keys = new Map(catalogs.map(([name, cat]) => [name, Object.keys(cat).sort()]));

const [baseName, baseKeys] = [...keys.entries()][0];
let failed = false;

for (const [name, list] of keys) {
  const missing = baseKeys.filter((k) => !list.includes(k));
  const extra = list.filter((k) => !baseKeys.includes(k));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${name} differs from ${baseName}`);
    if (missing.length) console.error('  missing:', missing.join(', '));
    if (extra.length) console.error('  extra:  ', extra.join(', '));
  }
  for (const [k, v] of Object.entries(catalogs.find(([n]) => n === name)[1])) {
    if (typeof v === 'string' && !v.trim()) {
      failed = true;
      console.error(`${name}: empty value for ${k}`);
    }
  }
}

console.log(`checked ${files.length} locales, ${baseKeys.length} keys`);
process.exit(failed ? 1 : 0);
