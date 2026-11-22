/**
 * BlingPanel.js (WP8)
 * Free-mode decorations: a sticker / gem toggle and one grid per kind (sticker
 * emoji, code-drawn gem icons). The last pick stays selected, so a tap on the
 * nail always places something. Built once; no text.
 */
import { STICKERS } from '../../tools/StickerTool.js';
import { GEM_TYPES } from '../../tools/GemTool.js';
import { CAT_ICONS, GEM_ICONS } from './icons.js';
import { pop } from './PolishPanel.js';

export class BlingPanel {
  constructor(app) {
    this.app = app;
    this.cat = 'stickers';
    this.pick = { stickers: STICKERS[0].id, gems: GEM_TYPES[0].id };
    const el = (this.el = document.createElement('div'));
    el.className = 'opt opt-bling';
    el.innerHTML = `<div class="grp grp-cat">${['stickers', 'gems'].map((c) => `<button class="opt-btn cat" data-cat="${c}" aria-label="${c}">${CAT_ICONS[c]}</button>`).join('')}</div>`
      + `<div class="grp grp-items" data-for="stickers">${STICKERS.map((s) => `<button class="opt-btn item emoji" data-id="${s.id}">${s.emoji}</button>`).join('')}</div>`
      + `<div class="grp grp-items" data-for="gems">${GEM_TYPES.map((g) => `<button class="opt-btn item" data-id="${g.id}" aria-label="${g.id}">${GEM_ICONS[g.id] || GEM_ICONS.diamond}</button>`).join('')}</div>`;
    this.cats = Array.from(el.querySelectorAll('.cat'));
    this.grids = Array.from(el.querySelectorAll('.grp-items'));

    el.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.cat) {
        this.cat = b.dataset.cat;
        app.sound.uiTap(b.dataset.cat === 'gems' ? 6 : 5);
      } else {
        this.pick[this.cat] = b.dataset.id;
        pop(b);
      }
      this.sync();
    });
  }

  /** Apply the current category and pick to the tools, and mark them. */
  sync() {
    const { app, cat } = this;
    const id = this.pick[cat];
    if (cat === 'stickers') {
      app.gemTool?.selectGem(null);
      app.stickerTool?.selectSticker(id);
    } else {
      app.stickerTool?.selectSticker(null);
      app.gemTool?.selectGem(id);
    }
    for (const c of this.cats) c.classList.toggle('active', c.dataset.cat === cat);
    for (const g of this.grids) {
      g.hidden = g.dataset.for !== cat;
      for (const b of g.children) b.classList.toggle('active', b.dataset.id === id);
    }
  }
}
