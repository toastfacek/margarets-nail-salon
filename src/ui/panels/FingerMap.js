/**
 * FingerMap.js (WP8)
 * Free-mode finger picker: a little hand drawn from five fingertip buttons
 * (staggered like real fingers, the nail on top) plus a swap-hands button.
 * In the order the fingers sit on screen: the close-up has the back of the
 * hand with the nails pointing down, so the left hand's thumb is on the
 * left; the right hand mirrors it. No text.
 */

// left hand, left to right (CSS reverses the row for the right hand)
const ORDER = ['thumb', 'index', 'middle', 'ring', 'pinky'];
const SWAP = '<svg viewBox="0 0 32 32" aria-hidden="true">'
  + '<path d="M9 27c-3 0-5-2-5-5V12a2 2 0 0 1 4 0V8a2 2 0 0 1 4 0v12" fill="#f2c9ad" stroke="#5a2a82" stroke-width="1.8" stroke-linejoin="round"/>'
  + '<path d="M23 27c3 0 5-2 5-5V12a2 2 0 0 0-4 0V8a2 2 0 0 0-4 0v12" fill="#f2c9ad" stroke="#5a2a82" stroke-width="1.8" stroke-linejoin="round"/>'
  + '<path d="M12 5.5h8m-2-2.5 2.5 2.5L18 8" fill="none" stroke="#ff2a6d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export class FingerMap {
  /**
   * @param {object} app the NailArtistApp
   * @param {HTMLElement} root `#finger-selector`
   */
  constructor(app, root) {
    this.app = app;
    this.root = root;
    root.innerHTML = `<button class="hand-toggle" id="hand-toggle" aria-label="swap hands">${SWAP}</button>`
      + `<div class="finger-buttons">${ORDER.map((f) => `<button class="finger-btn f-${f}" data-finger="${f}" aria-label="${f}"><i></i></button>`).join('')}</div>`;
    this.fingers = Array.from(root.querySelectorAll('.finger-btn'));

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.finger) {
        app.switchToFinger(b.dataset.finger);
        app.sound.playClick();
      } else {
        app.switchHand(app.nail.getCurrentHand() === 'left' ? 'right' : 'left');
      }
    });
  }

  sync() {
    const hm = this.app.nail;
    const finger = hm.getActiveNail();
    this.root.classList.toggle('right', hm.getCurrentHand() === 'right');
    for (const b of this.fingers) b.classList.toggle('active', b.dataset.finger === finger);
  }
}
