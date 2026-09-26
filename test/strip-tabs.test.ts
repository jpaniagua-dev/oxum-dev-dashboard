import { describe, expect, it, vi } from 'vitest';
import { STRIP_TABS, type StripTab } from '../src/shared/contracts.js';
import {
  loadRestoredStrip,
  type RestoredStripLoaders,
} from '../src/renderer/ui/strip-tabs.js';

function loaders(): Record<keyof RestoredStripLoaders, ReturnType<typeof vi.fn>> {
  return {
    usage: vi.fn(),
    automations: vi.fn(),
    vault: vi.fn(),
    triage: vi.fn(),
    worktrees: vi.fn(),
    git: vi.fn(),
  };
}

describe('loadRestoredStrip', () => {
  const onDemand: Readonly<Partial<Record<StripTab, keyof RestoredStripLoaders>>> = {
    usage: 'usage',
    automations: 'automations',
    vault: 'vault',
    triage: 'triage',
    worktrees: 'worktrees',
    git: 'git',
  };

  for (const tab of STRIP_TABS) {
    it(`${tab} dispatches only its startup read when one is required`, () => {
      const reads = loaders();

      loadRestoredStrip(tab, reads);

      for (const [name, read] of Object.entries(reads)) {
        expect(read).toHaveBeenCalledTimes(onDemand[tab] === name ? 1 : 0);
      }
    });
  }
});
