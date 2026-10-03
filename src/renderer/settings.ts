import type { ProjectId, ThemeState } from '@shared/contracts.js';
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
      review: requireElement('settings-review'),
      automations: requireElement('settings-automations'),
      jira: requireElement('settings-jira'),
      footer: requireElement('settings-footer'),
    },
    {
      // The main process owns the close confirmation: only the window's own `close` handler can still
      // cancel it, so the flag has to live there.
      onDirtyChange: (dirty) => window.api.reportSettingsDirty(dirty),
      onRequestClose: () => void window.api.closeWindow(),
      // Pages belong to the window: the form builds the rail, this decides what "go there" means.
      onNavigate: (sectionId) => {
        showPage(body, sectionId);
        form.setActiveSection(sectionId);
      },
    },
  );

  await form.load(bootstrap.settings, bootstrap.shellProfiles, bootstrap.jiraConfig);
  applyScope(body, form, await window.api.settingsScope());

  window.api.onSettingsScopeChanged((projectId) => applyScope(body, form, projectId));

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

/** Switches between the complete settings window and one project's isolated configuration. */
function applyScope(body: HTMLElement, form: SettingsForm, projectId: ProjectId | null): void {
  const scoped = projectId !== null;
  const page = requireElement('settings-page');
  page.classList.toggle('settings-page--project', scoped);
  requireElement('settings-rail-container').hidden = scoped;

  requireElement('settings-projects-title').textContent = scoped ? 'Project settings' : 'Projects';
  requireElement('settings-projects-note').textContent = scoped
    ? 'Only this project is shown. Save applies these changes to its row in the dashboard.'
    : 'The repositories the dashboard watches. A folder is enough: the kind and the port are inferred from its package.json.';
  document.title = scoped ? 'Project settings - Oxum Dev Dashboard' : 'Settings - Oxum Dev Dashboard';

  form.setProjectScope(projectId);
  const section = scoped ? 'section-projects' : 'section-interface';
  showPage(body, section);
  form.setActiveSection(section);
}

function applyTheme(state: ThemeState): void {
  document.documentElement.dataset.theme = state.resolved;
}

/** Shows one page and hides the others, back at its top. */
function showPage(body: HTMLElement, sectionId: string): void {
  for (const section of body.querySelectorAll<HTMLElement>('.settings__section')) {
    section.hidden = section.id !== sectionId;
  }
  body.scrollTop = 0;
}

void start().catch((error: unknown) => {
  console.error('[settings] settings window failed to start:', error);
});
