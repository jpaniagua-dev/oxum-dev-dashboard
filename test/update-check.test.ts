import { describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, noticeFrom, SETUP_ASSET } from '../src/main/updates/update-check.js';

const RELEASE = {
  tag_name: 'v9.1.0',
  html_url: 'https://github.com/example/app/releases/tag/v9.1.0',
  assets: [
    { name: 'app.zip', browser_download_url: 'https://example.com/app.zip' },
    { name: 'oxum-dev-dashboard-9.1.0-win-x64-setup.exe.blockmap', browser_download_url: 'https://example.com/blockmap' },
    { name: 'oxum-dev-dashboard-9.1.0-win-x64-setup.exe', browser_download_url: 'https://example.com/setup.exe' },
  ],
};

describe('compareVersions', () => {
  it('compares numerically, part by part', () => {
    expect(compareVersions('8.10.0', '8.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v9.0.0', '9.0.0')).toBe(0);
    expect(compareVersions('9', '9.0.1')).toBeLessThan(0);
    expect(compareVersions('not a version', '1.0.0')).toBe(0);
  });
});

describe('noticeFrom', () => {
  it('points at the installer of a newer release', () => {
    expect(noticeFrom(RELEASE, '8.5.0')).toEqual({
      version: '9.1.0',
      download: 'https://example.com/setup.exe',
      page: RELEASE.html_url,
    });
  });

  it('says nothing for the running version or an older one', () => {
    expect(noticeFrom(RELEASE, '9.1.0')).toBeNull();
    expect(noticeFrom(RELEASE, '10.0.0')).toBeNull();
    expect(noticeFrom(null, '1.0.0')).toBeNull();
  });

  it('still finds the unversioned installer of releases before 10.1.0', () => {
    const legacy = {
      ...RELEASE,
      assets: [{ name: 'oxum-dev-dashboard-win-x64-setup.exe', browser_download_url: 'https://example.com/legacy.exe' }],
    };
    expect(noticeFrom(legacy, '8.5.0')?.download).toBe('https://example.com/legacy.exe');
    expect(SETUP_ASSET.test('Oxum Dev Dashboard-9.1.0-portable.exe')).toBe(false);
  });

  it('falls back to the release page without the installer', () => {
    expect(noticeFrom({ ...RELEASE, assets: [] }, '8.5.0')?.download).toBe(RELEASE.html_url);
  });
});

describe('checkForUpdate', () => {
  it('turns a failure into no notice', async () => {
    const failing = (): Promise<Response> => Promise.reject(new Error('offline'));
    expect(await checkForUpdate('8.5.0', failing)).toBeNull();
    const refused = (): Promise<Response> => Promise.resolve(new Response('', { status: 403 }));
    expect(await checkForUpdate('8.5.0', refused)).toBeNull();
  });

  it('reads the answer of a working API', async () => {
    const ok = (): Promise<Response> => Promise.resolve(new Response(JSON.stringify(RELEASE), { status: 200 }));
    expect((await checkForUpdate('8.5.0', ok))?.version).toBe('9.1.0');
  });
});
