import type { ChecksState, GitState, ServerState, SessionStatus } from '@shared/contracts.js';

/**
 * Turns domain state into what the table shows.
 *
 * Kept as pure functions, separate from the DOM, because the interesting decisions live here: which
 * states deserve to look alarming, and which distinctions must not be flattened. They are unit
 * tested for that reason.
 */

export type PillTone = 'neutral' | 'ok' | 'busy' | 'error' | 'info' | 'external';

export interface Pill {
  readonly label: string;
  readonly tone: PillTone;
  readonly title: string;
}

/** Label and tone for a project's dev process. */
export function presentServer(server: ServerState): Pill {
  switch (server.phase) {
    case 'stopped':
      return { label: 'arrêté', tone: 'neutral', title: 'Aucun processus' };
    case 'starting':
      return { label: 'démarrage', tone: 'busy', title: 'Processus lancé, en attente de sortie' };
    case 'linting':
      // Visible on purpose: the `start` scripts lint before serving, so this window is normal and
      // must not look like a failure.
      return { label: 'lint', tone: 'busy', title: 'Étape de lint avant le build' };
    case 'building':
      return { label: 'build', tone: 'busy', title: 'Compilation en cours' };
    case 'serving':
      return {
        label: server.port === null ? 'sert' : `sert :${server.port}`,
        tone: 'ok',
        title: 'Serveur de dev opérationnel',
      };
    case 'watching':
      return {
        label: 'watch',
        tone: 'ok',
        // No port to show, and saying "sert" would promise something observable that does not exist.
        title: 'Build en watch, sans serveur HTTP',
      };
    case 'lint-error':
      return { label: 'lint KO', tone: 'error', title: server.errorSummary ?? 'Erreur de lint' };
    case 'build-error':
      return {
        label: server.errorCount > 1 ? `build KO (${server.errorCount})` : 'build KO',
        tone: 'error',
        title: server.errorSummary ?? 'Erreur de build',
      };
    case 'crashed':
      return { label: 'crash', tone: 'error', title: 'Le processus s’est arrêté seul' };
    case 'external':
      return {
        label: server.port === null ? 'externe' : `externe :${server.port}`,
        tone: 'external',
        title: 'Lancé hors du dashboard, non contrôlable ici',
      };
  }
}

/** True when the dashboard is allowed to stop this process. */
export function canStop(server: ServerState): boolean {
  return server.owned && server.phase !== 'stopped' && server.phase !== 'crashed';
}

/** True when starting makes sense: nothing of ours is running and nobody else holds the port. */
export function canStart(server: ServerState): boolean {
  return !server.owned && server.phase !== 'external';
}

/** Label and tone for the checks column. */
export function presentChecks(checks: ChecksState | null, git: GitState | null): Pill {
  if (git !== null && !git.hasUpstream) {
    // Not an error: the branch was never pushed, so no pull request can exist.
    return { label: 'pas poussée', tone: 'neutral', title: 'La branche n’a pas d’upstream' };
  }
  if (checks === null) {
    return { label: '…', tone: 'neutral', title: 'Pas encore interrogé' };
  }

  switch (checks.verdict) {
    case 'no-pr':
      return { label: 'pas de PR', tone: 'neutral', title: 'Aucune PR pour cette branche' };
    case 'no-checks':
      // Deliberately distinct from `passing`: two real open PRs returned an empty rollup, and
      // painting that green would be a lie.
      return {
        label: 'aucun check',
        tone: 'info',
        title: 'PR ouverte, mais aucun check rapporté',
      };
    case 'pending':
      return {
        label: `en cours ${checks.pending}`,
        tone: 'busy',
        title: `${checks.pending} check(s) en cours`,
      };
    case 'passing':
      return {
        label: `OK ${checks.passed}`,
        tone: 'ok',
        title: `${checks.passed} check(s) au vert`,
      };
    case 'failing':
      return {
        label: `KO ${checks.failed}`,
        tone: 'error',
        title: `${checks.failed} check(s) en échec`,
      };
    case 'unknown':
      return { label: '?', tone: 'neutral', title: checks.error ?? 'État inconnu' };
  }
}

/** Label and tone for a Claude Code session. */
export function presentSession(status: SessionStatus): Pill {
  switch (status) {
    case 'working':
      return { label: 'travaille', tone: 'busy', title: 'Tour en cours' };
    case 'waiting':
      return { label: 'attend', tone: 'ok', title: 'En attente de ta réponse' };
    case 'idle':
      // Sessions stay open for days; without this they would all read as active forever.
      return { label: 'dormante', tone: 'neutral', title: 'Ouverte mais inactive' };
    case 'ended':
      return { label: 'terminée', tone: 'neutral', title: 'Plus aucun processus' };
  }
}

export interface GitSummary {
  readonly parts: { label: string; kind: 'dirty' | 'clean' | 'plain' }[];
  /** Short warning shown next to the branch, when the branch needs attention. */
  readonly warning: string | null;
}

/**
 * Summarises the working tree and the branch position.
 *
 * `ahead`/`behind` earn a place next to the file counts: a repository can be perfectly clean and
 * still be twelve commits behind, which a "files" column alone would report as nothing to do.
 */
export function presentGit(git: GitState | null): GitSummary {
  if (git === null) {
    return { parts: [{ label: '…', kind: 'plain' }], warning: null };
  }
  if (git.error !== null) {
    return { parts: [{ label: 'erreur git', kind: 'dirty' }], warning: null };
  }

  const parts: GitSummary['parts'] = [];
  if (git.staged > 0) {
    parts.push({ label: `${git.staged} staged`, kind: 'dirty' });
  }
  if (git.modified > 0) {
    parts.push({ label: `${git.modified} modifiés`, kind: 'dirty' });
  }
  if (git.untracked > 0) {
    parts.push({ label: `${git.untracked} nouveaux`, kind: 'dirty' });
  }
  if (parts.length === 0) {
    parts.push({ label: 'propre', kind: 'clean' });
  }

  const flags: string[] = [];
  if (git.ahead > 0) {
    flags.push(`↑${git.ahead}`);
  }
  if (git.behind > 0) {
    flags.push(`↓${git.behind}`);
  }

  return { parts, warning: flags.length > 0 ? flags.join(' ') : null };
}

/** Compact relative time for the session list. */
export function formatIdle(minutes: number): string {
  if (minutes < 1) {
    return 'à l’instant';
  }
  if (minutes < 60) {
    return `il y a ${Math.round(minutes)} min`;
  }
  const hours = minutes / 60;
  if (hours < 48) {
    return `il y a ${Math.round(hours)} h`;
  }
  return `il y a ${Math.round(hours / 24)} j`;
}
