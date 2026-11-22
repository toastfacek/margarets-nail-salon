/**
 * DrawPanel.js (WP8)
 * Free-mode pen: six pen styles (a sample stroke each, in the pen colour),
 * the pen colours and three sizes (dots). Built once; no text.
 */
import { PEN_MATERIALS, PEN_COLORS } from '../../tools/BrushTool.js';
import { PEN_ICONS } from './icons.js';
import { pop } from './PolishPanel.js';

const SIZES = [3, 7, 14];

export class DrawPanel {
  constructor(app) {
    this.app = app;
    const el = (this.el = document.createElement('div'));
    el.className = 'opt opt-draw';
    el.innerHTML = `<div class="grp grp-pen">${Object.values(PEN_MATERIALS).map((m) => `<button class="opt-btn pen" data-pen="${m.id}" aria-label="${m.id}">${PEN_ICONS[m.id] || ''}</button>`).join('')}</div>`
      + `<div class="grp grp-size">${SIZES.map((s) => `<button class="opt-btn size" data-size="${s}" aria-label="${s}"><i style="--s:${s * 2 + 4}px"></i></button>`).join('')}</div>`
      + `<div class="grp grp-col">${PEN_COLORS.map((c) => `<button class="swatch" data-color="${c.color}" style="--c:${c.color}" aria-label="${c.id}"></button>`).join('')}</div>`;
    this.buttons = Array.from(el.querySelectorAll('button'));

    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      const pen = app.brushTool;
      if (!b || !pen) return;
      const d = b.dataset;
      if (d.pen) pen.setMaterial(d.pen);
      else if (d.size) pen.setSize(+d.size);
      else if (d.color) pen.setColor(d.color);
      app.sound.uiTap(this.buttons.indexOf(b) % 8);
      pop(b);
      this.sync();
    });
  }

  sync() {
    const pen = this.app.brushTool;
    if (!pen) return;
    const color = pen.getColor();
    this.el.style.setProperty('--pc', color);
    // nearest size dot for sizes set elsewhere
    const size = pen.getSize();
    const near = SIZES.reduce((a, b) => (Math.abs(b - size) < Math.abs(a - size) ? b : a));
    for (const b of this.buttons) {
      const d = b.dataset;
      b.classList.toggle('active', d.pen ? d.pen === pen.getMaterial() : d.size ? +d.size === near : d.color === color);
    }
  }
}
