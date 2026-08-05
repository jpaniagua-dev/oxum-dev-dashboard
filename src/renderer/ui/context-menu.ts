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
}

export function closeContextMenu(): void {
  open?.remove();
  open = null;
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
  // Any click anywhere dismisses it, which is what every menu in every app does.
  document.addEventListener('click', () => closeContextMenu());
  // A menu that survived losing focus would point at something that has moved.
  window.addEventListener('blur', () => closeContextMenu());
}
