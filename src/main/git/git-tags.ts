import type { GitRemoteTags, GitResult } from '@shared/contracts.js';
import { readRefs } from './git-commands.js';
import { GIT_NETWORK_TIMEOUT_MS, describeGitError, git, tryGit } from './run-git.js';

/*
 * Tags: create, push one, delete a local one, and know which ones the remote has.
 *
 * Its own module because the rules differ from the branch writes in one place that matters: a pushed
 * tag can start a release. The confirmation that guards the push lives in the IPC layer, which owns
 * the window; everything here is what the dialog says and what runs once it is answered.
 */

/** Same guard as everywhere a revision travels: hexadecimal, nothing else. */
const SHA_PATTERN = /^[0-9a-f]{4,40}$/i;

/**
 * Creates an annotated tag on a commit.
 *
 * - **Annotated** (`-a`), not lightweight: a tag that may become a release keeps who made it and when,
 *   which a lightweight tag (a bare pointer) does not record. The message defaults to the name.
 * - **Validated by git** (`check-ref-format refs/tags/<name>`), for the reason branch names are:
 *   git's rules are subtler than any pattern of ours.
 * - **Never moved**: an existing name is refused rather than passed `-f`, since moving a tag other
 *   people may have fetched is the tag version of a force push.
 */
export async function createTag(
  repoPath: string,
  name: string,
  sha: string,
  message: string,
): Promise<GitResult> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Empty tag name' };
  }
  if (trimmed.startsWith('-')) {
    return { ok: false, message: `Invalid tag name: ${trimmed}` };
  }
  if (!SHA_PATTERN.test(sha)) {
    return { ok: false, message: 'Not a commit' };
  }
  const valid = await tryGit(repoPath, ['check-ref-format', `refs/tags/${trimmed}`]);
  if (!valid.ok) {
    return { ok: false, message: `Invalid tag name: ${trimmed}` };
  }
  const existing = await tryGit(repoPath, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/tags/${trimmed}`,
  ]);
  if (existing.ok) {
    return { ok: false, message: `Tag ${trimmed} already exists: this tab does not move a tag` };
  }
  const text = message.trim().length > 0 ? message.trim() : trimmed;
  const result = await tryGit(repoPath, ['tag', '-a', '-m', text, trimmed, sha]);
  return { ok: result.ok, message: result.ok ? `Tag ${trimmed} created` : result.message };
}

/**
 * The remote tags are pushed to: the current branch's remote, `origin` otherwise.
 *
 * Read again at every call rather than taken from the renderer, like Push's upstream. Null when the
 * repository has no remote at all, which is a state to say, not to guess around.
 */
export async function tagRemote(repoPath: string): Promise<string | null> {
  const remotes = (await tryGit(repoPath, ['remote'])).stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (remotes.length === 0) {
    return null;
  }
  const current = (await readRefs(repoPath)).find((ref) => ref.current);
  const upstreamRemote = current?.upstream?.split('/')[0];
  if (upstreamRemote !== undefined && remotes.includes(upstreamRemote)) {
    return upstreamRemote;
  }
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

/**
 * Pushes ONE tag, by its full ref name.
 *
 * Never `--tags`, which publishes every local tag at once, test ones included. The full name
 * `refs/tags/<name>` is what keeps a branch of the same name from being pushed instead. The caller
 * has confirmed already: see `pushTagPlan` for what the dialog is told.
 */
export async function pushTag(repoPath: string, remote: string, name: string): Promise<GitResult> {
  const result = await tryGit(repoPath, ['push', remote, `refs/tags/${name}`], {
    timeoutMs: GIT_NETWORK_TIMEOUT_MS,
  });
  return { ok: result.ok, message: result.ok ? `Tag ${name} pushed to ${remote}` : result.message };
}

/** What a confirmation needs to say before a tag is pushed, or why it cannot be. */
export type PushTagPlan =
  | { readonly ok: true; readonly remote: string; readonly sha: string; readonly subject: string }
  | { readonly ok: false; readonly message: string };

/**
 * Checks a push request against the repository as it is now.
 *
 * The tag must exist locally (a poll old is long enough for it to have been deleted), and there must
 * be a remote. The commit it points to is read for the dialog: "push v2 (abc1234 Fix the login)"
 * catches a tag made on the wrong commit, "push v2" does not.
 */
export async function pushTagPlan(repoPath: string, name: string): Promise<PushTagPlan> {
  const tag = (await readRefs(repoPath)).find((ref) => ref.kind === 'tag' && ref.name === name);
  if (tag === undefined) {
    return { ok: false, message: `Tag ${name} no longer exists here` };
  }
  const remote = await tagRemote(repoPath);
  if (remote === null) {
    return { ok: false, message: 'This repository has no remote to push to' };
  }
  const subject = (await tryGit(repoPath, ['log', '-1', '--format=%s', tag.sha])).stdout.trim();
  return { ok: true, remote, sha: tag.sha, subject };
}

/**
 * The tags a remote has, by name.
 *
 * git keeps no remote-tracking ref for tags (there is no `origin/v1` the way there is an
 * `origin/main`), so the only answer is to ask the remote: `ls-remote --tags`, a network call. That is
 * why it runs on Fetch and after a tag push, both network gestures already, and never on the poll.
 */
export async function readRemoteTags(repoPath: string): Promise<GitRemoteTags> {
  const remote = await tagRemote(repoPath);
  if (remote === null) {
    return { remote: null, tags: [], error: 'No remote' };
  }
  try {
    const out = await git(repoPath, ['ls-remote', '--tags', remote], {
      timeoutMs: GIT_NETWORK_TIMEOUT_MS,
    });
    return { remote, tags: parseLsRemoteTags(out), error: null };
  } catch (error) {
    return { remote, tags: [], error: describeGitError(error) };
  }
}

/**
 * Reads `git ls-remote --tags`: `<sha>\trefs/tags/<name>`, plus a `^{}` line per annotated tag
 * giving the commit it peels to. The peeled lines name the same tag a second time and are dropped.
 * Pure and exported for testing.
 */
export function parseLsRemoteTags(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const ref = line.split('\t')[1]?.trim() ?? '';
    if (!ref.startsWith('refs/tags/')) {
      continue;
    }
    names.add(ref.slice('refs/tags/'.length).replace(/\^\{\}$/, ''));
  }
  return [...names].sort();
}

/**
 * Deletes a LOCAL tag, and only one the remote does not have.
 *
 * A tag the remote has would come straight back with the next fetch, which makes deleting it here a
 * gesture that looks like it worked and did not; deleting it on the remote is for a terminal, a
 * release having possibly been built from it. The remote is asked again here, and a remote that
 * cannot be reached refuses the delete rather than guessing.
 */
export async function deleteLocalTag(repoPath: string, name: string): Promise<GitResult> {
  const tag = (await readRefs(repoPath)).find((ref) => ref.kind === 'tag' && ref.name === name);
  if (tag === undefined) {
    return { ok: false, message: `Tag ${name} no longer exists here` };
  }
  const remote = await readRemoteTags(repoPath);
  if (remote.remote !== null) {
    if (remote.error !== null) {
      return {
        ok: false,
        message: `Could not ask ${remote.remote} whether it has ${name}: ${remote.error}`,
      };
    }
    if (remote.tags.includes(name)) {
      return {
        ok: false,
        message: `${name} is on ${remote.remote}: it would come back on the next fetch. Delete it from a terminal`,
      };
    }
  }
  const result = await tryGit(repoPath, ['tag', '-d', name]);
  return { ok: result.ok, message: result.ok ? `Tag ${name} deleted` : result.message };
}
