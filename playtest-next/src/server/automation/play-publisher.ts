import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Google Play Developer API (Android Publisher v3) with a service account — no extra packages:
 * sign a JWT with the account's key, exchange it for an access token, then use the "edits" workflow
 * (insert → upload bundle → set track release → validate or commit).
 *
 * The service-account JSON stays on disk under storage/secrets; its private key never leaves the server.
 */

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const TOKEN_URL = 'https://oauth2.googleapis.com/token'; // fixed: never send the signed JWT to a URL taken from the file
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export interface TrackRelease {
  name?: string;
  versionCodes?: string[];
  status?: string;
  userFraction?: number;
  releaseNotes?: { language: string; text: string }[];
}
export interface Track {
  track: string;
  releases?: TrackRelease[];
}

const bad = (msg: string, statusCode = 400) => Object.assign(new Error(msg), { statusCode });

/** Validate a service-account key file's content (from Google Cloud → IAM → Service accounts → Keys → JSON). */
export function parseServiceAccount(text: string): ServiceAccount {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    throw bad('That file is not JSON — download the key as JSON from Google Cloud (Service account → Keys → Add key)');
  }
  if (j.type !== 'service_account' || typeof j.client_email !== 'string' || typeof j.private_key !== 'string' || !j.private_key.includes('PRIVATE KEY'))
    throw bad('This JSON is not a service-account key (needs type "service_account", client_email and private_key)');
  return { client_email: j.client_email, private_key: j.private_key, project_id: typeof j.project_id === 'string' ? j.project_id : undefined };
}

export const readServiceAccount = (file: string) => parseServiceAccount(fs.readFileSync(file, 'utf8'));

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const tokens = new Map<string, { token: string; exp: number }>();

async function accessToken(sa: ServiceAccount): Promise<string> {
  const cached = tokens.get(sa.client_email);
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }))}`;
  let signature: Buffer;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), sa.private_key);
  } catch {
    throw bad('The service-account private key could not be read — download a new JSON key');
  }
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!r.ok || !j.access_token)
    throw bad(`Google sign-in with the service account failed: ${j.error_description ?? j.error ?? r.status} — the key may be deleted or disabled`, 502);
  tokens.set(sa.client_email, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 });
  return j.access_token;
}

/** Turn Google API errors into something you can act on. */
function explain(status: number, message: string, pkg: string): string {
  if (status === 401) return 'The service account is not authorised — check the key file.';
  if (status === 403)
    return `The service account has no access to ${pkg} in Play Console. Invite it under Play Console → Users and permissions (app access, "Release" permissions). (${message})`;
  if (status === 404) return `Play Console has no app ${pkg} for this account. Create the app and upload the first bundle once by hand. (${message})`;
  if (/version code .* already been used|versionCode/i.test(message)) return `Play already has this version code — bump the version and try again. (${message})`;
  if (/draft app/i.test(message)) return 'This app is still a draft in Play Console: releases must use status "Draft" until the app is published. (' + message + ')';
  return message;
}

async function call<T>(sa: ServiceAccount, pkg: string, method: string, url: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  const token = await accessToken(sa);
  const r = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  const j = text ? JSON.parse(text) : {};
  if (!r.ok) throw bad(explain(r.status, j?.error?.message ?? `HTTP ${r.status}`, pkg), r.status >= 500 ? 502 : 400);
  return j as T;
}

const app = (pkg: string) => `${API}/${encodeURIComponent(pkg)}`;

async function withEdit<T>(sa: ServiceAccount, pkg: string, fn: (editId: string) => Promise<T>, keep = false): Promise<T> {
  const edit = await call<{ id: string }>(sa, pkg, 'POST', `${app(pkg)}/edits`, {});
  try {
    return await fn(edit.id);
  } finally {
    if (!keep) await call(sa, pkg, 'DELETE', `${app(pkg)}/edits/${edit.id}`).catch(() => {});
  }
}

export const playPublisher = {
  /** What is on every track, and the highest version code Play has seen (so the next one is always higher). */
  async status(sa: ServiceAccount, pkg: string) {
    return withEdit(sa, pkg, async (editId) => {
      const { tracks = [] } = await call<{ tracks?: Track[] }>(sa, pkg, 'GET', `${app(pkg)}/edits/${editId}/tracks`);
      const codes = tracks.flatMap((t) => (t.releases ?? []).flatMap((r) => (r.versionCodes ?? []).map(Number)));
      return { tracks, max_version_code: codes.length ? Math.max(...codes) : 0 };
    });
  },

  /**
   * Upload an App Bundle and put it on a track. `dryRun`: Google validates the whole edit, then it is thrown away —
   * nothing is published.
   */
  async publish(
    sa: ServiceAccount,
    pkg: string,
    aabPath: string,
    opts: { track: string; status: 'completed' | 'draft' | 'inProgress'; userFraction?: number | null; notes?: string | null; releaseName?: string; dryRun: boolean },
    log: (line: string) => void,
  ) {
    const edit = await call<{ id: string }>(sa, pkg, 'POST', `${app(pkg)}/edits`, {});
    log(`Opened Play edit ${edit.id}`);
    let finished = false;
    try {
      const size = fs.statSync(aabPath).size;
      log(`Uploading ${(size / 1024 / 1024).toFixed(1)} MB to Google Play…`);
      const token = await accessToken(sa);
      const up = await fetch(`${UPLOAD}/${encodeURIComponent(pkg)}/edits/${edit.id}/bundles?uploadType=media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
        body: fs.readFileSync(aabPath),
        signal: AbortSignal.timeout(30 * 60_000),
      });
      const uj = (await up.json().catch(() => ({}))) as { versionCode?: number; error?: { message?: string } };
      if (!up.ok || !uj.versionCode) throw bad(explain(up.status, uj.error?.message ?? `upload failed (HTTP ${up.status})`, pkg), 502);
      log(`Uploaded — Play accepted version code ${uj.versionCode}`);

      const release: TrackRelease = {
        name: opts.releaseName,
        versionCodes: [String(uj.versionCode)],
        status: opts.status,
        ...(opts.status === 'inProgress' && opts.userFraction ? { userFraction: opts.userFraction } : {}),
        ...(opts.notes ? { releaseNotes: [{ language: 'en-US', text: opts.notes.slice(0, 500) }] } : {}),
      };
      await call(sa, pkg, 'PUT', `${app(pkg)}/edits/${edit.id}/tracks/${encodeURIComponent(opts.track)}`, { track: opts.track, releases: [release] });
      log(`Release set on track "${opts.track}" (${opts.status}${release.userFraction ? `, ${Math.round(release.userFraction * 100)}% rollout` : ''})`);

      if (opts.dryRun) {
        await call(sa, pkg, 'POST', `${app(pkg)}/edits/${edit.id}:validate`);
        log('Dry run: Google Play validated the release — discarding it, nothing was published.');
      } else {
        await call(sa, pkg, 'POST', `${app(pkg)}/edits/${edit.id}:commit`, undefined, 120_000);
        finished = true;
        log(`Committed — version ${uj.versionCode} is on "${opts.track}" in Play Console.`);
      }
      return { version_code: uj.versionCode, edit_id: edit.id };
    } finally {
      if (!finished) await call(sa, pkg, 'DELETE', `${app(pkg)}/edits/${edit.id}`).catch(() => {});
    }
  },
};
