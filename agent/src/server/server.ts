import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { AgentEvent, CanvasGateway } from '../contracts/index.js';
import { AgentRuntime } from '../core/runtime.js';
import type { ProviderSettingsManager } from './provider-settings.js';

export interface AgentPrincipal {
  ownerId: string;
  canvasIds?: readonly string[];
  scopes?: readonly string[];
}

export interface AgentServerOptions {
  host?: string;
  port?: number;
  bearerToken?: string;
  /** Token-to-scope mapping. Keys are kept server-side and never returned. */
  tokens?: Record<string, AgentPrincipal> | Map<string, AgentPrincipal>;
  tokenScopes?: Record<string, AgentPrincipal> | Map<string, AgentPrincipal>;
  defaultPrincipal?: AgentPrincipal;
  /** Authenticate each non-health request against the current host identity. */
  authenticate?: (request: IncomingMessage) => Promise<AgentPrincipal>;
  /** Exact owner allowed to read or change provider settings. */
  providerSettingsOwnerId?: string;
  requireAuth?: boolean;
  allowUnauthenticatedLocal?: boolean;
  corsOrigin?: string;
  maxBodyBytes?: number;
  maxTextLength?: number;
  heartbeatMs?: number;
  configured?: boolean | (() => boolean);
  canvas?: CanvasGateway;
  providerSettings?: ProviderSettingsManager;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = 'bad_request') { super(message); this.name = 'HttpError'; }
}

export class AgentAuthenticationError extends Error {
  constructor(readonly status = 401, message = 'bearer token is required', readonly code = 'unauthorized') {
    super(message);
    this.name = 'AgentAuthenticationError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function isLoopback(address: string | undefined): boolean {
  if (!address) return true;
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK.has(normalized) || normalized.endsWith('::ffff:127.0.0.1');
}

function hostParts(hostHeader: string | undefined): { hostname: string; port: string } | undefined {
  if (!hostHeader) return undefined;
  try {
    const url = new URL(`http://${hostHeader}`);
    return { hostname: url.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: url.port || '80' };
  } catch { return undefined; }
}

function sameLocalOrigin(origin: string, hostHeader: string | undefined): boolean {
  try {
    const parsed = new URL(origin);
    const host = hostParts(hostHeader);
    if (!host || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return false;
    const originPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const originHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (originPort !== host.port) return false;
    if (originHost === host.hostname) return true;
    return isLoopback(originHost) && isLoopback(host.hostname);
  } catch { return false; }
}

function isWildcardHost(host: string): boolean {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '0.0.0.0' || normalized === '::' || normalized === '::0' || normalized === '*' || normalized === '';
}

function writeJson(res: ServerResponse, status: number, value: unknown, origin?: string): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.end(payload);
}

function writeSse(res: ServerResponse, event: AgentEvent): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += buffer.byteLength;
    if (length > maxBytes) throw new HttpError(413, `request body exceeds ${maxBytes} bytes`, 'request_too_large');
    chunks.push(buffer);
  }
  if (!length) return {};
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'request body must be valid JSON', 'invalid_json'); }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'request body must be a JSON object', 'invalid_json');
  return value as Record<string, unknown>;
}

function decodePath(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    // 路径参数必须拒绝协议控制字符; 规则本身依赖这些范围, 局部豁免误报
    // eslint-disable-next-line no-control-regex
    if (!decoded || decoded.length > 256 || /[\u0000-\u001f\u007f]/.test(decoded)) throw new Error('invalid path');
    return decoded;
  } catch { throw new HttpError(400, 'invalid path parameter', 'invalid_path'); }
}

function asString(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) throw new HttpError(400, `${name} is required`, 'invalid_input');
  return value;
}

function afterSequence(value: string | null): number {
  if (value === null || value === '') return 0;
  if (!/^\d{1,15}$/.test(value)) throw new HttpError(400, 'after must be a non-negative sequence number', 'invalid_input');
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) throw new HttpError(400, 'after is too large', 'invalid_input');
  return sequence;
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

/** Extract one unambiguous host credential from PB's supported headers. */
export function authTokenFromRequest(req: IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  const pbHeader = req.headers['x-pb-auth'];
  const values: string[] = [];
  for (const value of [authorization, pbHeader]) {
    if (Array.isArray(value)) throw new AgentAuthenticationError(401, 'multiple authentication headers are not allowed');
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
  }
  if (values.length > 1) {
    const normalize = (value: string) => value.replace(/^Bearer\s+/i, '').trim();
    if (normalize(values[0]) !== normalize(values[1])) throw new AgentAuthenticationError(401, 'authentication headers disagree');
  }
  const value = values[0];
  if (!value) return undefined;
  return value.replace(/^Bearer\s+/i, '').trim() || undefined;
}

/** Native node:http API for the durable Agent runtime. */
export function createAgentServer(runtime: AgentRuntime, options: AgentServerOptions = {}): Server {
  const host = options.host ?? '127.0.0.1';
  if (isWildcardHost(host) || !isLoopback(host)) throw new Error('Agent server must bind to loopback; non-loopback host is refused');
  if (options.corsOrigin === '*') throw new Error('Wildcard CORS is refused');
  const maxBodyBytes = Math.max(1_024, Math.min(32 * 1024 * 1024, options.maxBodyBytes ?? 2 * 1024 * 1024));
  const maxTextLength = Math.max(1, Math.min(10 * 1024 * 1024, options.maxTextLength ?? 50_000));
  const heartbeatMs = Math.max(1_000, Math.min(120_000, options.heartbeatMs ?? 15_000));
  const tokenMap = options.tokens ?? options.tokenScopes;
  const defaultPrincipal = options.defaultPrincipal ?? { ownerId: 'local-user' };
  const configuredNow = () => typeof options.configured === 'function' ? options.configured() : options.configured ?? runtime.providers.list().length > 0;

  const principalFor = (token: string): AgentPrincipal | undefined => {
    if (options.bearerToken && safeEqual(token, options.bearerToken)) return defaultPrincipal;
    if (!tokenMap) return undefined;
    return tokenMap instanceof Map ? tokenMap.get(token) : tokenMap[token];
  };

  const authenticate = async (req: IncomingMessage): Promise<AgentPrincipal> => {
    if (options.authenticate) {
      try {
        if (!authTokenFromRequest(req)) throw new AgentAuthenticationError();
        const principal = await options.authenticate(req);
        if (!principal || typeof principal.ownerId !== 'string' || !principal.ownerId.trim()) throw new AgentAuthenticationError();
        return { ...principal, ownerId: principal.ownerId.trim().toLowerCase() };
      } catch (error) {
        if (error instanceof AgentAuthenticationError) throw error;
        throw new AgentAuthenticationError(401, 'authentication failed');
      }
    }
    const token = authTokenFromRequest(req);
    if (token) {
      const principal = principalFor(token);
      if (principal?.ownerId) return principal;
      throw new HttpError(401, 'invalid bearer token', 'unauthorized');
    }
    if (options.bearerToken || tokenMap || options.requireAuth) throw new HttpError(401, 'bearer token is required', 'unauthorized');
    if (options.allowUnauthenticatedLocal !== false && isLoopback(req.socket.remoteAddress) && Boolean(hostParts(req.headers.host)?.hostname && isLoopback(hostParts(req.headers.host)?.hostname))) return defaultPrincipal;
    throw new HttpError(401, 'bearer token is required', 'unauthorized');
  };

  const allowCanvas = (principal: AgentPrincipal, canvasId: string): void => {
    if (!principal.canvasIds || principal.canvasIds.includes(canvasId)) return;
    throw new HttpError(403, 'canvas is outside the authenticated scope', 'forbidden');
  };

  const sessionFor = (principal: AgentPrincipal, sessionId: string) => {
    const session = runtime.store.getSession(sessionId);
    if (!session || session.scope.ownerId !== principal.ownerId) throw new HttpError(404, 'session not found', 'not_found');
    allowCanvas(principal, session.scope.canvasId);
    return session;
  };

  const originFor = (req: IncomingMessage): string | undefined => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (!origin) return undefined;
    if (options.corsOrigin) {
      if (origin !== options.corsOrigin) throw new HttpError(403, 'origin is not allowed', 'forbidden');
    } else if (!sameLocalOrigin(origin, req.headers.host)) {
      throw new HttpError(403, 'cross-origin requests require an explicit corsOrigin', 'forbidden');
    }
    return origin;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = originFor(req);
    if (req.method === 'OPTIONS') {
      if (!origin) throw new HttpError(403, 'CORS origin is not configured', 'forbidden');
      res.statusCode = 204;
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,X-Pb-Auth,Content-Type,Last-Event-ID');
      res.setHeader('Access-Control-Max-Age', '600');
      res.end();
      return;
    }
    const parsed = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = parsed.pathname.split('/').filter(Boolean).map(decodePath);
    // The standalone server accepts root routes for direct smoke tests and the
    // /api prefix used by the Dangoo Vite proxy/UI client.
    if (path[0] === 'api') path.shift();

    if (req.method === 'GET' && path.length === 1 && path[0] === 'health') {
      writeJson(res, 200, { ok: true, configured: configuredNow(), contractVersion: '1.0.0' }, origin);
      return;
    }

    const principal = await authenticate(req);
    if (path[0] === 'settings' && path[1] === 'provider' && path.length <= 3) {
      const settingsOwner = options.providerSettingsOwnerId === undefined
        ? defaultPrincipal.ownerId.trim().toLowerCase()
        : options.providerSettingsOwnerId.trim().toLowerCase();
      if (!settingsOwner || principal.ownerId !== settingsOwner || !options.providerSettings) throw new HttpError(403, '无权管理服务配置', 'forbidden');
      try {
        const settings = options.providerSettings;
        if (req.method === 'GET' && path.length === 2) { writeJson(res, 200, settings.read(), origin); return; }
        if (req.method === 'POST') {
          const input = await readJson(req, 16384);
          if (path[2] === 'test') { writeJson(res, 200, await settings.test(input), origin); return; }
          if (path.length === 2) { writeJson(res, 200, settings.save(input), origin); return; }
        }
      } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : '配置操作失败'); }
    }
    if (req.method === 'GET' && path.length === 1 && path[0] === 'capabilities') {
      writeJson(res, 200, runtime.capabilities(), origin);
      return;
    }
    if (path.length === 1 && path[0] === 'canvas' && req.method === 'GET') {
      const canvasId = asString(parsed.searchParams.get('canvasId'), 'canvasId');
      allowCanvas(principal, canvasId);
      writeJson(res, 200, await runtime.readCanvas({ ownerId: principal.ownerId, canvasId }), origin);
      return;
    }

    if (path.length === 1 && path[0] === 'sessions' && req.method === 'GET') {
      const canvasId = parsed.searchParams.get('canvasId');
      if (canvasId) allowCanvas(principal, canvasId);
      writeJson(res, 200, { sessions: runtime.listSessions({ ownerId: principal.ownerId }).filter(session => (!canvasId || session.scope.canvasId === canvasId) && (!principal.canvasIds || principal.canvasIds.includes(session.scope.canvasId))) }, origin);
      return;
    }
    if (path.length === 1 && path[0] === 'sessions' && req.method === 'POST') {
      const body = await readJson(req, maxBodyBytes);
      const canvasId = asString(body.canvasId, 'canvasId');
      allowCanvas(principal, canvasId);
      if (options.canvas) await options.canvas.read({ ownerId: principal.ownerId, canvasId });
      const defaults = options.providerSettings?.read();
      const providerId = body.providerId === undefined ? defaults?.providerId : asString(body.providerId, 'providerId', 160);
      const model = body.model === undefined ? defaults?.model : asString(body.model, 'model', 256);
      const session = runtime.createSession({ ownerId: principal.ownerId, canvasId, providerId, model });
      writeJson(res, 201, { session }, origin);
      return;
    }

    if (path[0] === 'sessions' && path.length >= 2) {
      const sessionId = path[1];
      const session = sessionFor(principal, sessionId);
      if (path.length === 2 && req.method === 'GET') {
        writeJson(res, 200, runtime.getSessionState(session.id), origin);
        return;
      }
      if (path.length === 3 && (path[2] === 'history' || path[2] === 'messages') && req.method === 'GET') {
        const after = afterSequence(parsed.searchParams.get('after'));
        const limitText = parsed.searchParams.get('limit');
        const limit = limitText ? Math.min(10_000, Math.max(1, Number(limitText))) : undefined;
        if (limitText && !Number.isSafeInteger(limit)) throw new HttpError(400, 'limit is invalid', 'invalid_input');
        writeJson(res, 200, { messages: runtime.getHistory(session.id, { after, limit }) }, origin);
        return;
      }
      if (path.length === 3 && path[2] === 'events' && req.method === 'GET') {
        const after = afterSequence(parsed.searchParams.get('after') ?? req.headers['last-event-id']?.toString() ?? null);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store');
        res.setHeader('Connection', 'keep-alive');
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.flushHeaders();
        const subscription: { stop?: () => void } = {};
        const heartbeatRef: { id?: ReturnType<typeof setInterval> } = {};
        const cleanup = () => {
          subscription.stop?.();
          if (heartbeatRef.id) clearInterval(heartbeatRef.id);
        };
        res.on('close', cleanup);
        subscription.stop = runtime.subscribe(session.id, (event) => writeSse(res, event), after);
        heartbeatRef.id = setInterval(() => {
          if (res.destroyed || res.writableEnded) { cleanup(); return; }
          res.write(`: heartbeat ${Date.now()}\n\n`);
        }, heartbeatMs);
        return;
      }
      if (path.length === 3 && path[2] === 'messages' && req.method === 'POST') {
        if (!configuredNow()) throw new HttpError(503, 'Agent provider is not configured', 'provider_not_configured');
        const body = await readJson(req, maxBodyBytes);
        const settings = options.providerSettings?.read();
        if (settings && !runtime.store.getActiveRun(session.id)) runtime.store.setSessionProvider(session.id, settings.providerId, settings.model);
        const text = asString(body.text, 'text', maxTextLength);
        const selection = body.selection;
        if (selection !== undefined && (typeof selection !== 'object' || selection === null || Array.isArray(selection))) throw new HttpError(400, 'selection must be an object', 'invalid_input');
        const skillNames = body.skillNames;
        if (skillNames !== undefined && (!Array.isArray(skillNames) || skillNames.some((item) => typeof item !== 'string'))) throw new HttpError(400, 'skillNames must be an array of strings', 'invalid_input');
        const requestId = body.requestId === undefined ? undefined : asString(body.requestId, 'requestId', 256);
        const run = await runtime.sendMessage(session.id, { text, selection: selection as import('../contracts/index.js').Selection | undefined, skillNames: skillNames as string[] | undefined, requestId });
        writeJson(res, 202, { run }, origin);
        return;
      }
      if (path.length === 3 && path[2] === 'compact' && req.method === 'POST') {
        const state = await runtime.compact(session.id);
        writeJson(res, 200, { sessionId: session.id, state }, origin);
        return;
      }
    }

    if (path[0] === 'runs' && path.length >= 3) {
      const runId = path[1];
      const run = runtime.store.getRun(runId);
      if (!run) throw new HttpError(404, 'run not found', 'not_found');
      sessionFor(principal, run.sessionId);
      if (path[2] === 'stop' && req.method === 'POST') {
        writeJson(res, 200, { run: runtime.stopRun(runId) }, origin);
        return;
      }
      if (path[2] === 'reply' && req.method === 'POST') {
        const body = await readJson(req, maxBodyBytes);
        const text = asString(body.text, 'text', maxTextLength);
        const waitId = asString(body.waitId, 'waitId', 256);
        const decision = body.decision;
        if (decision !== undefined && decision !== 'approve' && decision !== 'deny') throw new HttpError(400, 'decision must be approve or deny', 'invalid_input');
        writeJson(res, 202, { run: await runtime.reply(runId, { text, waitId, decision: decision as 'approve' | 'deny' | undefined }) }, origin);
        return;
      }
      if (path[2] === 'resume' && req.method === 'POST') {
        writeJson(res, 202, { run: await runtime.resumeRun(runId) }, origin);
        return;
      }
    }

    throw new HttpError(404, 'route not found', 'not_found');
  };

  const server = createServer((req, res) => {
    void handler(req, res).catch((error: unknown) => {
      const bridgeStatus = error && typeof error === 'object' && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
        ? (error as { status: number }).status
        : undefined;
      const bridgeCode = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : undefined;
      const normalized = error instanceof HttpError
        ? error
        : error instanceof AgentAuthenticationError
          ? new HttpError(error.status, error.message, error.code)
          : bridgeStatus !== undefined && bridgeStatus >= 400 && bridgeStatus < 500
            ? new HttpError(bridgeStatus, error instanceof Error ? error.message : '业务桥接请求失败', bridgeCode ?? 'bridge_error')
          : new HttpError(500, error instanceof Error ? error.message : String(error), 'internal_error');
      if (res.headersSent || res.writableEnded) { res.destroy(); return; }
      const origin = typeof req.headers.origin === 'string' && options.corsOrigin === req.headers.origin ? req.headers.origin : undefined;
      writeJson(res, normalized.status, { error: normalized.code, message: normalized.message }, origin);
    });
  });
  server.on('error', () => undefined);
  (server as Server & { agentRuntime?: AgentRuntime; agentOptions?: AgentServerOptions }).agentRuntime = runtime;
  (server as Server & { agentRuntime?: AgentRuntime; agentOptions?: AgentServerOptions }).agentOptions = options;
  return server;
}

export function listenAgentServer(server: Server, options: AgentServerOptions = {}): Promise<void> {
  const host = options.host ?? '127.0.0.1';
  if (isWildcardHost(host) || !isLoopback(host)) return Promise.reject(new Error('Agent server must bind to loopback; non-loopback host is refused'));
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options.port ?? 8787, host);
  });
}
