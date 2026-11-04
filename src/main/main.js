/**
 * OLiteatry — Electron main process.
 * Owns the window, file dialogs and disk writes. The renderer is untrusted:
 * it never touches fs directly (contextIsolation on, nodeIntegration off).
 */
import { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const IS_SELFTEST = process.argv.includes('--selftest');
const MAKE_ICON = process.argv.includes('--make-icon');
const IS_DEV = process.argv.includes('--dev');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (IS_DEV) app.commandLine.appendSwitch('remote-debugging-port', '9223');
app.setName('OLiteatry');

let win = null;

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1500, Math.max(1200, workArea.width - 24)),
    height: Math.min(950, Math.max(720, workArea.height - 24)),
    minWidth: 1180,
    minHeight: 740,
    frame: false,
    show: false,
    backgroundColor: '#150e1f',
    title: 'OLiteatry',
    icon: path.join(ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      webgl: true,
    },
  });

  win.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));

  win.webContents.on('console-message', (_e, level, message, line, source) => {
    // eslint-disable-next-line no-console
    console.log(`[console:${level}] ${message}  (${source}:${line})`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    // eslint-disable-next-line no-console
    console.log(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    // eslint-disable-next-line no-console
    console.log(`[preload-error] ${preloadPath} ${err}`);
  });

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  win.on('closed', () => {
    win = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createIconWindow() {
  const w = new BrowserWindow({
    width: 512,
    height: 512,
    x: -2200,
    y: 0,
    show: true,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: false },
  });
  w.loadFile(path.join(ROOT, 'src', 'renderer', 'icon.html'));
  return w;
}

/** Screenshot + diagnostics, used by `npm run selftest` and by CI. */
async function runSelftest() {
  const atArg = process.argv.find((a) => a.startsWith('--at='));
  const at = atArg ? Number(atArg.split('=')[1]) : null;
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      ready = await win.webContents.executeJavaScript('Boolean(window.__oliteatry?.ready)');
    } catch {
      ready = false;
    }
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  await new Promise((r) => setTimeout(r, 1200));

  if (at !== null && Number.isFinite(at)) {
    try {
      await win.webContents.executeJavaScript(`window.__oliteatry.seek(${at})`);
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  // a packaged build lives inside app.asar (read-only): keep artifacts in temp
  const dir = app.isPackaged
    ? path.join(app.getPath('temp'), 'oliteatry-selftest')
    : path.join(ROOT, 'dist-selftest');
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const shot = path.join(dir, `selftest-${at !== null ? `at${at}-` : ''}${stamp}.png`);
  const image = await win.webContents.capturePage();
  await fs.writeFile(shot, image.toPNG());

  let report = { ready };
  try {
    const raw = await win.webContents.executeJavaScript(
      'window.__oliteatry && window.__oliteatry.report ? JSON.stringify(window.__oliteatry.report()) : JSON.stringify({ ok: false, error: window.__bootError || "renderer never reported" })',
    );
    report = { ready, ...JSON.parse(raw) };
  } catch (err) {
    report.error = String(err);
  }
  report.screenshot = shot;
  await fs.writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));

  // eslint-disable-next-line no-console
  console.log('SELFTEST ' + JSON.stringify(report));
  app.exit(report.ok === false ? 1 : 0);
}

async function makeIcon() {
  const w = createIconWindow();
  await new Promise((resolve) => w.webContents.once('did-finish-load', resolve));

  // capturePage() on a transparent window returns an empty bitmap, so the icon
  // is rasterised in-page and handed back as a data URL.
  let dataUrl = null;
  let error = null;
  const deadline = Date.now() + 8000;
  while (!dataUrl && !error && Date.now() < deadline) {
    dataUrl = await w.webContents.executeJavaScript('window.__icon || null');
    error = await w.webContents.executeJavaScript('window.__iconError || null');
    if (!dataUrl && !error) await new Promise((r) => setTimeout(r, 150));
  }
  if (error) throw new Error(error);
  if (!dataUrl) throw new Error('icon rasterise timed out');

  const base64 = dataUrl.split(',')[1] ?? '';
  await fs.mkdir(path.join(ROOT, 'build'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'build', 'icon.png'), Buffer.from(base64, 'base64'));
  // eslint-disable-next-line no-console
  console.log('ICON build/icon.png', base64.length);
  app.exit(0);
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  if (MAKE_ICON) {
    await makeIcon();
    return;
  }

  createWindow();

  if (IS_SELFTEST) {
    win.webContents.once('did-finish-load', () => {
      runSelftest().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('SELFTEST_FAILED', err);
        app.exit(2);
      });
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------- IPC: files ------------------------------- */

ipcMain.handle('project:save', async (_e, json, suggested = 'palco.oliteproj.json') => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Salvar projeto OLiteatry',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [
      { name: 'Projeto OLiteatry', extensions: ['json'] },
      { name: 'Todos os arquivos', extensions: ['*'] },
    ],
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.writeFile(filePath, json, 'utf8');
  return { canceled: false, path: filePath };
});

ipcMain.handle('project:open', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Abrir projeto OLiteatry',
    properties: ['openFile'],
    filters: [{ name: 'Projeto OLiteatry', extensions: ['json'] }],
  });
  if (canceled || !filePaths?.length) return { canceled: true };
  const content = await fs.readFile(filePaths[0], 'utf8');
  return { canceled: false, path: filePaths[0], content };
});

ipcMain.handle('file:save-binary', async (_e, data, suggested = 'captura.webm', filters = []) => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Salvar arquivo',
    defaultPath: path.join(app.getPath('videos'), suggested),
    filters,
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.writeFile(filePath, Buffer.from(data));
  return { canceled: false, path: filePath };
});

ipcMain.handle('file:save-text', async (_e, text, suggested = 'legendas.srt') => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Salvar arquivo',
    defaultPath: path.join(app.getPath('documents'), suggested),
    filters: [{ name: 'Texto', extensions: ['srt', 'txt'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.writeFile(filePath, text, 'utf8');
  return { canceled: false, path: filePath };
});

/* ------------------------------ IPC: models ------------------------------ */

const MODEL_EXTS = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply', 'dae', 'vrm'];

function extToMime(ext) {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.bmp': return 'image/bmp';
    case '.tga': return 'image/x-tga';
    case '.bin': return 'application/octet-stream';
    case '.glb': return 'model/gltf-binary';
    default: return 'application/octet-stream';
  }
}

/** Read a referenced sibling file into a base64 data URI. */
async function toDataUri(ref, dir) {
  if (!ref || ref.startsWith('data:') || /^https?:/i.test(ref)) return ref;
  const p = path.isAbsolute(ref) ? ref : path.join(dir, ref);
  const buf = await fs.readFile(p);
  return `data:${extToMime(path.extname(p))};base64,${buf.toString('base64')}`;
}

/** Inline glTF external buffers/images so the renderer never touches disk. */
async function inlineGltfResources(json, dir) {
  for (const buf of json.buffers ?? []) {
    if (buf.uri) buf.uri = await toDataUri(buf.uri, dir);
  }
  for (const img of json.images ?? []) {
    if (img.uri) img.uri = await toDataUri(img.uri, dir);
  }
  return json;
}

/** Inline MTL texture maps (map_Kd, bump, …) as data URIs. */
async function inlineMtlTextures(mtlPath) {
  const dir = path.dirname(mtlPath);
  const text = await fs.readFile(mtlPath, 'utf8');
  const keys = ['map_Kd', 'map_Ka', 'map_Ks', 'map_Ns', 'map_d', 'map_bump', 'map_Bump',
    'bump', 'disp', 'decal', 'refl', 'map_Ke', 'map_Pr', 'map_Pm'];
  const re = new RegExp(`^\\s*(?:${keys.join('|')})\\s+(\\S+)`, 'gmi');
  const found = new Map();
  for (const m of text.matchAll(re)) {
    const file = m[1].replace(/^['"]|['"]$/g, '');
    if (!file || file.startsWith('data:') || /^https?:/i.test(file)) continue;
    const p = path.isAbsolute(file) ? file : path.join(dir, file);
    if (!found.has(file)) found.set(file, p);
  }
  let out = text;
  for (const [file, p] of found) {
    try {
      const uri = await toDataUri(file, dir);
      const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(\\s)${esc}(?=\\s|$|\\r|\\n)`, 'g'), `$1${uri}`);
    } catch { /* texture unreadable — leave the reference as-is */ }
  }
  return out;
}

/**
 * Read a 3D model / animation file for the renderer, resolving the external
 * resources of the few formats that carry them (glTF buffers/images, OBJ mtl).
 * Self-contained formats (glb, fbx, stl, ply, dae, vrm) return their raw bytes.
 */
async function readModelAsset(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const name = path.basename(filePath);
  const dir = path.dirname(filePath);

  if (ext === 'gltf') {
    const json = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return { path: filePath, name, ext, kind: 'text', data: JSON.stringify(await inlineGltfResources(json, dir)) };
  }

  if (ext === 'obj') {
    const objText = await fs.readFile(filePath, 'utf8');
    const mtlMatch = objText.match(/^mtllib\s+(.+)$/mi);
    let mtl = null;
    if (mtlMatch) {
      const mtlRef = mtlMatch[1].trim().replace(/^['"]|['"]$/g, '');
      const mtlPath = path.isAbsolute(mtlRef) ? mtlRef : path.join(dir, mtlRef);
      try { mtl = await inlineMtlTextures(mtlPath); } catch { mtl = null; }
    }
    return { path: filePath, name, ext, kind: 'text', data: objText, mtl };
  }

  const data = await fs.readFile(filePath);
  return { path: filePath, name, ext, kind: 'binary', data };
}

ipcMain.handle('model:open', async (_e, opts = {}) => {
  const isAnim = opts.kind === 'animation';
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: isAnim ? 'Importar animação' : 'Importar modelo 3D',
    properties: ['openFile'],
    filters: [
      { name: 'Modelos 3D e animações', extensions: MODEL_EXTS },
      { name: 'Todos os arquivos', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths?.length) return { canceled: true };
  const filePath = filePaths[0];
  try {
    const asset = await readModelAsset(filePath);
    return { canceled: false, ...asset };
  } catch (err) {
    return {
      canceled: false,
      error: String(err?.message ?? err),
      path: filePath,
      name: path.basename(filePath),
      ext: path.extname(filePath).slice(1).toLowerCase(),
      kind: 'binary',
    };
  }
});

ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:close', () => win?.close());
ipcMain.on('log', (_e, ...args) => {
  // eslint-disable-next-line no-console
  console.log('[renderer]', ...args);
});
