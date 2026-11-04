#!/usr/bin/env node
/**
 * Portable Windows packaging that does not need symlink privileges.
 *
 * electron-builder's `--win portable` target normally pulls winCodeSign, whose
 * archive contains macOS symlinks; Windows refuses to create them without
 * Developer Mode. `package.json` therefore sets `signAndEditExecutable: false`,
 * which avoids that archive entirely — but it also skips rcedit, so the single
 * exe keeps Electron's default shell icon. This script packages the *edited*
 * app directory instead, which keeps the custom icon.
 *
 *   npm run dist:zip
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const unpacked = path.join(root, 'dist', 'win-unpacked');
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const out = path.join(root, 'dist', `OLiteatry-${pkg.version}-windows-x64-portable.zip`);

if (!existsSync(path.join(unpacked, 'OLiteatry.exe'))) {
  console.log('· building app directory (electron-builder --win dir)');
  execFileSync(path.join(root, 'node_modules', '.bin', 'electron-builder.cmd'), ['--win', 'dir'], {
    cwd: root,
    stdio: 'inherit',
    shell: true,
  });
}

if (existsSync(out)) rmSync(out);

console.log('· compressing', path.relative(root, unpacked));
execFileSync(sevenZip, ['a', '-tzip', '-mx=3', '-mmt=on', out, path.join(unpacked, '*')], {
  cwd: root,
  stdio: 'inherit',
});

const bytes = statSync(out).size;
const sha = createHash('sha256').update(readFileSync(out)).digest('hex');
console.log('');
console.log('  artifact :', path.relative(root, out));
console.log('  size     :', (bytes / 1024 / 1024).toFixed(1), 'MB');
console.log('  sha256   :', sha);
console.log('');
console.log('  Unzip anywhere and run OLiteatry.exe (no installer, no admin).');
