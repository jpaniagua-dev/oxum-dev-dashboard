import type { ClaudeSession } from '@shared/contracts.js';
import { clearChildren, createElement } from './dom.js';
import { formatIdle, presentSession } from './presenters.js';
import { buildPill } from './project-table.js';

/**
 * Renders the Claude Code session list.
 *
 * Shows only metadata: project folder, branch, state and age. Conversation content is never read by
 * the service feeding this, so there is nothing here that could leak a prompt.
 */
export function renderSessionList(container: HTMLElement, sessions: readonly ClaudeSession[]): void {
  clearChildren(container);

  if (sessions.length === 0) {
    container.append(
      createElement('div', {
        className: 'empty',
        text: 'Aucune session Claude Code active dans les dernières 24 h.',
      }),
    );
    return;
  }

  for (const session of sessions) {
    container.append(buildSession(session));
  }
}

function buildSession(session: ClaudeSession): HTMLElement {
  const row = createElement('div', { className: 'session' });

  row.append(
    createElement('span', {
      className: 'session__project',
      text: shortenProject(session.project),
      title: session.cwd ?? session.project,
    }),
  );

  row.append(
    createElement('span', {
      className: 'session__branch',
      text: session.gitBranch ?? '—',
      title: session.gitBranch ?? 'branche inconnue',
    }),
  );

  row.append(
    createElement('span', {
      className: 'session__meta',
      text: `${formatIdle(session.idleMinutes)} · ${session.entries} entrées`,
      title: `Dernière activité : ${session.lastActivityAt}`,
    }),
  );

  row.append(buildPill(presentSession(session.status)));
  return row;
}

/**
 * Shortens Claude Code's flattened directory names.
 *
 * They arrive as `C--Users-julpan-oxum-projects-web-app`, which is unreadable in a
 * 120px column; only the tail carries information.
 */
export function shortenProject(project: string): string {
  const withoutPrefix = project.replace(/^[A-Za-z]--(?:Users-[^-]+-)?/, '');
  const parts = withoutPrefix.split('-');
  return parts.length > 4 ? parts.slice(-4).join('-') : withoutPrefix;
}
