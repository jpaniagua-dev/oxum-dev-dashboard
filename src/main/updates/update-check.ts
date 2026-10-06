import type { UpdateNotice } from '@shared/contracts.js';

/**
 * Whether a newer release is out, read from GitHub's public API.
 *
 * A notice and not an updater, decided: an unsigned build that replaces itself is the kind of
 * thing antivirus and IT policies stop, while a button that downloads the installer leaves the
 * reader in charge of when it happens. No `gh` needed: the repository is public, and a colleague's
 * machine may not have `gh` signed in.
 */

/** The public repository the releases are published on. */
export const RELEASES_REPO = 'jpaniagua-dev/oxum-dev-dashboard';

/**
 * The installer's name on a release, the one that also installs the toast shortcut. Versioned since
 * 10.1.0 (`oxum-dev-dashboard-10.1.0-win-x64-setup.exe`); the unversioned name earlier releases
 * carried still matches, so this never depends on which pattern the latest release was built with.
 */
export const SETUP_ASSET = /^oxum-dev-dashboard-(?:\d+\.\d+\.\d+-)?win-x64-setup\.exe$/;

/** How often a running app looks again. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** `8.10.2` against `8.9.0`, numerically. Missing parts count as 0; anything else as not newer. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string): number[] | null => {
    const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value.trim());
    return match === null ? null : [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  };
  const a = parts(left);
  const b = parts(right);
  if (a === null || b === null) {
    return 0;
  }
  for (let at = 0; at < 3; at += 1) {
    const diff = (a[at] ?? 0) - (b[at] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/**
 * The notice a `releases/latest` answer means for the running version, or null.
 *
 * The download is the installer asset when the release carries it, the release page otherwise.
 */
export function noticeFrom(body: unknown, running: string): UpdateNotice | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const release = body as { tag_name?: unknown; html_url?: unknown; assets?: unknown };
  if (typeof release.tag_name !== 'string' || compareVersions(release.tag_name, running) <= 0) {
    return null;
  }
  const page = typeof release.html_url === 'string' ? release.html_url : `https://github.com/${RELEASES_REPO}/releases/latest`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const setup = assets.find((asset: unknown) => {
    const name = typeof asset === 'object' && asset !== null ? (asset as { name?: unknown }).name : undefined;
    return typeof name === 'string' && SETUP_ASSET.test(name);
  }) as { browser_download_url?: unknown } | undefined;
  return {
    version: release.tag_name.replace(/^v/, ''),
    download: typeof setup?.browser_download_url === 'string' ? setup.browser_download_url : page,
    page,
  };
}

/** One look at the latest release. Any failure is "no notice", logged once, never shown. */
export async function checkForUpdate(
  running: string,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
): Promise<UpdateNotice | null> {
  try {
    const response = await fetcher(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'oxum-dev-dashboard' },
    });
    if (!response.ok) {
      console.warn(`[update] GitHub answered ${response.status}`);
      return null;
    }
    return noticeFrom(await response.json(), running);
  } catch (error) {
    console.warn('[update] check failed', error);
    return null;
  }
}
