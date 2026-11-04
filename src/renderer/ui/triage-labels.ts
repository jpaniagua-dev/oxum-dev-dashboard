import type { TriageVerdict } from '@shared/contracts.js';

/**
 * What each verdict is called on screen, and in which order the groups appear.
 *
 * Ordered by what the reader can act on: what is buildable now comes first, what needs a word from
 * them second, and what nobody can move today last. A list sorted by ticket key would bury the one
 * group the tab exists to surface. Its own module because the Tickets tab names a verdict too, and two
 * copies of these words would drift.
 */
export const VERDICT_LABEL: Readonly<Record<TriageVerdict, string>> = {
  ready: 'Ready to build',
  'needs-decision': 'Waiting on a decision',
  unclear: 'Specification too thin',
  blocked: 'Blocked',
};
