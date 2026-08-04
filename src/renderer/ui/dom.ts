/**
 * Tiny DOM helpers.
 *
 * The renderer builds its few dynamic nodes with `textContent` and explicit element
 * creation rather than `innerHTML`. Draft text and CLI output are arbitrary strings, and
 * assigning them as HTML would turn a pasted prompt into script injection.
 */

/** Fetches a required element, failing loudly rather than degrading silently. */
export function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`Missing element #${id}`);
  }
  return element as T;
}

/** Creates an element with optional class and text. */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: { className?: string; text?: string; title?: string } = {},
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className !== undefined) {
    element.className = options.className;
  }
  if (options.text !== undefined) {
    element.textContent = options.text;
  }
  if (options.title !== undefined) {
    element.title = options.title;
  }
  return element;
}

/**
 * Builds an inline icon from a single path.
 *
 * SVG needs `createElementNS`: an `<svg>` created with `createElement` lands in the HTML namespace
 * and renders as nothing at all, silently.
 */
export function createIcon(
  path: string,
  options: { paint?: 'fill' | 'stroke'; viewBox?: string } = {},
): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', options.viewBox ?? '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');

  const shape = document.createElementNS(ns, 'path');
  shape.setAttribute('d', path);
  if (options.paint === 'stroke') {
    shape.setAttribute('fill', 'none');
    shape.setAttribute('stroke', 'currentColor');
    shape.setAttribute('stroke-width', '1.6');
    shape.setAttribute('stroke-linecap', 'round');
    shape.setAttribute('stroke-linejoin', 'round');
  } else {
    shape.setAttribute('fill', 'currentColor');
  }
  svg.append(shape);
  return svg;
}

/** Removes every child of a node. */
export function clearChildren(element: HTMLElement): void {
  element.replaceChildren();
}
