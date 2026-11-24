import fs from 'node:fs';
import path from 'node:path';
import { run } from './sdk';

/**
 * Git for project folders: status, recent commits, clone, and the release commit/tag/push.
 * Always runs `git` directly with an argument list (no shell), so paths and messages are never interpreted.
 * GIT_TERMINAL_PROMPT=0: a missing login fails fast instead of waiting forever for a terminal prompt.
 */
const ENV = { GIT_TERMINAL_PROMPT: '0' };
const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

export const git = (dir: string, args: string[], timeoutMs = 30_000) => run('git', ['-C', dir, ...args], timeoutMs, ENV);

export interface GitInfo {
  repo: boolean;
  branch: string | null;
  remote: string | null;
  /** Remote as a browsable https URL (GitHub/GitLab/Bitbucket), when it can be derived. */
  web_url: string | null;
  ahead: number;
  behind: number;
  changed: { status: string; file: string }[];
  commits: { hash: string; subject: string; author: string; date: string }[];
}

/** https://github.com/owner/repo for both https and git@ remotes; null for anything else. */
export function webUrl(remote: string | null): string | null {
  if (!remote) return null;
  const m = remote.match(/^(?:https:\/\/|git@)([\w.-]+)[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `https://${m[1]}/${m[2]}/${m[3]}` : null;
}

export async function gitInfo(dir: string): Promise<GitInfo> {
  const empty: GitInfo = { repo: false, branch: null, remote: null, web_url: null, ahead: 0, behind: 0, changed: [], commits: [] };
  if (!fs.existsSync(dir)) return empty;
  const top = await git(dir, ['rev-parse', '--show-toplevel'], 10_000);
  if (!top.ok) return empty;
  const [status, remote, log] = await Promise.all([
    git(dir, ['status', '--porcelain=v1', '--branch'], 20_000),
    git(dir, ['remote', 'get-url', 'origin'], 10_000),
    git(dir, ['log', '-n', '12', '--pretty=format:%h%x1f%s%x1f%an%x1f%cI'], 20_000),
  ]);
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  const branch = head.split('...')[0].replace(/^No commits yet on /, '') || null;
  const remoteUrl = remote.ok ? remote.stdout.trim() || null : null;
  return {
    repo: true,
    branch,
    remote: remoteUrl,
    web_url: webUrl(remoteUrl),
    ahead: Number(head.match(/ahead (\d+)/)?.[1] ?? 0),
    behind: Number(head.match(/behind (\d+)/)?.[1] ?? 0),
    changed: lines.slice(0, 200).map((l) => ({ status: l.slice(0, 2).trim() || '?', file: l.slice(3) })),
    commits: log.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [hash, subject, author, date] = l.split('\x1f');
        return { hash, subject, author, date };
      }),
  };
}

/** Only well-formed GitHub/GitLab/Bitbucket repository URLs (https or git@). */
const REPO_URL = /^(https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\/[\w.-]+\/[\w.-]+?(\.git)?\/?|git@(github\.com|gitlab\.com|bitbucket\.org):[\w.-]+\/[\w.-]+?(\.git)?)$/;

/** Clone a repository into a new folder (the folder must not exist yet; its parent must). */
export async function cloneRepo(url: string, destInput: string, onLine?: (l: string) => void): Promise<string> {
  const u = url.trim();
  if (!REPO_URL.test(u)) throw bad('Use a repository URL like https://github.com/you/my_app');
  const dest = path.resolve(destInput.trim());
  if (!path.isAbsolute(destInput.trim())) throw bad('Use a full folder path, e.g. M:\\projects\\my_app');
  if (/[\0\r\n"<>|]/.test(dest)) throw bad('Invalid characters in the folder path');
  if (fs.existsSync(dest)) throw bad(`${dest} already exists — pick a new folder, or add the existing folder instead`);
  if (!fs.existsSync(path.dirname(dest))) throw bad(`Parent folder ${path.dirname(dest)} does not exist`);
  onLine?.(`git clone ${u} ${dest}`);
  const r = await run('git', ['clone', '--', u, dest], 20 * 60_000, ENV);
  if (!r.ok) {
    const msg = `${r.stderr || r.error || ''}`.trim();
    throw bad(
      /Authentication|could not read Username|terminal prompts disabled/i.test(msg)
        ? 'Git could not sign in to this repository. Clone it once in a terminal (Git Credential Manager remembers the login), then add the folder here.'
        : `git clone failed: ${msg.split(/\r?\n/).slice(-3).join(' ')}`,
      502,
    );
  }
  return dest;
}
