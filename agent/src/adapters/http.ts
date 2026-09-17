import type {
  AssetAccess,
  AssetGateway,
  AssetRecord,
  AssetRef,
  AssetSearch,
  CanvasGateway,
  CanvasOperation,
  CanvasSnapshot,
  JobRecord,
  NodeQuote,
  Scope,
} from '../contracts/index.js';
import { CONTRACT_VERSION } from '../contracts/index.js';
import { IntegrationError } from './assets.js';

export interface BridgeCapabilities extends ReturnType<CanvasGateway['capabilities']> { assets: boolean; }

export interface BridgeIdentity {
  ownerId: string;
}

type BridgeAuthHeader = 'Authorization' | 'X-Pb-Auth';

function bridgeBaseUrl(value: string): URL {
  const base = new URL(value.endsWith('/') ? value : `${value}/`);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new IntegrationError('INVALID_BRIDGE_URL', '业务桥接须使用 HTTPS 或本机地址');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new IntegrationError('INVALID_BRIDGE_URL', '业务桥接地址不得含认证信息、查询或片段');
  }
  return base;
}

function requestHeaders(token: string, authHeader: BridgeAuthHeader): Record<string, string> {
  return {
    [authHeader]: authHeader === 'Authorization' ? `Bearer ${token}` : token,
    'Content-Type': 'application/json',
    'X-Agent-Contract': CONTRACT_VERSION,
  };
}

function validateCapabilities(value: unknown): BridgeCapabilities {
  const caps = value as Partial<BridgeCapabilities> | undefined;
  if (
    !caps ||
    caps.contractVersion?.split('.')[0] !== CONTRACT_VERSION.split('.')[0] ||
    !caps.revision ||
    !Array.isArray(caps.nodes) ||
    !Array.isArray(caps.operations) ||
    typeof caps.jobs !== 'boolean' ||
    typeof caps.assets !== 'boolean'
  ) {
    throw new IntegrationError('BRIDGE_VERSION_MISMATCH', '画布桥接契约不兼容');
  }
  return structuredClone(caps as BridgeCapabilities);
}

/** Versioned Dangoo bridge client. Credentials are injected by the server; never accepted from a model. */
export class HttpDangooGateway implements CanvasGateway, AssetGateway {
  private constructor(
    private readonly base: URL,
    private readonly tokenFor: (scope: Scope) => Promise<string>,
    private caps: BridgeCapabilities,
    private readonly fetcher: typeof fetch,
    private readonly authHeader: BridgeAuthHeader,
    private readonly onAuthFailure?: (scope: Scope, token: string) => void,
  ) {}

  static async connect(options: {
    baseUrl: string;
    tokenFor: (scope: Scope) => Promise<string>;
    scope: Scope;
    fetch?: typeof fetch;
    authHeader?: BridgeAuthHeader;
    onAuthFailure?: (scope: Scope, token: string) => void;
  }): Promise<HttpDangooGateway> {
    const base = bridgeBaseUrl(options.baseUrl);
    const instance = new HttpDangooGateway(
      base,
      options.tokenFor,
      { contractVersion: CONTRACT_VERSION, revision: 'pending', nodes: [], operations: [], jobs: false, assets: false },
      options.fetch ?? fetch,
      options.authHeader ?? 'Authorization',
      options.onAuthFailure,
    );
    await instance.refreshCapabilities(options.scope);
    return instance;
  }

  get available(): boolean { return this.caps.assets; }

  capabilities(): BridgeCapabilities { return structuredClone(this.caps); }

  async refreshCapabilities(scope: Scope): Promise<BridgeCapabilities> {
    const caps = await this.request<BridgeCapabilities>(scope, 'capabilities');
    this.caps = validateCapabilities(caps);
    return this.capabilities();
  }

  private async request<T>(scope: Scope, path: string, body?: unknown): Promise<T> {
    const token = (await this.tokenFor(scope)).trim();
    if (!token) throw new IntegrationError('AUTH_REQUIRED', '画布授权已失效');
    const response = await this.fetcher(new URL(path, this.base), {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(path.includes('/jobs/') ? 90_000 : 30_000),
      headers: requestHeaders(token, this.authHeader),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let code = 'BRIDGE_ERROR';
      try {
        const info = await response.json() as { error?: string };
        if (typeof info.error === 'string' && /^[A-Z_]{1,64}$/.test(info.error)) code = info.error;
      } catch { /* Keep the status-derived generic code. */ }
      if (response.status === 401) this.onAuthFailure?.(scope, token);
      throw new IntegrationError(code, `业务接口请求失败 (${response.status})`, [429, 502, 503, 504].includes(response.status), response.status);
    }
    return await response.json() as T;
  }

  read(scope: Scope): Promise<CanvasSnapshot> { return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}`); }
  apply(scope: Scope, input: { expectedRevision: number; operationId: string; operations: CanvasOperation[] }): Promise<{ revision: number; operationId: string }> {
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/operations`, input);
  }
  async operation(scope: Scope, id: string): Promise<{ revision: number; operationId: string } | undefined> {
    return (await this.request<{ revision: number; operationId: string } | null>(scope, `canvases/${encodeURIComponent(scope.canvasId)}/operations/${encodeURIComponent(id)}`)) ?? undefined;
  }
  quote(scope: Scope, input: { nodeId: string; expectedRevision: number }): Promise<NodeQuote> {
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/quotes`, input);
  }
  imageModels(scope: Scope): Promise<unknown> { return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/image-models`); }
  getQuote(scope: Scope, id: string): Promise<NodeQuote> {
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/quotes/${encodeURIComponent(id)}`);
  }
  approveQuote(scope: Scope, id: string): Promise<NodeQuote> {
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/quotes/${encodeURIComponent(id)}/approve`, {});
  }
  run(scope: Scope, input: { nodeId: string; operationId: string; expectedRevision: number; quoteId?: string }): Promise<JobRecord> {
    if (!this.caps.jobs) throw new IntegrationError('CAPABILITY_UNAVAILABLE', '生成任务接口尚未接通');
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/jobs`, input);
  }
  job(scope: Scope, id: string): Promise<JobRecord> {
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/jobs/${encodeURIComponent(id)}`);
  }
  async jobOperation(scope: Scope, id: string): Promise<JobRecord | undefined> {
    return (await this.request<JobRecord | null>(scope, `canvases/${encodeURIComponent(scope.canvasId)}/job-operations/${encodeURIComponent(id)}`)) ?? undefined;
  }
  search(scope: Scope, query: AssetSearch): Promise<{ items: AssetRecord[]; nextCursor?: string }> {
    if (!this.available) throw new IntegrationError('ASSET_INTEGRATION_UNAVAILABLE', '资产服务尚未接通');
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/assets/search`, query);
  }
  get(scope: Scope, ref: AssetRef): Promise<AssetRecord> {
    if (!this.available) throw new IntegrationError('ASSET_INTEGRATION_UNAVAILABLE', '资产服务尚未接通');
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/assets/${encodeURIComponent(ref.assetId)}/versions/${ref.version}`);
  }
  view(scope: Scope, ref: AssetRef): Promise<AssetAccess> {
    if (!this.available) throw new IntegrationError('ASSET_INTEGRATION_UNAVAILABLE', '资产服务尚未接通');
    return this.request(scope, `canvases/${encodeURIComponent(scope.canvasId)}/assets/${encodeURIComponent(ref.assetId)}/versions/${ref.version}/access`, { purpose: 'vision' });
  }
}

/**
 * Multi-user bridge facade. The runtime still receives one CanvasGateway, but
 * every business call resolves its credential from the authenticated owner in
 * the session scope. A token is never selected from another owner's session.
 */
export class OwnerScopedHttpDangooGateway implements CanvasGateway, AssetGateway {
  private readonly gateways = new Map<string, HttpDangooGateway>();
  private readonly tokens = new Map<string, string>();
  private readonly tokenOwners = new Map<string, string>();
  private caps: BridgeCapabilities = { contractVersion: CONTRACT_VERSION, revision: 'pending', nodes: [], operations: [], jobs: false, assets: false };
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private readonly authHeader: BridgeAuthHeader;

  constructor(options: { baseUrl: string; fetch?: typeof fetch; authHeader?: BridgeAuthHeader }) {
    this.base = bridgeBaseUrl(options.baseUrl);
    this.fetcher = options.fetch ?? fetch;
    this.authHeader = options.authHeader ?? 'Authorization';
  }

  get available(): boolean { return this.caps.assets; }
  capabilities(): BridgeCapabilities { return structuredClone(this.caps); }

  /** Validate the token against PB and prime the owner-scoped capabilities. */
  async authenticate(token: string): Promise<string> {
    const normalizedToken = token.trim();
    if (!normalizedToken) throw new IntegrationError('AUTH_REQUIRED', '画布授权已失效');
    let ownerId: string;
    try {
      const identity = await this.identity(normalizedToken);
      ownerId = typeof identity.ownerId === 'string' ? identity.ownerId.trim().toLowerCase() : '';
      if (!ownerId || ownerId.length > 190) throw new IntegrationError('AUTH_INVALID', '业务身份无效');
    } catch (error) {
      this.forgetToken(normalizedToken);
      throw error;
    }
    const priorOwnerForToken = this.tokenOwners.get(normalizedToken);
    if (priorOwnerForToken && priorOwnerForToken !== ownerId) this.forgetOwnerToken(priorOwnerForToken, normalizedToken);
    const previousToken = this.tokens.get(ownerId);
    if (previousToken && previousToken !== normalizedToken) this.tokenOwners.delete(previousToken);
    this.tokens.set(ownerId, normalizedToken);
    this.tokenOwners.set(normalizedToken, ownerId);
    try {
      let gateway = this.gateways.get(ownerId);
      if (!gateway) {
        gateway = await HttpDangooGateway.connect({
          baseUrl: this.base.toString(),
          scope: { ownerId, canvasId: '__capabilities__' },
          tokenFor: async (scope) => this.tokenFor(scope),
          fetch: this.fetcher,
          authHeader: this.authHeader,
          onAuthFailure: (scope, failedToken) => this.forgetOwnerToken(scope.ownerId, failedToken),
        });
        this.gateways.set(ownerId, gateway);
      } else {
        await gateway.refreshCapabilities({ ownerId, canvasId: '__capabilities__' });
      }
      this.caps = gateway.capabilities();
      return ownerId;
    } catch (error) {
      this.forgetOwnerToken(ownerId, normalizedToken);
      throw error;
    }
  }

  tokenForScope(scope: Scope): string {
    return this.tokenFor(scope);
  }

  private async identity(token: string): Promise<BridgeIdentity> {
    const response = await this.fetcher(new URL('identity', this.base), {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
      headers: requestHeaders(token, this.authHeader),
    });
    if (!response.ok) {
      const code = response.status === 401 ? 'AUTH_INVALID' : response.status === 403 ? 'AUTH_FORBIDDEN' : 'IDENTITY_UNAVAILABLE';
      throw new IntegrationError(code, `身份验证失败 (${response.status})`, [429, 502, 503, 504].includes(response.status));
    }
    const value = await response.json() as Partial<BridgeIdentity>;
    if (typeof value.ownerId !== 'string' || !value.ownerId.trim()) throw new IntegrationError('AUTH_INVALID', '业务身份无效');
    return { ownerId: value.ownerId };
  }

  private tokenFor(scope: Scope): string {
    const token = this.tokens.get(scope.ownerId);
    if (!token) throw new IntegrationError('AUTH_REQUIRED', '画布授权已失效');
    return token;
  }

  private forgetToken(token: string): void {
    const ownerId = this.tokenOwners.get(token);
    if (ownerId) this.forgetOwnerToken(ownerId, token);
  }

  private forgetOwnerToken(ownerId: string, token: string): void {
    if (this.tokens.get(ownerId) === token) this.tokens.delete(ownerId);
    if (this.tokenOwners.get(token) === ownerId) this.tokenOwners.delete(token);
  }

  private gateway(scope: Scope): HttpDangooGateway {
    const gateway = this.gateways.get(scope.ownerId);
    if (!gateway || !this.tokens.has(scope.ownerId)) throw new IntegrationError('AUTH_REQUIRED', '画布授权已失效');
    return gateway;
  }

  read(scope: Scope): Promise<CanvasSnapshot> { return this.gateway(scope).read(scope); }
  apply(scope: Scope, input: { expectedRevision: number; operationId: string; operations: CanvasOperation[] }): Promise<{ revision: number; operationId: string }> { return this.gateway(scope).apply(scope, input); }
  operation(scope: Scope, id: string): Promise<{ revision: number; operationId: string } | undefined> { return this.gateway(scope).operation(scope, id); }
  quote(scope: Scope, input: { nodeId: string; expectedRevision: number }): Promise<NodeQuote> { return this.gateway(scope).quote(scope, input); }
  imageModels(scope: Scope): Promise<unknown> { return this.gateway(scope).imageModels(scope); }
  getQuote(scope: Scope, id: string): Promise<NodeQuote> { return this.gateway(scope).getQuote(scope, id); }
  approveQuote(scope: Scope, id: string): Promise<NodeQuote> { return this.gateway(scope).approveQuote(scope, id); }
  run(scope: Scope, input: { nodeId: string; operationId: string; expectedRevision: number; quoteId?: string }): Promise<JobRecord> { return this.gateway(scope).run(scope, input); }
  job(scope: Scope, id: string): Promise<JobRecord> { return this.gateway(scope).job(scope, id); }
  jobOperation(scope: Scope, id: string): Promise<JobRecord | undefined> { return this.gateway(scope).jobOperation(scope, id); }
  search(scope: Scope, query: AssetSearch): Promise<{ items: AssetRecord[]; nextCursor?: string }> { return this.gateway(scope).search(scope, query); }
  get(scope: Scope, ref: AssetRef): Promise<AssetRecord> { return this.gateway(scope).get(scope, ref); }
  view(scope: Scope, ref: AssetRef): Promise<AssetAccess> { return this.gateway(scope).view(scope, ref); }
}
