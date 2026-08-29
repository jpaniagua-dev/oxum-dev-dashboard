import type { ThemeState } from '@shared/contracts.js';
import { requireElement } from './ui/dom.js';
import { SettingsForm } from './ui/settings-form.js';
import { applyUiFontSize } from './ui/ui-font.js';

/**
 * Entry point of the settings window.
 *
 * It is a second renderer over the same preload bridge, so it reads and writes through exactly the
 * capabilities the dashboard has, and nothing more. Everything it changes reaches the dashboard
 * through the main process, which broadcasts the new settings.
 */
async function start(): Promise<void> {
  const bootstrap = await window.api.bootstrap();
  applyTheme(bootstrap.theme);
  applyUiFontSize(bootstrap.settings.uiFontSize);

  const body = requireElement('settings-body');

  const form = new SettingsForm(
    {
      rail: requireElement('settings-rail'),
      interface: requireElement('settings-interface'),
      projects: requireElement('settings-projects'),
      terminal: requireElement('settings-terminal'),
      claude: requireElement('settings-claude'),
      jira: requireElement('settings-jira'),
      footer: requireElement('settings-footer'),
    },
    {
      // The main process owns the close confirmation: only the window's own `close` handler can still
      // cancel it, so the flag has to live there.
      onDirtyChange: (dirty) => window.api.reportSettingsDirty(dirty),
      onRequestClose: () => void window.api.closeWindow(),
      // Scrolling belongs to the window: the form builds the rail, this decides what "go there" means.
      onNavigate: (sectionId) =>
        document.getElementById(sectionId)?.scrollIntoView({ block: 'start' }),
    },
  );

  await form.load(bootstrap.settings, bootstrap.shellProfiles, bootstrap.jiraConfig);

  watchSections(body, (sectionId) => form.setActiveSection(sectionId));

  window.api.onThemeChanged((state) => applyTheme(state));

  /*
   * Settings can also change from the dashboard: renaming a project in the table writes the same
   * file this form is editing. The draft is reloaded only when there is nothing to lose, so a
   * background change never overwrites what the user is typing, and never when the event is only the
   * echo of this window's own save.
   */
  window.api.onSettingsChanged((settings) => {
    // Before the two guards below, and outside them: the font size is applied even when this event is
    // only the echo of this window's own save, which is precisely the case that resizes this form.
    applyUiFontSize(settings.uiFontSize);
    if (form.hasUnsavedChanges || form.matchesLoadedState(settings)) {
      return;
    }
    void window.api
      .bootstrap()
      .then((next) => form.load(settings, next.shellProfiles, next.jiraConfig));
  });

  // Escape closes, as it did when this was a dialog. The unsaved-changes prompt still applies,
  // because closing goes through the window's own close path.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      void window.api.closeWindow();
    }
  });
}

function applyTheme(state: ThemeState): void {
  document.documentElement.dataset.theme = state.resolved;
}

/**
 * Tells the rail which section the window is looking at.
 *
 * The topmost section still intersecting the body wins, rather than the most visible one: sections
 * here are wildly uneven — Interface is four lines, Projects can be twenty screens — and "most
 * visible" would leave the rail stuck on Projects while Terminal fills the view. Reading the
 * *first* one that is still on screen is the same rule the eye uses.
 *
 * The band is the top fifth of the body, so a section becomes current when it reaches the top of the
 * window and not when it merely appears at the bottom of it.
 */
function watchSections(body: HTMLElement, onChange: (sectionId: string) => void): void {
  const sections = Array.from(body.querySelectorAll<HTMLElement>('.settings__section'));
  if (sections.length === 0) {
    return;
  }

  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          visible.add(entry.target.id);
        } else {
          visible.delete(entry.target.id);
        }
      }
      const first = sections.find((section) => visible.has(section.id));
      if (first !== undefined) {
        onChange(first.id);
      }
    },
    { root: body, rootMargin: '0px 0px -80% 0px', threshold: 0 },
  );

  for (const section of sections) {
    observer.observe(section);
  }
}

void start().catch((error: unknown) => {
  console.error('[settings] settings window failed to start:', error);
});
