import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config';
import { writeEnv } from '../core/env-file';

/**
 * GitHub: list your repositories (private ones need a token) so a project can be cloned with one click.
 * The token lives in .env (GITHUB_TOKEN) and is only ever sent to api.github.com and to git for a clone.
 */

const API = 'https://api.github.com';
const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });
const TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{40,})$/;
const USER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export interface Repo {
  full_name: string;
  name: string;
  private: boolean;
  description: string | null;
  language: string | null;
  updated_at: string;
  clone_url: string;
  html_url: string;
  default_branch: string;
  fork: boolean;
}

async function gh<T>(p: string, token?: string): Promise<T> {
  const r = await fetch(`${API}${p}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'PlayTest-AI',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (r.status === 401) throw bad('GitHub rejected the token — it may be expired or revoked. Connect again with a new one.', 401);
  if (r.status === 404) throw bad('Not found on GitHub', 404);
  if (r.status === 403) throw bad('GitHub refused the request (rate limit or missing permission). Try again later or connect a token.', 403);
  if (!r.ok) throw bad(`GitHub answered ${r.status}`, 502);
  return (await r.json()) as T;
}

const toRepo = (r: Repo): Repo => ({
  full_name: r.full_name,
  name: r.name,
  private: r.private,
  description: r.description,
  language: r.language,
  updated_at: r.updated_at,
  clone_url: r.clone_url,
  html_url: r.html_url,
  default_branch: r.default_branch,
  fork: r.fork,
});

let userCache: { at: number; token: string; user: { login: string; name: string | null; avatar_url: string } } | null = null;

export const github = {
  /** Default folder for new clones: PROJECTS_DIR, else ~/StudioProjects (Android Studio's), else ~/Projects. */
  projectsDir(): string {
    if (config.PROJECTS_DIR) return config.PROJECTS_DIR;
    const studio = path.join(os.homedir(), 'StudioProjects');
    return fs.existsSync(studio) ? studio : path.join(os.homedir(), 'Projects');
  },

  async status() {
    const base = { projects_dir: this.projectsDir() };
    const token = config.GITHUB_TOKEN;
    if (!token) return { ...base, connected: false as const, login: null, name: null, avatar_url: null };
    try {
      if (!userCache || userCache.token !== token || Date.now() - userCache.at > 5 * 60_000) {
        const u = await gh<{ login: string; name: string | null; avatar_url: string }>('/user', token);
        userCache = { at: Date.now(), token, user: { login: u.login, name: u.name, avatar_url: u.avatar_url } };
      }
      return { ...base, connected: true as const, ...userCache.user };
    } catch (err: any) {
      return { ...base, connected: false as const, login: null, name: null, avatar_url: null, error: err?.message as string };
    }
  },

  async connect(token: string) {
    const t = token.trim();
    if (!TOKEN_RE.test(t)) throw bad('That does not look like a GitHub token (it starts with github_pat_ or ghp_)');
    const u = await gh<{ login: string }>('/user', t);
    writeEnv({ GITHUB_TOKEN: t });
    config.GITHUB_TOKEN = t;
    userCache = null;
    return { connected: true, login: u.login };
  },

  disconnect() {
    writeEnv({ GITHUB_TOKEN: '' });
    config.GITHUB_TOKEN = '';
    userCache = null;
    return { connected: false };
  },

  setProjectsDir(dir: string) {
    const d = path.resolve(dir.trim());
    if (!path.isAbsolute(dir.trim()) || /[\0\r\n"<>|]/.test(d)) throw bad('Use a full folder path, e.g. M:\\projects');
    fs.mkdirSync(d, { recursive: true });
    writeEnv({ PROJECTS_DIR: d });
    config.PROJECTS_DIR = d;
    return { projects_dir: d };
  },

  /** Your repositories (with a token: private ones and organisations too), or a user's public ones. */
  async repos(user?: string): Promise<Repo[]> {
    if (user) {
      if (!USER_RE.test(user)) throw bad('Invalid GitHub username');
      return (await gh<Repo[]>(`/users/${user}/repos?per_page=100&sort=updated`)).map(toRepo);
    }
    const token = config.GITHUB_TOKEN;
    if (!token) throw bad('Connect GitHub with a token first — or list public repositories by username', 409);
    const out: Repo[] = [];
    for (let page = 1; page <= 3; page++) {
      const list = await gh<Repo[]>(`/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member&page=${page}`, token);
      out.push(...list.map(toRepo));
      if (list.length < 100) break;
    }
    return out;
  },

  /**
   * Git environment for cloning github.com with the token — passed as an HTTP header through GIT_CONFIG_* variables,
   * so it never appears in the command line or in the cloned repository's .git/config.
   */
  cloneEnv(url: string): Record<string, string> {
    const token = config.GITHUB_TOKEN;
    if (!token || !/^https:\/\/github\.com\//i.test(url)) return {};
    return {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    };
  },
};
