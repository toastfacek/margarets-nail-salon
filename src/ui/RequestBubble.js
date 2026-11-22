/**
 * RequestBubble.js (WP6)
 * The client's thought bubble: a picture of what they want (a fingertip in
 * their skin tone with the nail in the requested colour and finish, drawn in
 * CSS, plus the sticker if any) and one small nail pip per requested nail
 * that fills as that nail reaches 90%. No text. pointer-events: none.
 */
import { STICKERS } from '../tools/StickerTool.js';

export class RequestBubble {
  constructor(parent = document.body) {
    const el = document.createElement('div');
    el.className = 'g-bubble';
    el.innerHTML = '<div class="g-tip"><i class="g-nail"></i><s></s></div><div class="g-pips"></div>';
    parent.appendChild(el);
    this.el = el;
    this.tip = el.firstChild;
    this.pips = el.lastChild;
    this.fingers = [];
  }

  show(req) {
    this.fingers = req.fingers;
    this.pips.innerHTML = '<b></b>'.repeat(req.fingers.length);
    const st = this.el.style;
    st.setProperty('--c', req.color);
    st.setProperty('--skin', req.skinTone);
    this.el.dataset.f = req.finish;
    const sk = req.sticker && STICKERS.find((x) => x.id === req.sticker);
    this.tip.lastChild.textContent = sk ? sk.emoji : '';
    // restart the pop-in
    this.el.classList.remove('on');
    void this.el.offsetWidth;
    this.el.classList.add('on');
  }

  hide() {
    this.el.classList.remove('on');
  }

  /** Mark nail `finger` done (>= 90%) or not; `active`: it is being painted. */
  setPip(finger, done, active) {
    const b = this.pips.children[this.fingers.indexOf(finger)];
    if (!b) return;
    b.classList.toggle('done', done);
    if (active) for (const c of this.pips.children) c.classList.toggle('act', c === b);
  }
}
