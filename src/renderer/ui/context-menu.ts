import { createElement } from './dom.js';

export interface MenuItem {
  readonly label: string;
  readonly run: () => void;
  readonly disabled?: boolean;
  readonly hint?: string;
}

/** Only one menu is ever open, so the open one is module state rather than per-caller state. */
let open: HTMLElement | null = null;

/**
 * Set while the click that opened the current menu may still be on its way to `document`.
 *
 * This is the fix for a bug this codebase shipped **twice**: the dismissal below closes the menu on any
 * click reaching `document`, so a menu opened from a left-click handler was shut by the very click that
 * opened it, in the same tick, before a frame was painted. Nothing on screen, nothing in the console, a
 * button that looks dead. It killed both Triage buttons in one version and the Worktrees tab's two menu
 * openers in another, each time leaving a note in `CLAUDE.md` telling the next author to remember
 * `stopPropagation` at the call site. A note that has failed twice is not a mechanism.
 *
 * **A flag set by `showContextMenu` itself, and not the identity of the opening event**, which was the
 * first attempt and is subtly wrong here. Recognising the event would mean recording it from a
 * capture-phase listener on `document`; `bindDismissal` is lazy, so on the very first menu of a session
 * that listener is registered while the opening click is already past document's capture phase. The
 * first menu after launch would go unrecognised and close on its own, and every one after it would
 * work: an intermittent version of the bug being fixed. A flag set here has no ordering dependency at
 * all.
 *
 * It is cleared twice over, and both clearings are needed:
 *
 * - by the dismissal, which consumes it, so the **next** click dismisses normally;
 * - by a timeout, for a menu opened from something that is not a click (a keyboard shortcut, or a
 *   `contextmenu`, which fires no `click` at all). Without it the flag would sit armed and swallow the
 *   first genuine dismissal instead.
 *
 * A real click always arrives in a later task than the one that opened the menu, so the timeout can
 * never disarm a flag that was still needed.
 *
 * Call sites may still call `stopPropagation` and several do. It is now a belt over these braces, and
 * it does a second job they still need: keeping the opening click from reaching row handlers.
 */
let openingClickPending = false;

/**
 * Opens a context menu at a point, replacing any menu already open.
 *
 * Positioned after being measured, so a menu opened near an edge folds back inside the window instead of
 * being cut off. Shared by the terminal panes and the Jira list rather than written twice: two context
 * menus would drift apart on exactly the details that make one usable.
 */
export function showContextMenu(x: number, y: number, items: readonly MenuItem[]): void {
  bindDismissal();
  closeContextMenu();
  const menu = createElement('div', { className: 'context-menu' });

  for (const item of items) {
    const button = createElement('button', { className: 'context-menu__item', text: item.label });
    button.type = 'button';
    button.disabled = item.disabled === true;
    if (item.hint !== undefined) {
      button.title = item.hint;
    }
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeContextMenu();
      item.run();
    });
    menu.append(button);
  }

  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - box.width - 4)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - box.height - 4)}px`;
  open = menu;
  // Last, and after the `closeContextMenu` above has already cleared it: a click still travelling
  // towards `document` is the one that opened this menu, and it must not also close it.
  openingClickPending = true;
  window.setTimeout(() => {
    openingClickPending = false;
  }, 0);
}

export function closeContextMenu(): void {
  open?.remove();
  open = null;
  // Disarmed with the menu it belonged to: with no menu on screen there is nothing for the next click
  // to be forgiven for.
  openingClickPending = false;
}

let bound = false;

/**
 * Registers the dismissal listeners, once, on first use.
 *
 * Deliberately not at module scope: importing this file must have no side effect, or every unit test that
 * transitively imports it needs a DOM. Two of them broke exactly that way.
 */
function bindDismissal(): void {
  if (bound) {
    return;
  }
  bound = true;
  /*
   * Any click anywhere dismisses it, which is what every menu in every app does. The exception is the
   * click that opened the menu, still on its way up to `document`: see `openingClickPending`.
   *
   * Bubble phase, deliberately. A capture-phase listener here would run **before** the button whose
   * handler opens the menu, so it would close the previous menu and then be of no use to this one. It
   * has to sit downstream of the opener, which is where the flag is read.
   */
  document.addEventListener('click', () => {
    if (openingClickPending) {
      // Consumed, so the very next click dismisses normally. Only ever true for the one click that
      // opened the menu now on screen.
      openingClickPending = false;
      return;
    }
    closeContextMenu();
  });
  // A menu that survived losing focus would point at something that has moved.
  window.addEventListener('blur', () => closeContextMenu());
}
