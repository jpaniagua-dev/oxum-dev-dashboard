import type {
  ChecksState,
  GitState,
  PrReview,
  PullRequest,
  ServerState,
} from '@shared/contracts.js';

/**
 * Turns domain state into what the table shows.
 *
 * Kept as pure functions, separate from the DOM, because the interesting decisions live here: which
 * states deserve to look alarming, and which distinctions must not be flattened. They are unit
 * tested for that reason.
 */

export type PillTone = 'neutral' | 'ok' | 'busy' | 'error' | 'info';

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
  }
}

/** True when the dashboard is allowed to stop this process. */
export function canStop(server: ServerState): boolean {
  return server.owned && server.phase !== 'stopped' && server.phase !== 'crashed';
}

/**
 * True when starting makes sense: nothing of ours is already running.
 *
 * Deliberately says nothing about who else might hold the port. The dashboard used to detect servers
 * started elsewhere and disable the button; now that every launch goes through its own terminal, that
 * detection was noise. The trade-off is explicit: if something outside still holds the port, the
 * action starts and fails with the address already in use, visibly, in its own tab.
 */
export function canStart(server: ServerState): boolean {
  return !server.owned;
}

/**
 * Label and tone for a pull request's review state.
 *
 * `none` gets a neutral pill rather than a green one: `gh` reports an empty `reviewDecision` when the
 * repository requires no review at all, and showing that as approved would claim something nobody said.
 */
export function presentReview(review: PrReview): Pill {
  switch (review) {
    case 'approved':
      return { label: 'approuvée', tone: 'ok', title: 'Au moins une approbation, rien à corriger' };
    case 'changes-requested':
      return {
        label: 'à corriger',
        tone: 'error',
        title: 'Un relecteur a demandé des changements',
      };
    case 'review-required':
      return { label: 'à relire', tone: 'busy', title: 'En attente de relecture' };
    case 'none':
      return { label: 'sans review', tone: 'neutral', title: 'Aucune relecture requise' };
  }
}

/**
 * Label and tone for a pull request's checks.
 *
 * Same vocabulary as the project rows, on purpose: `OK n` / `KO n` / `en cours n`, and `aucun check`
 * kept distinct from green.
 */
export function presentPullChecks(pull: PullRequest): Pill {
  switch (pull.checks) {
    case 'passing':
      return { label: `OK ${pull.passed}`, tone: 'ok', title: `${pull.passed} check(s) au vert` };
    case 'failing':
      return { label: `KO ${pull.failed}`, tone: 'error', title: `${pull.failed} check(s) en échec` };
    case 'pending':
      return {
        label: `en cours ${pull.pending}`,
        tone: 'busy',
        title: `${pull.pending} check(s) en cours`,
      };
    case 'no-checks':
      return { label: 'aucun check', tone: 'info', title: 'Aucun check rapporté' };
    case 'no-pr':
    case 'unknown':
      return { label: '?', tone: 'neutral', title: 'État des checks inconnu' };
  }
}

/**
 * Why a pull request concerns the user, or nothing when it does not.
 *
 * Author and reviewer are separate flags in the payload, so the badge can say which it is instead of a
 * flat "mine" that hides whether the ball is in your court.
 */
export function presentInvolvement(pull: PullRequest): Pill | null {
  if (pull.isAuthor && pull.isReviewer) {
    return { label: 'à moi', tone: 'info', title: 'Vous êtes auteur et relecteur demandé' };
  }
  if (pull.isAuthor) {
    return { label: 'auteur', tone: 'neutral', title: 'Vous êtes l’auteur' };
  }
  if (pull.isReviewer) {
    return { label: 'à relire', tone: 'busy', title: 'Votre relecture est demandée' };
  }
  return null;
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

