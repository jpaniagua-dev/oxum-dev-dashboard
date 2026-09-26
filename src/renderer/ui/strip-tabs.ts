import { STRIP_TABS, type StripTab } from '@shared/contracts.js';
import { requireElement } from './dom.js';

export interface StripTabsActions {
  /** The tab changed: apply its remembered height and persist the choice. */
  onChange: (tab: StripTab) => void;
}

export interface RestoredStripLoaders {
  readonly usage: () => void;
  readonly automations: () => void;
  readonly vault: () => void;
  readonly triage: () => void;
  readonly worktrees: () => void;
  readonly git: () => void;
}

/** Runs the on-demand read that `adopt` deliberately does not report as a user tab change. */
export function loadRestoredStrip(tab: StripTab, loaders: RestoredStripLoaders): void {
  switch (tab) {
    case 'usage':
      loaders.usage();
      break;
    case 'automations':
      loaders.automations();
      break;
    case 'vault':
      loaders.vault();
      break;
    case 'triage':
      loaders.triage();
      break;
    case 'worktrees':
      loaders.worktrees();
      break;
    case 'git':
      loaders.git();
      break;
    case 'projects':
    case 'pulls':
    case 'jira':
    case 'agents':
      break;
  }
}

/**
 * The two views of the top strip.
 *
 * Only the strip's content switches. The terminal below is untouched by design: it is the centre of this
 * window, and a tab that stole its space would defeat the point of having it always there.
 */
export class StripTabs {
  private current: StripTab = 'projects';

  private readonly buttons: Record<StripTab, HTMLButtonElement> = {
    projects: requireElement<HTMLButtonElement>('strip-tab-projects'),
    pulls: requireElement<HTMLButtonElement>('strip-tab-pulls'),
    jira: requireElement<HTMLButtonElement>('strip-tab-jira'),
    git: requireElement<HTMLButtonElement>('strip-tab-git'),
    triage: requireElement<HTMLButtonElement>('strip-tab-triage'),
    worktrees: requireElement<HTMLButtonElement>('strip-tab-worktrees'),
    agents: requireElement<HTMLButtonElement>('strip-tab-agents'),
    usage: requireElement<HTMLButtonElement>('strip-tab-usage'),
    automations: requireElement<HTMLButtonElement>('strip-tab-automations'),
    vault: requireElement<HTMLButtonElement>('strip-tab-vault'),
  };

  private readonly panels: Record<StripTab, HTMLElement> = {
    projects: requireElement('strip-panel-projects'),
    pulls: requireElement('strip-panel-pulls'),
    jira: requireElement('strip-panel-jira'),
    git: requireElement('strip-panel-git'),
    triage: requireElement('strip-panel-triage'),
    worktrees: requireElement('strip-panel-worktrees'),
    agents: requireElement('strip-panel-agents'),
    usage: requireElement('strip-panel-usage'),
    automations: requireElement('strip-panel-automations'),
    vault: requireElement('strip-panel-vault'),
  };

  constructor(private readonly actions: StripTabsActions) {
    for (const tab of STRIP_TABS) {
      this.buttons[tab].addEventListener('click', () => this.select(tab));
    }
  }

  get active(): StripTab {
    return this.current;
  }

  /** Selects a tab. Silent when it is already the active one, so no height is reapplied for nothing. */
  select(tab: StripTab): void {
    if (tab === this.current) {
      return;
    }
    this.current = tab;
    this.render();
    this.actions.onChange(tab);
  }

  /** Applies a tab without reporting it, for the initial state read from the settings. */
  adopt(tab: StripTab): void {
    this.current = tab;
    this.render();
  }

  private render(): void {
    for (const tab of STRIP_TABS) {
      const active = tab === this.current;
      this.panels[tab].hidden = !active;
      this.buttons[tab].classList.toggle('strip__tab--active', active);
      this.buttons[tab].setAttribute('aria-selected', String(active));
    }
  }
}
