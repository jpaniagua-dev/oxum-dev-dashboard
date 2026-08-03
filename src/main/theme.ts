import { nativeTheme } from 'electron';
import type { ResolvedTheme, ThemeMode, ThemeState } from '@shared/contracts.js';

/** Window background per resolved theme, kept in sync with the CSS `--surface` token. */
const WINDOW_BACKGROUND: Record<ResolvedTheme, string> = {
  light: '#FFFFFF',
  dark: '#131313',
};

/**
 * Single authority for the active theme.
 *
 * Resolution lives in the main process rather than the renderer for one concrete reason: the
 * `BrowserWindow` background colour is what paints during the frame before the page renders.
 * If the renderer owned the decision, showing the popup in dark mode would flash white. Here
 * the window colour and the page attribute always come from the same value.
 *
 * `nativeTheme.themeSource` does the OS tracking for us: setting it to `system` makes
 * `shouldUseDarkColors` follow Windows, and `updated` fires when the user flips the OS setting.
 */
export class ThemeController {
  private mode: ThemeMode = 'system';

  constructor(
    private readonly onChange: (state: ThemeState) => void,
    private readonly applyWindowBackground: (color: string) => void,
  ) {
    nativeTheme.on('updated', () => {
      // Only meaningful in `system` mode, but re-emitting is harmless and keeps the renderer
      // authoritative-free.
      this.emit();
    });
  }

  /** Applies a mode and returns the resolved state. */
  setMode(mode: ThemeMode): ThemeState {
    this.mode = mode;
    nativeTheme.themeSource = mode;
    return this.emit();
  }

  /** Current mode plus what it resolves to right now. */
  state(): ThemeState {
    return {
      mode: this.mode,
      resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    };
  }

  /** Background colour matching the resolved theme. */
  backgroundColor(): string {
    return WINDOW_BACKGROUND[this.state().resolved];
  }

  private emit(): ThemeState {
    const state = this.state();
    this.applyWindowBackground(WINDOW_BACKGROUND[state.resolved]);
    this.onChange(state);
    return state;
  }
}

/** Cycles light to dark to system, the order the titlebar button steps through. */
export function nextThemeMode(mode: ThemeMode): ThemeMode {
  switch (mode) {
    case 'light':
      return 'dark';
    case 'dark':
      return 'system';
    case 'system':
      return 'light';
  }
}
