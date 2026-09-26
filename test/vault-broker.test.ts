import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultState } from '../src/shared/vault.js';
import { VaultBroker } from '../src/main/vault/vault-broker.js';

const SECRET = 'sk-never-return-this';

function state(): VaultState {
  return {
    available: true,
    unreadable: false,
    activity: [],
    cards: [
      {
        id: 'weather-api',
        name: 'Weather API',
        hint: 'Forecasts',
        createdAt: '2026-09-26T12:00:00.000Z',
        expiresAt: null,
        file: null,
        capability: {
          kind: 'http',
          baseUrl: 'https://api.example.com',
          auth: 'bearer',
          headerName: '',
          methods: ['GET'],
          pathPrefixes: ['/v1/forecast'],
          projectIds: ['dashboard'],
        },
      },
    ],
  };
}

const brokers: VaultBroker[] = [];

afterEach(async () => {
  await Promise.all(brokers.splice(0).map(async (broker) => broker.stop()));
});

async function started(options: {
  confirm: () => Promise<boolean>;
  fetcher?: typeof fetch;
}): Promise<{ broker: VaultBroker; url: string; token: string }> {
  const broker = new VaultBroker({
    vault: {
      state,
      valueOf: async () => SECRET,
    },
    projects: () => [{ id: 'dashboard', label: 'Dashboard' }],
    confirm: options.confirm,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  brokers.push(broker);
  await broker.start();
  const environment = broker.environmentFor('dashboard');
  return {
    broker,
    url: environment.OXUM_VAULT_URL ?? '',
    token: environment.OXUM_VAULT_TOKEN ?? '',
  };
}

function headers(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

describe('VaultBroker', () => {
  it('lists only metadata available to the terminal project', async () => {
    const { url, token } = await started({ confirm: async () => true });
    const response = await fetch(`${url}/v1/capabilities`, { headers: headers(token) });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('Weather API');
    expect(text).toContain('/v1/forecast');
    expect(text).not.toContain(SECRET);
  });

  it('does not make the upstream request when approval is declined', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { url, token } = await started({ confirm: async () => false, fetcher });
    const response = await fetch(`${url}/v1/execute`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'weather-api',
        method: 'GET',
        path: '/v1/forecast/today',
      }),
    });

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('injects the secret upstream, redacts it downstream and records non-secret activity', async () => {
    let upstreamAuthorization = '';
    const fetcher: typeof fetch = async (_input, init) => {
      upstreamAuthorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(`forecast ok; accidental echo ${SECRET}`, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
    };
    const { broker, url, token } = await started({ confirm: async () => true, fetcher });
    const response = await fetch(`${url}/v1/execute`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'weather-api',
        method: 'GET',
        path: '/v1/forecast/today',
        query: { city: 'Geneva' },
      }),
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(upstreamAuthorization).toBe(`Bearer ${SECRET}`);
    expect(text).toContain('[REDACTED BY OXUM VAULT]');
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(broker.activity())).not.toContain(SECRET);
    expect(broker.activity()[0]).toMatchObject({
      capabilityName: 'Weather API',
      projectId: 'dashboard',
      method: 'GET',
      path: '/v1/forecast/today',
      outcome: 'succeeded',
      status: 200,
    });
  });

  it('rejects a path outside the card allowlist before asking for approval', async () => {
    const confirm = vi.fn(async () => true);
    const { url, token } = await started({ confirm });
    const response = await fetch(`${url}/v1/execute`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        capabilityId: 'weather-api',
        method: 'GET',
        path: '/v1/admin',
      }),
    });

    expect(response.status).toBe(403);
    expect(confirm).not.toHaveBeenCalled();
  });
});
