import type { TerminalSession } from './contracts.js';

/** A configured long-running project action that can be restarted in place. */
export function canRerunSession(
  session: Pick<TerminalSession, 'actionId' | 'projectId' | 'role'>,
): session is Pick<TerminalSession, 'actionId' | 'projectId' | 'role'> & {
  readonly actionId: string;
  readonly projectId: string;
  readonly role: 'server';
} {
  return session.role === 'server' && session.projectId !== null && session.actionId !== null;
}
