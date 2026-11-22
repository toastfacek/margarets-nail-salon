/**
 * PolaroidWall.js (WP7)
 * The salon's photo wall: every reveal pins a polaroid of the hand here.
 *
 * - Kept on the device only, through app.storage, under one key:
 *   { v: 1, items: [{ t, stars, img }] }, oldest first, at most 20 (the 21st
 *   evicts the oldest). On a quota failure the oldest is dropped and the write
 *   retried once, then it gives up silently. With storage blocked the wall
 *   still shows this session's photos (kept in memory).
 * - Reached by the polaroid stack under the door (top right): no text. The
 *   wall is a cork board with taped polaroids at small tilts, newest first;
 *   tap one to see it big. Empty: a dotted polaroid with a camera.
 * - Takes over `ui:gallery` (the free-mode gallery button).
 * No share, no download, no links.
 */
const KEY = 'polaroids';
const MAX = 20;
const IMG_OK = /^data:image\/(webp|jpeg|png);base64,[A-Za-z0-9+/=]+$/;

export const STAR = '<svg viewBox="0 0 24 24"><path d="M12 1.8l3.1 6.4 7 .9-5.1 4.9 1.3 7L12 17.6 5.7 21l1.3-7L1.9 9.1l7-.9z"/></svg>';
const HEART = '<svg class="pw-h" viewBox="0 0 24 24"><path d="M12 21C5 16 2 12.5 2 8.5 2 5.5 4.3 3.5 7 3.5c2 0 3.8 1.1 5 2.9 1.2-1.8 3-2.9 5-2.9 2.7 0 5 2 5 5 0 4-3 7.5-10 12.5z"/></svg>';
const CAM = '<svg class="pw-cam" viewBox="0 0 48 48"><rect x="5" y="13" width="38" height="27" rx="6" fill="#c77dff"/><rect x="16" y="8" width="16" height="8" rx="3" fill="#9d4edd"/><circle cx="24" cy="27" r="9" fill="#fff"/><circle cx="24" cy="27" r="5.5" fill="#5a2a82"/><circle cx="36" cy="19" r="2.2" fill="#ffd21f"/></svg>';
const X = '<svg viewBox="0 0 32 32"><path d="M9 9l14 14M23 9L9 23" stroke="#5a2a82" stroke-width="4.5" stroke-linecap="round"/></svg>';

function card(it, cls = '') {
  const r = ((it.t % 11) - 5) * 0.9;
  return `<figure class="pw-p ${cls}" style="--r:${r.toFixed(1)}deg"><img${it.img ? ` src="${it.img}"` : ''} alt=""><figcaption>${STAR.repeat(it.stars)}${HEART}</figcaption></figure>`;
}

function valid(it) {
  return it && typeof it.img === 'string' && IMG_OK.test(it.img) && it.stars >= 1 && it.stars <= 3 && typeof it.t === 'number';
}

export class PolaroidWall {
  constructor(storage, sound) {
    this.storage = storage;
    this.sound = sound;
    this.items = null;

    const el = (cls, html, tag = 'div') => {
      const e = document.createElement(tag);
      e.className = cls;
      e.innerHTML = html;
      document.body.appendChild(e);
      return e;
    };
    this.stack = el('pw-stack', `<i></i><i>${CAM}<img alt=""></i>`, 'button');
    this.stack.title = 'Photos';
    this.wall = el('pw-wall', `<button class="pw-x" title="Close">${X}</button><div class="pw-grid"></div>`);
    this.grid = this.wall.lastChild;
    this.zoom = el('pw-zoom', '');

    this.stack.addEventListener('click', () => this.open());
    this.wall.addEventListener('click', (e) => {
      const f = e.target.closest('.pw-p');
      if (f && f.dataset.i !== undefined) {
        this.zoom.innerHTML = card(this.items[+f.dataset.i]);
        this.zoom.classList.add('on');
        this._tap(5);
      } else if (e.target === this.wall || e.target.closest('.pw-x')) {
        this.close();
      }
    });
    this.zoom.addEventListener('click', () => {
      this.zoom.classList.remove('on');
      this._tap(2);
    });
  }

  _tap(i) {
    try { this.sound.uiTap(i); } catch (err) { /* sound is optional */ }
  }

  /** Read the stored photos once (lazily: the first wall, photo or idle moment). */
  load() {
    if (this.items) return this.items;
    const d = this.storage.get(KEY, null);
    this.items = d && d.v === 1 && Array.isArray(d.items) ? d.items.filter(valid).slice(-MAX) : [];
    this._paintStack();
    return this.items;
  }

  _paintStack() {
    const last = this.items[this.items.length - 1];
    const img = this.stack.querySelector('img');
    if (last) img.src = last.img;
    this.stack.classList.toggle('full', !!last);
  }

  /** Pin a photo (data URL) with its star count, and persist. */
  add(img, stars) {
    const it = { t: Date.now(), stars: Math.max(1, Math.min(3, stars | 0)), img };
    if (!valid(it)) return;
    this.load().push(it);
    while (this.items.length > MAX) this.items.shift();
    this._paintStack();
    if (!this.storage.set(KEY, { v: 1, items: this.items }) && this.storage.available && this.items.length > 1) {
      this.items.shift(); // quota: drop the oldest, retry once
      this.storage.set(KEY, { v: 1, items: this.items });
    }
  }

  open() {
    const items = this.load();
    let html = '';
    for (let i = items.length - 1; i >= 0; i--) html += card(items[i]).replace('<figure', `<figure data-i="${i}"`);
    this.grid.innerHTML = html || `<figure class="pw-p pw-empty">${CAM}</figure>`;
    this.wall.classList.add('on');
    this._tap(6);
  }

  close() {
    this.wall.classList.remove('on');
    this.zoom.classList.remove('on');
    this._tap(1);
  }

  get isOpen() {
    return this.wall.classList.contains('on');
  }

  /**
   * The reveal's polaroid. It pops up only once its photo lands (setPhoto),
   * then develops; drop() flies it onto the stack. A photo that lands after
   * the drop is pinned straight away.
   */
  present(stars) {
    this.dropNow();
    this.fly = { stars, img: '', el: null, dropped: false };
  }

  /** The presented polaroid's photo (a data URL; '' if it failed). */
  setPhoto(img) {
    const f = this.fly;
    if (!f) return;
    if (!img) {
      this.fly = null;
      return;
    }
    f.img = img;
    if (f.dropped) {
      this.dropNow();
      return;
    }
    const el = (f.el = document.createElement('div'));
    el.className = 'pw-fly';
    el.innerHTML = card({ t: 0, stars: f.stars, img });
    document.body.appendChild(el);
    void el.offsetWidth; // start the transitions from the hidden state
    el.classList.add('in');
  }

  /** Fly the presented polaroid onto the stack, then pin it. */
  drop() {
    const f = this.fly;
    if (!f) return;
    f.dropped = true;
    if (!f.el) return; // pinned when the photo lands
    const a = f.el.firstChild.getBoundingClientRect();
    const b = this.stack.getBoundingClientRect();
    f.el.style.setProperty('--dx', `${b.left + b.width / 2 - (a.left + a.width / 2)}px`);
    f.el.style.setProperty('--dy', `${b.top + b.height / 2 - (a.top + a.height / 2)}px`);
    f.el.style.setProperty('--s', (b.width / Math.max(1, a.width)).toFixed(3));
    f.el.classList.add('out');
    this._dropT = setTimeout(() => this.dropNow(), 520);
  }

  /** Finish the flight at once and pin the photo (or wait for it to land). */
  dropNow() {
    const f = this.fly;
    if (!f) return;
    clearTimeout(this._dropT);
    if (f.el) f.el.remove();
    f.el = null;
    if (!f.img) {
      f.dropped = true;
      return;
    }
    this.fly = null;
    this.add(f.img, f.stars);
    this.stack.classList.remove('bump');
    void this.stack.offsetWidth;
    this.stack.classList.add('bump');
  }
}
