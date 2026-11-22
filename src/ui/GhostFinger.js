/**
 * GhostFinger.js (WP6)
 * A cartoon pointing hand (inline SVG, drawn in code) that shows what to do
 * with no words: drag along the nail, tap the Done heart, press and hold the
 * dryer. It lives in a pointer-events:none layer and only ever animates
 * `transform` / `opacity` (compositor-only CSS animation, 1.6 s loop).
 *
 * Positions are set once per loop: `onLoop` fires at every loop start so the
 * owner can re-project the nail to the screen (correct in every layout).
 */

const HAND = '<svg viewBox="0 0 60 80" aria-hidden="true"><g fill="#fff" stroke="#5a2a82" stroke-width="3.5" stroke-linejoin="round">'
  + '<path d="M15 3c-4.4 0-7.5 3.2-7.5 7.5V44l-2.6-3.1c-2.6-3-7-2.9-8.7.4-1 2-.6 4.5.9 6.2L10 62c4 5 9 13 21 13h4c12 0 19-8 19-20V39c0-3.6-2.8-6.3-6.3-6.3-1.5 0-2.8.5-3.8 1.3-.6-3-3.2-5-6.2-5-1.8 0-3.4.7-4.5 1.9-1-2.5-3.4-4.2-6.2-4.2-1.2 0-2.3.3-3.3.8V10.5C22.5 6.2 19.4 3 15 3z"/>'
  + '<path d="M28.5 30v11M38 34v8" fill="none"/></g></svg>';

export class GhostFinger {
  constructor(parent = document.body) {
    const el = document.createElement('div');
    el.className = 'g-ghost';
    el.innerHTML = `<div class="g-ghost-in"><i></i>${HAND}</div>`;
    parent.appendChild(el);
    this.el = el;
    this.kind = null;
    this.onLoop = null;
    el.firstChild.addEventListener('animationiteration', () => this.onLoop && this.onLoop(this.kind));
  }

  get shown() {
    return this.kind !== null;
  }

  /**
   * Show (or retarget) the hint.
   * @param {'drag'|'tap'|'hold'} kind
   * @param {number} x0 fingertip start, CSS px
   * @param {number} y0
   * @param {number} [x1] drag end (drag only)
   * @param {number} [y1]
   */
  show(kind, x0, y0, x1 = x0, y1 = y0) {
    const st = this.el.style;
    st.transform = `translate(${x0 | 0}px,${y0 | 0}px)`;
    st.setProperty('--dx', `${(x1 - x0) | 0}px`);
    st.setProperty('--dy', `${(y1 - y0) | 0}px`);
    if (kind !== this.kind) {
      this.kind = kind;
      this.el.className = `g-ghost on k-${kind}`;
    }
  }

  hide() {
    if (this.kind === null) return;
    this.kind = null;
    this.el.className = 'g-ghost';
  }
}
