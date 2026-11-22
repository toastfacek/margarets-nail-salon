/**
 * PolishPanel.js (WP8)
 * Free-mode polish options: a paint-bucket fill with a coverage bar, four
 * finish swatches (mini nails in the current colour: gloss streak, flat,
 * glitter dots, chrome) and the colour swatches. Built once; taps only toggle
 * classes. No text.
 */
import { PALETTE } from '../../game/ClientRequests.js';

// The round-mode bottles first, then eight more.
export const POLISH_COLORS = [
  ...PALETTE,
  '#ff6b6b', '#ff1493', '#c77dff', '#7b68ee', '#48cae4', '#55efc4', '#ffffff', '#000000',
];
const FINISHES = ['glossy', 'matte', 'shimmer', 'chrome'];
const BUCKET = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 13l10-8 10 8-10 13z" fill="#fff" stroke="#5a2a82" stroke-width="2.2" stroke-linejoin="round"/>'
  + '<path d="M6 13h20l-10 13z" fill="var(--c)"/><path d="M26 14c2 3 3 5 3 7a3 3 0 0 1-6 0c0-2 1-4 3-7z" fill="var(--c)"/></svg>';

export class PolishPanel {
  /** @param {object} app the NailArtistApp */
  constructor(app) {
    this.app = app;
    const el = (this.el = document.createElement('div'));
    el.className = 'opt opt-polish';
    el.innerHTML = `<div class="grp grp-act"><button class="opt-btn fill-btn" aria-label="fill">${BUCKET}</button>`
      + '<span class="cov"><i></i></span></div>'
      + `<div class="grp grp-fin">${FINISHES.map((f) => `<button class="opt-btn fin" data-finish="${f}" aria-label="${f}"><i></i></button>`).join('')}</div>`
      + `<div class="grp grp-col">${POLISH_COLORS.map((c) => `<button class="swatch" data-color="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}</div>`;
    this.bar = el.querySelector('.cov i');
    this.swatches = Array.from(el.querySelectorAll('.swatch'));
    this.fins = Array.from(el.querySelectorAll('.fin'));
    this.lastPct = -1;

    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const brush = app.polishBrush3D;
      if (b.dataset.color) {
        app.selectedColor = b.dataset.color;
        brush?.setColor(b.dataset.color);
        app.sound.uiTap(this.swatches.indexOf(b) % 8);
        pop(b);
      } else if (b.dataset.finish) {
        brush?.setFinish(b.dataset.finish);
        app.sound.uiTap(4);
        pop(b);
      } else if (b.classList.contains('fill-btn')) {
        brush?.fillNail();
        app.sound.uiTap(6);
        pop(b);
      }
      this.sync();
    });
  }

  /** Reflect the brush's colour and finish (they can change in round mode). */
  sync() {
    const brush = this.app.polishBrush3D;
    if (!brush) return;
    const c = String(brush.color).toLowerCase();
    this.el.style.setProperty('--c', c);
    for (const s of this.swatches) s.classList.toggle('active', s.dataset.color === c);
    for (const f of this.fins) f.classList.toggle('active', f.dataset.finish === brush.finish);
  }

  /** @param {number} pct 0..100 */
  setCoverage(pct) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (p === this.lastPct) return;
    this.lastPct = p;
    this.bar.style.transform = `scaleX(${p / 100})`;
  }
}

/** Restart a one-shot pop animation on a button. */
export function pop(b) {
  b.classList.remove('ui-pop');
  void b.offsetWidth;
  b.classList.add('ui-pop');
}
