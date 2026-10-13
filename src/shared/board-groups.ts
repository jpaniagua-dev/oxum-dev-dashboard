import type { TagColor, TerminalSession } from './contracts.js';
import { DEFAULT_TAG_COLOR, isTagColor } from './project-tags.js';

/**
 * Groups of cards on the Cards canvas: a named, coloured frame holding the cards put in it.
 *
 * Added on 2026-10-13, on request, to keep agents, dev servers, watches and shells that belong
 * together in one place on the board. Pure, so the rules that matter are tested without a canvas:
 * which key a card is filed under, what survives a restart, and that a card sits in one group at
 * most.
 *
 * ⚠️ **A group holds keys, never terminal ids.** A terminal id is minted per launch (`shell-3`), so a
 * group keyed on it would come back empty after every restart, including for the agents the app
 * now reopens. Each card is filed under the most durable fact it has (see `memberKeyOf`).
 */

/** What a group files a card under. A prefix says how long it lasts. */
export type MemberKey = string;

export interface BoardGroup {
  readonly id: string;
  readonly name: string;
  readonly color: TagColor;
  /** Top left of the frame, in canvas units. */
  readonly x: number;
  readonly y: number;
  /** The cards in the frame, in the order they are drawn. */
  readonly members: readonly MemberKey[];
}

/** Longest group name kept: a frame title is one line over two cards. */
export const GROUP_NAME_LIMIT = 40;
/** How many groups a board keeps, which is far past what a canvas can show and bounds the setting. */
const GROUP_LIMIT = 30;
const MEMBER_LIMIT = 60;

/**
 * The key a card is filed under, from its most durable fact.
 *
 * - An agent with a conversation is that conversation, `agent:<id>`: the app reopens it on that id
 *   at the next launch, so it finds its group again.
 * - A session tied to a project action (a dev server, a watch, a handoff without a conversation) is
 *   `action:<project>/<action>`: running the same action again lands in the same group.
 * - Anything else, a shell first, is `session:<terminal id>`, valid for this run only. A shell has
 *   nothing that outlives it, and it does not come back after a restart anyway.
 */
export function memberKeyOf(session: TerminalSession): MemberKey {
  const conversation = session.agent?.conversation;
  if (conversation !== undefined) {
    return `agent:${conversation.id}`;
  }
  if (session.projectId !== null && session.actionId !== null) {
    return `action:${session.projectId}/${session.actionId}`;
  }
  return `session:${session.id}`;
}

/** Whether a key can only mean something during the run that wrote it. */
function isRunOnly(key: MemberKey): boolean {
  return key.startsWith('session:');
}

/**
 * The groups as stored, cleaned.
 *
 * Run on what is read at launch and on what crosses the IPC boundary, like the tag colours: a whole
 * object arriving from the renderer is checked at the boundary. `dropRunOnly` is for the launch: a
 * `session:` key written by the previous run names a terminal id that now means another tab, or
 * nothing. A key in two groups stays in the first, which is the one invariant the board relies on.
 */
export function sanitizeBoardGroups(value: unknown, dropRunOnly = false): BoardGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seenIds = new Set<string>();
  const filed = new Set<MemberKey>();
  const groups: BoardGroup[] = [];
  for (const entry of value.slice(0, GROUP_LIMIT)) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const row = entry as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'].trim() : '';
    if (!/^[\w-]{1,40}$/.test(id) || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const members: MemberKey[] = [];
    for (const key of Array.isArray(row['members']) ? row['members'].slice(0, MEMBER_LIMIT) : []) {
      if (typeof key !== 'string' || !/^(agent|action|session):\S{1,200}$/.test(key)) {
        continue;
      }
      if (filed.has(key) || (dropRunOnly && isRunOnly(key))) {
        continue;
      }
      filed.add(key);
      members.push(key);
    }
    groups.push({
      id,
      name: cleanName(row['name']),
      color: isTagColor(row['color']) ? row['color'] : DEFAULT_TAG_COLOR,
      x: finite(row['x']),
      y: finite(row['y']),
      members,
    });
  }
  return groups;
}

/** A group name as typed, trimmed and capped; empty becomes `Group`, a frame must say something. */
export function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_LIMIT) : '';
  return name.length > 0 ? name : 'Group';
}

/** The group a key is filed in, or undefined. */
export function groupOf(groups: readonly BoardGroup[], key: MemberKey): BoardGroup | undefined {
  return groups.find((group) => group.members.includes(key));
}

/**
 * Files a key in a group, taking it out of any other: a card is in one frame at most. `null` takes
 * it out of every group, which is what dropping a card outside a frame means. A key moved into the
 * group it is already in keeps its place.
 */
export function moveToGroup(
  groups: readonly BoardGroup[],
  key: MemberKey,
  groupId: string | null,
): BoardGroup[] {
  return groups.map((group) => {
    if (group.id === groupId) {
      return group.members.includes(key) ? group : { ...group, members: [...group.members, key] };
    }
    return group.members.includes(key)
      ? { ...group, members: group.members.filter((entry) => entry !== key) }
      : group;
  });
}

/** A new, empty group at a point, named after how many there already are. */
export function newGroup(groups: readonly BoardGroup[], at: { x: number; y: number }, color: TagColor): BoardGroup {
  let index = groups.length + 1;
  const names = new Set(groups.map((group) => group.name));
  while (names.has(`Group ${String(index)}`)) {
    index += 1;
  }
  return {
    id: `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name: `Group ${String(index)}`,
    color,
    x: Math.round(at.x),
    y: Math.round(at.y),
    members: [],
  };
}

/** A rectangle in canvas units. */
export interface GroupRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The group whose frame holds a canvas point, or null.
 *
 * The last one drawn wins when frames overlap, since that is the one on top.
 */
export function groupAt(
  point: { x: number; y: number },
  frames: readonly { id: string; rect: GroupRect }[],
): string | null {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (
      frame !== undefined &&
      point.x >= frame.rect.x &&
      point.x <= frame.rect.x + frame.rect.width &&
      point.y >= frame.rect.y &&
      point.y <= frame.rect.y + frame.rect.height
    ) {
      return frame.id;
    }
  }
  return null;
}

/** The tag colour a new group takes: the one used by the fewest groups, so neighbours differ. */
export function nextGroupColor(groups: readonly BoardGroup[], palette: readonly TagColor[]): TagColor {
  let best: TagColor = palette[0] ?? DEFAULT_TAG_COLOR;
  let fewest = Infinity;
  for (const color of palette) {
    const used = groups.filter((group) => group.color === color).length;
    if (used < fewest) {
      fewest = used;
      best = color;
    }
  }
  return best;
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}
