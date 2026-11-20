import fs from 'node:fs';
import path from 'node:path';

/**
 * Set KEY=value lines in backend/.env (created from .env.example if missing).
 * Other lines and comments are kept as-is. Used by dashboard settings that must survive a restart.
 */
export function writeEnv(updates: Record<string, string>) {
  const envPath = path.resolve('.env');
  const examplePath = path.resolve('.env.example');
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  for (const [k, v] of Object.entries(updates)) {
    if (/[\r\n]/.test(v)) throw new Error(`Value for ${k} must be a single line`);
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\s*$/, '')}${eol}${line}${eol}`;
  }
  fs.writeFileSync(envPath, text, { mode: 0o600 });
}
