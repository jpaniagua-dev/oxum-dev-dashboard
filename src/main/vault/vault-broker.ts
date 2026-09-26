import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type {
  VaultActivity,
  VaultCard,
  VaultHttpCapability,
  VaultHttpMethod,
  VaultState,
} from '@shared/vault.js';
import { VAULT_HTTP_METHODS } from '@shared/vault.js';

const REQUEST_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 256 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const ACTIVITY_LIMIT = 30;

export interface VaultBrokerProject {
  readonly id: string;
  readonly label: string;
}

export interface VaultBrokerVault {
  state(): VaultState;
  valueOf(id: string, now: Date): Promise<string | null>;
}

export interface VaultBrokerConfirmation {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
}

export interface VaultBrokerOptions {
  readonly vault: VaultBrokerVault;
  readonly projects: () => readonly VaultBrokerProject[];
  readonly confirm: (request: VaultBrokerConfirmation) => Promise<boolean>;
  readonly onActivity?: () => void;
  readonly fetcher?: typeof fetch;
}

interface BrokerIdentity {
  readonly projectId: string;
  readonly projectLabel: string;
}

interface VaultOperation {
  readonly capabilityId: string;
  readonly method: VaultHttpMethod;
  readonly path: string;
  readonly query: Readonly<Record<string, readonly string[]>>;
  readonly body: unknown;
  readonly hasBody: boolean;
}

class BrokerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A loopback-only bridge from project terminals to constrained Vault operations.
 *
 * The bearer used here is an ephemeral session capability, not a stored credential. It identifies
 * one project for this app process and dies with it. The actual value is read only after the request
 * has passed scope validation and the human has approved the exact method and URL.
 */
export class VaultBroker {
  private server: Server | null = null;
  private origin = '';
  private readonly tokens = new Map<string, BrokerIdentity>();
  private readonly tokensByProject = new Map<string, string>();
  private readonly pending = new Set<string>();
  private recent: VaultActivity[] = [];

  constructor(private readonly options: VaultBrokerOptions) {}

  async start(): Promise<void> {
    if (this.server !== null) {
      return;
    }
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      server.close();
      throw new Error('The Vault broker did not receive a loopback port');
    }
    this.server = server;
    this.origin = `http://127.0.0.1:${String(address.port)}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.origin = '';
    this.tokens.clear();
    this.tokensByProject.clear();
    this.pending.clear();
    if (server === null) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Environment added only to a terminal that belongs to a configured project. */
  environmentFor(projectId: string | null): NodeJS.ProcessEnv {
    if (projectId === null || this.server === null) {
      return {};
    }
    const project = this.options.projects().find((entry) => entry.id === projectId);
    if (project === undefined) {
      return {};
    }
    let token = this.tokensByProject.get(projectId);
    if (token === undefined) {
      token = randomBytes(32).toString('base64url');
      this.tokensByProject.set(projectId, token);
      this.tokens.set(token, { projectId, projectLabel: project.label });
    }
    return {
      OXUM_VAULT_URL: this.origin,
      OXUM_VAULT_TOKEN: token,
      OXUM_VAULT_HELP:
        'GET OXUM_VAULT_URL/v1 using OXUM_VAULT_TOKEN as a Bearer token; no endpoint returns secret values.',
    };
  }

  activity(): readonly VaultActivity[] {
    return [...this.recent];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.headers.origin !== undefined) {
        throw new BrokerError(403, 'Browser-origin requests are not accepted');
      }
      const identity = this.authenticate(request);
      const url = new URL(request.url ?? '/', this.origin);
      if (request.method === 'GET' && url.pathname === '/v1') {
        this.reply(response, 200, {
          service: 'Oxum Vault operation broker',
          rule: 'List capabilities, then request an operation. Secret values are never returned.',
          endpoints: ['GET /v1/capabilities', 'POST /v1/execute'],
          execute: {
            capabilityId: 'card id from the capability list',
            method: 'GET',
            path: '/allowed/path',
            query: { key: 'value' },
            body: { optional: 'JSON body' },
          },
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/capabilities') {
        this.reply(response, 200, {
          project: identity.projectLabel,
          capabilities: this.capabilitiesFor(identity.projectId).map(publicCapability),
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/execute') {
        if (this.pending.has(identity.projectId)) {
          throw new BrokerError(409, 'This project already has an operation awaiting approval');
        }
        const operation = parseOperation(await readJson(request));
        const result = await this.execute(identity, operation);
        this.reply(response, 200, result);
        return;
      }
      throw new BrokerError(404, 'Unknown Vault broker endpoint');
    } catch (error) {
      const status = error instanceof BrokerError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Vault operation failed';
      this.reply(response, status, { ok: false, error: message });
    }
  }

  private authenticate(request: IncomingMessage): BrokerIdentity {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    const identity = this.tokens.get(token);
    if (identity === undefined) {
      throw new BrokerError(401, 'A valid OXUM_VAULT_TOKEN is required');
    }
    if (!this.options.projects().some((project) => project.id === identity.projectId)) {
      throw new BrokerError(403, 'That project is no longer configured');
    }
    return identity;
  }

  private capabilitiesFor(projectId: string): VaultCard[] {
    return this.options.vault
      .state()
      .cards.filter((card) => card.capability?.projectIds.includes(projectId) === true);
  }

  private async execute(identity: BrokerIdentity, operation: VaultOperation): Promise<object> {
    const card = this.capabilitiesFor(identity.projectId).find(
      (entry) => entry.id === operation.capabilityId,
    );
    const capability = card?.capability;
    if (card === undefined || capability === null || capability === undefined) {
      throw new BrokerError(404, 'That capability is not available to this project');
    }
    if (!capability.methods.includes(operation.method)) {
      throw new BrokerError(403, `${operation.method} is not allowed for this capability`);
    }
    if (!pathAllowed(operation.path, capability.pathPrefixes)) {
      throw new BrokerError(403, 'That path is outside this capability');
    }
    if (operation.method === 'GET' && operation.hasBody) {
      throw new BrokerError(400, 'GET operations cannot carry a body');
    }

    const target = new URL(operation.path, capability.baseUrl);
    for (const [name, values] of Object.entries(operation.query)) {
      for (const value of values) {
        target.searchParams.append(name, value);
      }
    }

    if (this.pending.has(identity.projectId)) {
      throw new BrokerError(409, 'This project already has an operation awaiting approval');
    }
    this.pending.add(identity.projectId);
    let approved = false;
    try {
      approved = await this.options.confirm({
        title: 'Approve a Vault operation',
        message: `${identity.projectLabel} wants to use “${card.name}”`,
        detail: `${operation.method} ${target.toString()}\n\nThe agent receives the response, never the credential.`,
      });
    } finally {
      this.pending.delete(identity.projectId);
    }
    if (!approved) {
      this.record(card, identity, operation, 'denied', null, 'Approval declined');
      throw new BrokerError(403, 'The operation was not approved');
    }

    const secret = await this.options.vault.valueOf(card.id, new Date());
    if (secret === null) {
      this.record(card, identity, operation, 'failed', null, 'Credential expired');
      throw new BrokerError(410, 'That credential has expired');
    }

    const headers = new Headers({ Accept: 'application/json, text/plain;q=0.9, */*;q=0.5' });
    if (capability.auth === 'bearer') {
      headers.set('Authorization', `Bearer ${secret}`);
    } else {
      headers.set(capability.headerName, secret);
    }

    let body: string | undefined;
    if (operation.hasBody) {
      body = JSON.stringify(operation.body);
      if (Buffer.byteLength(body, 'utf8') > REQUEST_LIMIT) {
        throw new BrokerError(413, 'The operation body is too large');
      }
      headers.set('Content-Type', 'application/json');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await (this.options.fetcher ?? fetch)(target, {
        method: operation.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: 'error',
        signal: controller.signal,
      });
      const content = await readResponse(response);
      this.record(
        card,
        identity,
        operation,
        response.ok ? 'succeeded' : 'failed',
        response.status,
        `HTTP ${String(response.status)}`,
      );
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: redact(content.text, secret),
        truncated: content.truncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'HTTP request failed';
      this.record(card, identity, operation, 'failed', null, message);
      throw new BrokerError(502, message);
    } finally {
      clearTimeout(timer);
    }
  }

  private record(
    card: VaultCard,
    identity: BrokerIdentity,
    operation: VaultOperation,
    outcome: VaultActivity['outcome'],
    status: number | null,
    message: string,
  ): void {
    this.recent = [
      {
        at: new Date().toISOString(),
        capabilityId: card.id,
        capabilityName: card.name,
        projectId: identity.projectId,
        method: operation.method,
        path: operation.path,
        outcome,
        status,
        message,
      },
      ...this.recent,
    ].slice(0, ACTIVITY_LIMIT);
    this.options.onActivity?.();
  }

  private reply(response: ServerResponse, status: number, payload: object): void {
    if (response.headersSent) {
      return;
    }
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(JSON.stringify(payload));
  }
}

function publicCapability(card: VaultCard): object {
  const capability = card.capability as VaultHttpCapability;
  return {
    id: card.id,
    name: card.name,
    description: card.hint,
    operation: 'http',
    baseUrl: capability.baseUrl,
    methods: capability.methods,
    pathPrefixes: capability.pathPrefixes,
    approval: 'always',
  };
}

function parseOperation(payload: unknown): VaultOperation {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new BrokerError(400, 'The operation must be a JSON object');
  }
  const row = payload as Record<string, unknown>;
  const capabilityId = typeof row['capabilityId'] === 'string' ? row['capabilityId'] : '';
  const method = typeof row['method'] === 'string' ? row['method'].toUpperCase() : '';
  const path = typeof row['path'] === 'string' ? row['path'] : '';
  if (capabilityId.length === 0 || !VAULT_HTTP_METHODS.includes(method as VaultHttpMethod)) {
    throw new BrokerError(400, 'A capability id and supported HTTP method are required');
  }
  if (!safePath(path)) {
    throw new BrokerError(
      400,
      'The path must be an absolute API path without a query or traversal',
    );
  }

  const query: Record<string, readonly string[]> = {};
  if (row['query'] !== undefined) {
    if (typeof row['query'] !== 'object' || row['query'] === null || Array.isArray(row['query'])) {
      throw new BrokerError(400, 'Query parameters must be a JSON object');
    }
    for (const [name, raw] of Object.entries(row['query'] as Record<string, unknown>)) {
      if (name.length === 0 || name.length > 80) {
        throw new BrokerError(400, 'A query parameter name is invalid');
      }
      const values = Array.isArray(raw) ? raw : [raw];
      if (!values.every((value) => ['string', 'number', 'boolean'].includes(typeof value))) {
        throw new BrokerError(400, `Query parameter ${name} must contain scalar values`);
      }
      query[name] = values.map(String);
    }
  }

  return {
    capabilityId,
    method: method as VaultHttpMethod,
    path,
    query,
    body: row['body'],
    hasBody: Object.hasOwn(row, 'body'),
  };
}

function safePath(path: string): boolean {
  if (
    path.length === 0 ||
    path.length > 500 ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    /%(?:2e|2f|5c)/i.test(path)
  ) {
    return false;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return false;
  }
  return !decoded.split('/').some((part) => part === '.' || part === '..' || part.includes('/'));
}

function pathAllowed(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => prefix === '/' || path === prefix || path.startsWith(`${prefix}/`),
  );
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > REQUEST_LIMIT) {
      throw new BrokerError(413, 'The request body is too large');
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new BrokerError(400, 'The request body is not valid JSON');
  }
}

async function readResponse(response: Response): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) {
    return { text: '', truncated: false };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) {
      text += decoder.decode();
      return { text, truncated: false };
    }
    const remaining = RESPONSE_LIMIT - size;
    if (chunk.value.byteLength > remaining) {
      text += decoder.decode(chunk.value.slice(0, Math.max(0, remaining)), { stream: true });
      await reader.cancel();
      return { text: `${text}\n[response truncated by Oxum Vault]`, truncated: true };
    }
    size += chunk.value.byteLength;
    text += decoder.decode(chunk.value, { stream: true });
  }
}

function redact(text: string, secret: string): string {
  return secret.length === 0 ? text : text.replaceAll(secret, '[REDACTED BY OXUM VAULT]');
}
