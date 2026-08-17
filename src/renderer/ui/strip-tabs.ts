import type { StripTab } from '@shared/contracts.js';
import { requireElement } from './dom.js';

export interface StripTabsActions {
  /** The tab changed: apply its remembered height and persist the choice. */
  onChange: (tab: StripTab) => void;
}

/**
 * The two views of the top strip.
 *
 * Only the strip's content switches. The terminal below is untouched by design: it is the centre of this
 * window, and a tab that stole its space would defeat the point of having it always there.
 */
/** Every tab, in display order. One list, so adding a view is one entry and two elements. */
export const STRIP_TABS: readonly StripTab[] = [
  'projects',
  'pulls',
  'jira',
  'git',
  'triage',
  'worktrees',
];

export class StripTabs {
  private current: StripTab = 'projects';

  private readonly buttons: Record<StripTab, HTMLButtonElement> = {
    projects: requireElement<HTMLButtonElement>('strip-tab-projects'),
    pulls: requireElement<HTMLButtonElement>('strip-tab-pulls'),
    jira: requireElement<HTMLButtonElement>('strip-tab-jira'),
    git: requireElement<HTMLButtonElement>('strip-tab-git'),
    triage: requireElement<HTMLButtonElement>('strip-tab-triage'),
    worktrees: requireElement<HTMLButtonElement>('strip-tab-worktrees'),
  };

  private readonly panels: Record<StripTab, HTMLElement> = {
    projects: requireElement('strip-panel-projects'),
    pulls: requireElement('strip-panel-pulls'),
    jira: requireElement('strip-panel-jira'),
    git: requireElement('strip-panel-git'),
    triage: requireElement('strip-panel-triage'),
    worktrees: requireElement('strip-panel-worktrees'),
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
