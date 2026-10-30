import { describe, expect, it } from 'vitest';
import type { ProjectValidation } from '../src/shared/contracts.js';
import { saveBlocker, saveErrorMessage, saveToast } from '../src/renderer/ui/settings-form.js';

function validation(id: string, level: 'error' | 'warning' | null): ProjectValidation {
  return {
    id,
    issues: level === null ? [] : [{ level, message: 'This folder does not exist' }],
    serverCommand: '',
    scripts: [],
    inferredKind: null,
    inferredPort: null,
  };
}

const projects = [
  { id: 'web-app', label: 'Web app' },
  { id: 'admin-front', label: 'Admin front' },
];
const goodModels = ['', 'sonnet', 'claude-opus-5[1m]', ''];

describe('saveBlocker', () => {
  it('lets a clean configuration be saved, warnings included', () => {
    expect(
      saveBlocker(
        [validation('web-app', 'warning'), validation('admin-front', null)],
        projects,
        null,
        goodModels,
      ),
    ).toBeNull();
  });

  it('names the broken projects in the complete window', () => {
    expect(
      saveBlocker(
        [validation('web-app', null), validation('admin-front', 'error')],
        projects,
        null,
        goodModels,
      ),
    ).toBe('Fix the errors on Admin front to save');
  });

  it("ignores another project's error in the window scoped to one project", () => {
    expect(
      saveBlocker(
        [validation('web-app', null), validation('admin-front', 'error')],
        projects,
        'web-app',
        goodModels,
      ),
    ).toBeNull();
  });

  it("still blocks on the scoped project's own error, and says where to look", () => {
    expect(
      saveBlocker(
        [validation('web-app', 'error'), validation('admin-front', null)],
        projects,
        'web-app',
        goodModels,
      ),
    ).toBe('Fix the error shown on this project to save');
  });

  it('blocks on a model that is not a model name', () => {
    expect(saveBlocker([], projects, null, ['sonnet 4'])).toBe(
      'A model on the Agent page is not a model name',
    );
  });
});

describe('saveToast', () => {
  it('names what was saved, one project or the whole window', () => {
    expect(saveToast([], true)).toEqual({ tone: 'ok', text: 'Project saved' });
    expect(saveToast([], false)).toEqual({ tone: 'ok', text: 'Settings saved' });
  });

  it('reports a secondary write that failed as an error, saying what was not saved', () => {
    expect(saveToast(['the Tipee password: Encryption is not available'], false)).toEqual({
      tone: 'error',
      text: 'Saved, except the Tipee password: Encryption is not available',
    });
  });
});

describe('saveErrorMessage', () => {
  it('drops the wrapper Electron puts around an error thrown in the main process', () => {
    const error = new Error(
      "Error invoking remote method 'projects:save': Error: EPERM: operation not permitted, rename",
    );
    expect(saveErrorMessage(error)).toBe('EPERM: operation not permitted, rename');
  });

  it('keeps a message that has no wrapper, and a thrown value that is not an Error', () => {
    expect(saveErrorMessage(new Error('Disk full'))).toBe('Disk full');
    expect(saveErrorMessage('Disk full')).toBe('Disk full');
  });
});
