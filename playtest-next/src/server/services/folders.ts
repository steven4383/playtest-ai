import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Folder browsing for the "Browse…" buttons: list drives and sub-folders (folders only, never file contents) and
 * mark the interesting ones — Flutter apps, git repositories, Node projects. Plus the native Windows folder dialog.
 */

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const isWin = process.platform === 'win32';
const SKIP = /^(\$|\.|node_modules$|System Volume Information$|Recovery$|PerfLogs$|build$|\.dart_tool$)/i;

export interface FolderEntry {
  name: string;
  path: string;
  flutter: boolean;
  git: boolean;
  node: boolean;
}

function flags(dir: string) {
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  let flutter = false;
  if (has('pubspec.yaml')) {
    try {
      const fd = fs.openSync(path.join(dir, 'pubspec.yaml'), 'r');
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      flutter = /sdk:\s*flutter/.test(buf.subarray(0, n).toString());
    } catch {
      /* unreadable */
    }
  }
  return { flutter, git: has('.git'), node: has('package.json') };
}

/** Start points: drives and your usual folders. */
function places() {
  const home = os.homedir();
  const out: { label: string; path: string }[] = [];
  for (const [label, p] of [
    ['Home', home],
    ['Desktop', path.join(home, 'Desktop')],
    ['Documents', path.join(home, 'Documents')],
    ['Downloads', path.join(home, 'Downloads')],
    ['StudioProjects', path.join(home, 'StudioProjects')],
  ] as const)
    if (fs.existsSync(p)) out.push({ label, path: p });
  const drives: { label: string; path: string }[] = [];
  if (isWin) {
    for (let c = 67; c <= 90; c++) {
      const d = `${String.fromCharCode(c)}:\\`;
      try {
        fs.readdirSync(d);
        drives.push({ label: `${String.fromCharCode(c)}:`, path: d });
      } catch {
        /* no drive / not ready */
      }
    }
  } else drives.push({ label: '/', path: '/' });
  return { places: out, drives };
}

export function listFolders(input?: string) {
  if (!input?.trim()) return { path: null, parent: null, self: null, folders: [] as FolderEntry[], ...places() };
  const raw = input.trim();
  if (!path.isAbsolute(raw)) throw bad('Use a full path');
  const dir = path.resolve(raw);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: any) {
    throw bad(err?.code === 'ENOENT' ? `Folder not found: ${dir}` : `Cannot open ${dir} (${err?.code ?? 'error'})`, err?.code === 'ENOENT' ? 404 : 400);
  }
  const folders = entries
    .filter((e) => e.isDirectory() && !SKIP.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .slice(0, 500)
    .map((e) => {
      const p = path.join(dir, e.name);
      return { name: e.name, path: p, ...flags(p) };
    });
  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, self: flags(dir), folders, ...places() };
}

/** The Windows "Browse for folder" dialog, shown on this PC's desktop. Resolves to the chosen folder or null. */
export function pickFolderNative(initial?: string): Promise<string | null> {
  if (!isWin) return Promise.reject(bad('The native folder dialog is available on Windows only'));
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0 }',
    '$owner.Show(); $owner.Activate()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = 'Choose a folder for PlayTest AI'",
    '$d.ShowNewFolderButton = $true',
    'if ($env:PT_INITIAL -and (Test-Path -LiteralPath $env:PT_INITIAL)) { $d.SelectedPath = $env:PT_INITIAL }',
    "if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    '$owner.Close()',
  ].join('; ');
  return new Promise((resolve, reject) => {
    // The starting folder goes in an environment variable, never into the script text.
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      env: { ...process.env, PT_INITIAL: initial && path.isAbsolute(initial) ? initial : '' },
      windowsHide: false,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(bad(`Could not open the folder dialog: ${e.message}`, 500));
    });
    child.on('close', () => {
      clearTimeout(timer);
      const p = out.trim();
      resolve(p && path.isAbsolute(p) ? p : null);
    });
  });
}
