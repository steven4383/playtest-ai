import { Readable } from 'node:stream';
import busboy from 'busboy';
import { ZodError } from 'zod';
import { config } from './config';

/**
 * The small part of Fastify's API the route modules in ./api use (they were written for Fastify), implemented on
 * top of web Request/Response so they run inside one Next.js Route Handler (src/app/api/v1/[...path]/route.ts).
 *
 * Supported: app.get/post/put/patch/delete with `:param` paths · req.params/query/body/headers/url · req.file()
 * (one streamed multipart file) · req.raw.on('close') · reply.code/status/header/type/send · reply.hijack() +
 * reply.raw.writeHead/write/end for Server-Sent Events · returning a value (JSON, string, Buffer or Node stream).
 */

type Dict = Record<string, string | undefined>;
export interface RouteGeneric {
  Params?: unknown;
  Querystring?: unknown;
  Body?: unknown;
}

export interface UploadedFile {
  filename: string;
  mimetype: string;
  file: Readable & { truncated?: boolean };
}

export interface FastifyRequest<G extends RouteGeneric = RouteGeneric> {
  method: string;
  /** Path and query string, e.g. /api/v1/adb/devices?x=1 (like Fastify's req.url). */
  url: string;
  headers: Headers;
  params: G['Params'] extends object ? G['Params'] : Dict;
  query: G['Querystring'] extends object ? G['Querystring'] : Dict;
  body: unknown;
  /** Only `close` (client went away) is supported — used by the SSE routes to clean up. */
  raw: { on(event: 'close', fn: () => void): void };
  /** The uploaded file of a multipart/form-data request, streamed (never buffered in memory). */
  file(): Promise<UploadedFile | undefined>;
}

export interface RawResponse {
  statusCode: number;
  readonly writableEnded: boolean;
  writeHead(status: number, headers?: Record<string, string>): RawResponse;
  write(chunk: string | Uint8Array): boolean;
  end(chunk?: string | Uint8Array): void;
}

export interface FastifyReply {
  code(status: number): FastifyReply;
  status(status: number): FastifyReply;
  header(name: string, value: string): FastifyReply;
  type(contentType: string): FastifyReply;
  send(payload?: unknown): FastifyReply;
  hijack(): FastifyReply;
  readonly raw: RawResponse;
}

type Handler<G extends RouteGeneric> = (req: FastifyRequest<G>, reply: FastifyReply) => unknown;
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface FastifyInstance {
  get<G extends RouteGeneric = RouteGeneric>(path: string, handler: Handler<G>): void;
  post<G extends RouteGeneric = RouteGeneric>(path: string, handler: Handler<G>): void;
  put<G extends RouteGeneric = RouteGeneric>(path: string, handler: Handler<G>): void;
  patch<G extends RouteGeneric = RouteGeneric>(path: string, handler: Handler<G>): void;
  delete<G extends RouteGeneric = RouteGeneric>(path: string, handler: Handler<G>): void;
}

interface Route {
  method: Method;
  path: string;
  segs: ({ lit: string } | { param: string })[];
  handler: Handler<RouteGeneric>;
}

const BODY_LIMIT = 1024 * 1024; // JSON bodies (Fastify's limit in the old backend)
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding']);

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

class Reply implements FastifyReply {
  statusCode = 200;
  readonly headers = new Headers();
  sent = false;
  payload: unknown = undefined;
  hijacked = false;
  private stream: ReadableStream<Uint8Array> | null = null;
  private rawRes: RawResponse | null = null;

  constructor(private readonly closed: () => void) {}

  code(status: number) {
    this.statusCode = status;
    return this;
  }
  status(status: number) {
    return this.code(status);
  }
  header(name: string, value: string) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) this.headers.set(name, value);
    return this;
  }
  type(contentType: string) {
    return this.header('content-type', contentType);
  }
  send(payload?: unknown) {
    this.sent = true;
    this.payload = payload;
    return this;
  }
  hijack() {
    this.hijacked = true;
    void this.raw; // create the stream now so writes before the response is returned are kept
    return this;
  }

  /** A writable "response" backed by a ReadableStream that becomes the body of the streamed Response. */
  get raw(): RawResponse {
    if (this.rawRes) return this.rawRes;
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      this.closed();
    };
    this.stream = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c;
      },
      cancel: () => finish(), // the client disconnected
    });
    const reply = this;
    const raw: RawResponse = {
      get statusCode() {
        return reply.statusCode;
      },
      set statusCode(v: number) {
        reply.statusCode = v;
      },
      get writableEnded() {
        return ended;
      },
      writeHead(status, headers) {
        reply.statusCode = status;
        for (const [k, v] of Object.entries(headers ?? {})) reply.header(k, String(v));
        return raw;
      },
      write(chunk) {
        if (ended) return false;
        try {
          controller.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk);
          return true;
        } catch {
          finish();
          return false;
        }
      },
      end(chunk) {
        if (ended) return;
        if (chunk !== undefined) raw.write(chunk);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        finish();
      },
    };
    this.rawRes = raw;
    return raw;
  }

  /** The web Response for whatever the handler did: hijacked stream, reply.send(...) or its return value. */
  toResponse(returned: unknown): Response {
    if (this.hijacked && this.stream) return new Response(this.stream, { status: this.statusCode, headers: this.headers });
    const payload = this.sent ? this.payload : returned;
    if (payload instanceof Reply) return payload.toResponse(undefined);
    if (payload instanceof Response) return payload;
    const status = this.statusCode;
    const headers = this.headers;
    if (payload === undefined || payload === null || status === 204 || status === 304) return new Response(null, { status, headers });
    if (payload instanceof Readable || (typeof (payload as { pipe?: unknown }).pipe === 'function' && typeof (payload as { on?: unknown }).on === 'function')) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      return new Response(Readable.toWeb(payload as Readable) as ReadableStream<Uint8Array>, { status, headers });
    }
    if (payload instanceof Uint8Array) {
      if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream');
      return new Response(payload as Uint8Array<ArrayBuffer>, { status, headers });
    }
    if (typeof payload === 'string') {
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
      return new Response(payload, { status, headers });
    }
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(payload), { status, headers });
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof ZodError) return json(400, { error: 'Validation failed', issues: err.issues });
  const e = err as { statusCode?: number; message?: string };
  const code = typeof e?.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
  if (code >= 500) console.error('[api]', err);
  return json(code, { error: e?.message ?? 'Internal error' });
}

async function readJsonBody(request: Request): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD' || !request.body) return undefined;
  const type = request.headers.get('content-type') ?? '';
  if (type.startsWith('multipart/form-data')) return undefined; // streamed by req.file()
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > BODY_LIMIT) throw httpError(413, 'Request body is too large');
  const text = await request.text();
  if (!text) return undefined;
  if (text.length > BODY_LIMIT) throw httpError(413, 'Request body is too large');
  if (!type.includes('application/json')) throw httpError(415, `Unsupported content type "${type || 'none'}" — send JSON`);
  try {
    return JSON.parse(text);
  } catch {
    throw httpError(400, 'Body is not valid JSON');
  }
}

/** First file of a multipart request as a Node stream (size-limited by MAX_APK_SIZE_MB). */
function readFile(request: Request): Promise<UploadedFile | undefined> {
  const type = request.headers.get('content-type') ?? '';
  if (!type.startsWith('multipart/form-data') || !request.body) return Promise.resolve(undefined);
  const maxBytes = config.MAX_APK_SIZE_MB * 1024 * 1024;
  return new Promise((resolve, reject) => {
    let settled = false;
    const bb = busboy({ headers: { 'content-type': type }, limits: { files: 1, fileSize: maxBytes } });
    bb.on('file', (_field, stream, info) => {
      if (settled) return void stream.resume();
      settled = true;
      stream.on('limit', () => stream.destroy(httpError(413, `File is larger than ${config.MAX_APK_SIZE_MB} MB (MAX_APK_SIZE_MB)`)));
      resolve({ filename: info.filename ?? 'upload', mimetype: info.mimeType, file: stream });
    });
    bb.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(httpError(400, `Could not read the upload: ${(err as Error).message}`));
      }
    });
    bb.on('close', () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
    Readable.fromWeb(request.body as import('node:stream/web').ReadableStream<Uint8Array>).pipe(bb);
  });
}

/** Specific routes first: a literal segment beats a :param in the same position (like Fastify's router). */
function compare(a: Route, b: Route) {
  for (let i = 0; i < Math.min(a.segs.length, b.segs.length); i++) {
    const la = 'lit' in a.segs[i];
    const lb = 'lit' in b.segs[i];
    if (la !== lb) return la ? -1 : 1;
  }
  return 0;
}

export function createRouter(prefix: string) {
  const routes: Route[] = [];
  const add = (method: Method) => (path: string, handler: Handler<never>) => {
    const segs = path
      .split('/')
      .filter(Boolean)
      .map((s) => (s.startsWith(':') ? { param: s.slice(1) } : { lit: s }));
    routes.push({ method, path, segs, handler: handler as Handler<RouteGeneric> });
    routes.sort(compare);
  };
  const app: FastifyInstance = { get: add('GET'), post: add('POST'), put: add('PUT'), patch: add('PATCH'), delete: add('DELETE') };

  function match(method: string, parts: string[]) {
    let methodMismatch = false;
    for (const r of routes) {
      if (r.segs.length !== parts.length) continue;
      const params: Dict = {};
      let ok = true;
      for (let i = 0; i < parts.length && ok; i++) {
        const s = r.segs[i];
        if ('lit' in s) ok = s.lit === parts[i];
        else params[s.param] = parts[i];
      }
      if (!ok) continue;
      if (r.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route: r, params };
    }
    return methodMismatch ? 'method' : null;
  }

  /** Handle one request whose path starts with `prefix`. `onRequest` runs before routing (e.g. activity tracking). */
  async function handle(request: Request, onRequest?: (path: string, url: URL) => void): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    // Other websites may not change anything here (the API controls your devices): refuse cross-site writes.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const origin = request.headers.get('origin');
      if (origin && origin !== 'null') {
        let host = '';
        try {
          host = new URL(origin).host;
        } catch {
          /* invalid origin */
        }
        if (host !== request.headers.get('host') && !LOCAL_HOST.test(host)) return json(403, { error: 'Cross-site request refused' });
      }
    }
    let parts: string[];
    try {
      parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      return json(400, { error: 'Bad URL encoding' });
    }
    onRequest?.(path, url);
    const found = match(request.method, parts);
    if (found === null) return json(404, { error: `Not found: ${request.method} ${path}` });
    if (found === 'method') return json(405, { error: `${request.method} is not allowed on ${path}` });

    const closeFns = new Set<() => void>();
    let closed = false;
    const fireClose = () => {
      if (closed) return;
      closed = true;
      for (const fn of closeFns) {
        try {
          fn();
        } catch (err) {
          console.error('[api] close handler failed', err);
        }
      }
    };
    request.signal?.addEventListener('abort', fireClose, { once: true });
    const reply = new Reply(fireClose);
    try {
      const req: FastifyRequest = {
        method: request.method,
        url: url.pathname + url.search,
        headers: request.headers,
        params: found.params,
        query: Object.fromEntries(url.searchParams),
        body: await readJsonBody(request),
        raw: { on: (_event, fn) => void closeFns.add(fn) },
        file: () => readFile(request),
      };
      const returned = await found.route.handler(req, reply);
      return reply.toResponse(returned);
    } catch (err) {
      if (reply.hijacked) {
        reply.raw.end();
        return reply.toResponse(undefined);
      }
      return errorResponse(err);
    }
  }

  return { app, handle };
}
