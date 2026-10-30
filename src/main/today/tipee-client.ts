import { localDay } from '@shared/today.js';
import { parseTipeeStatus, readCsrfToken, type TipeeStatus } from '@shared/tipee.js';

/**
 * A read-only client for the private API behind a Tipee instance's web app.
 *
 * It signs in with the login form, like the browser, and keeps the session cookies between polls.
 * Every person-scoped read is filtered on the signed-in person's own id: an unfiltered list was
 * seen returning colleagues.
 */

export class TipeeError extends Error {}

/** The session expired or was never opened: signing in again is the fix. */
export class TipeeAuthError extends TipeeError {}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator > 0) {
        this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
      }
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

export class TipeeClient {
  private readonly jar = new CookieJar();
  private person: string | null = null;

  constructor(private readonly baseUrl: string) {}

  async login(username: string, password: string): Promise<void> {
    const formUrl = `${this.baseUrl}/auth/login/form`;
    const form = await this.request(formUrl, { method: 'GET' });
    const token = readCsrfToken(await form.text());
    if (token === null) {
      throw new TipeeError('The Tipee login form changed: no CSRF token found');
    }
    const response = await this.request(formUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        _username: username,
        _password: password,
        _csrf_token: token,
      }).toString(),
    });
    const location = response.headers.get('location') ?? '';
    if (response.status !== 302 || location.includes('/auth/login')) {
      throw new TipeeError('Tipee refused the username or the password');
    }
    this.person = null;
  }

  async status(now: Date): Promise<TipeeStatus> {
    const person = await this.whoAmI();
    const date = localDay(now);
    const show = await this.rpc('/timeclock/resources.show-status', {});
    const body = await this.rpc('/timeclock/workdays.show', {
      date_range: `${date}/${date}`,
      resources: [person],
    });
    const rows = Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body['data'])
        ? body['data']
        : [];
    const row = rows.find(
      (item): item is Record<string, unknown> => isRecord(item) && item['resource'] === person,
    );
    const status = parseTipeeStatus(show, row, date);
    if (status === null) {
      throw new TipeeError('Tipee answered without a clock status');
    }
    return status;
  }

  private async whoAmI(): Promise<string> {
    if (this.person !== null) {
      return this.person;
    }
    const response = await this.request(`${this.baseUrl}/api/instance/frontend.bootstrap`, {
      method: 'GET',
    });
    const body = await this.json(response, 'frontend.bootstrap');
    const user = isRecord(body) ? body['user'] : undefined;
    if (!isRecord(user) || typeof user['snowflake'] !== 'string') {
      throw new TipeeError('Tipee answered without a user id');
    }
    this.person = user['snowflake'];
    return this.person;
  }

  private async rpc(path: string, payload: unknown): Promise<unknown> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const xsrf = this.jar.get('XSRF-TOKEN');
    if (xsrf !== undefined) {
      headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf);
    }
    const response = await this.request(`${this.baseUrl}/api${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return this.json(response, path);
  }

  private async json(response: Response, label: string): Promise<unknown> {
    const text = await response.text();
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status === 302 && text.length === 0)
    ) {
      throw new TipeeAuthError(`${label}: not signed in (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new TipeeError(`${label}: HTTP ${response.status}`);
    }
    try {
      return text.length > 0 ? (JSON.parse(text) as unknown) : null;
    } catch {
      throw new TipeeError(`${label}: the answer is not JSON`);
    }
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: 'manual',
        headers: {
          Accept: 'application/json, text/html',
          ...init.headers,
          Cookie: this.jar.header(),
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new TipeeError('Tipee could not be reached');
    }
    this.jar.store(response);
    if (response.status >= 500) {
      throw new TipeeError(`Tipee is unavailable (HTTP ${response.status})`);
    }
    return response;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
