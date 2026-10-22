import type { AppSettings } from '@shared/contracts.js';
import type { TipeeState, TipeeStatus } from '@shared/tipee.js';
import type { SecretStore } from '../store/secret-store.js';
import { TipeeAuthError, TipeeClient } from './tipee-client.js';

/**
 * Keeps the time tracking card current.
 *
 * Polls nothing until the card is switched on and an address, a username and a password are all
 * set, so an install that never uses it makes no request. The session is kept between polls and
 * opened again once when Tipee says it expired.
 */
export class TipeeMonitor {
  private status: TipeeStatus | null = null;
  private checkedAt: string | null = null;
  private error: string | null = null;
  private client: TipeeClient | null = null;
  /** The address and user the client signed in for, so a settings change signs in again. */
  private clientKey = '';
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly settings: () => AppSettings,
    private readonly secrets: SecretStore,
    private readonly onChange: (state: TipeeState) => void,
  ) {}

  state(): TipeeState {
    return {
      configured: this.configured(),
      status: this.status,
      checkedAt: this.checkedAt,
      error: this.error,
    };
  }

  start(): void {
    void this.refreshNow();
    this.timer = setInterval(() => void this.refreshNow(), this.settings().tipeePollSeconds * 1000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async refreshNow(): Promise<TipeeState> {
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
    return this.state();
  }

  /** One sign-in and one read with what is typed on screen, to say whether it works. */
  async test(draft: {
    url: string;
    user: string;
    password: string;
  }): Promise<{ ok: boolean; message: string }> {
    const password = draft.password.length > 0 ? draft.password : await this.secrets.read();
    if (draft.url.length === 0 || draft.user.length === 0 || password.length === 0) {
      return { ok: false, message: 'Fill in the address, the username and the password first' };
    }
    try {
      const client = new TipeeClient(draft.url);
      await client.login(draft.user, password);
      const status = await client.status(new Date());
      return {
        ok: true,
        message: status.clockedIn ? 'Signed in: clocked in' : 'Signed in: not clocked in',
      };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private configured(): boolean {
    const settings = this.settings();
    return settings.tipeeUrl.length > 0 && settings.tipeeUser.length > 0;
  }

  private async refresh(): Promise<void> {
    const settings = this.settings();
    if (!settings.todayChannels.tipee || !this.configured()) {
      return;
    }
    const password = await this.secrets.read();
    if (password.length === 0) {
      this.error = 'No password saved';
      this.onChange(this.state());
      return;
    }
    const key = `${settings.tipeeUrl}\n${settings.tipeeUser}`;
    try {
      if (this.client === null || this.clientKey !== key) {
        this.client = new TipeeClient(settings.tipeeUrl);
        this.clientKey = key;
        await this.client.login(settings.tipeeUser, password);
      }
      try {
        this.status = await this.client.status(new Date());
      } catch (error) {
        if (!(error instanceof TipeeAuthError)) {
          throw error;
        }
        await this.client.login(settings.tipeeUser, password);
        this.status = await this.client.status(new Date());
      }
      this.error = null;
      this.checkedAt = new Date().toISOString();
    } catch (error) {
      // No half-open session survives a failure: the next poll signs in from scratch.
      this.client = null;
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.onChange(this.state());
  }
}
