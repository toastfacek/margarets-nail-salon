/**
 * StarMeter.js (WP6)
 * Three star outlines next to the request bubble that fill live with the
 * average coverage of the requested nails, so progress is always visible.
 * The thresholds match Scoring: star 1 by 30%, star 2 by 60%, star 3 by 85%.
 * Written only when the value changes (coverage events), never per frame.
 */
const STAR = '<svg viewBox="0 0 24 24"><path d="M12 2.5l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.2l-5.9 3.2 1.3-6.5L2.5 9.3l6.6-.8z"/></svg>';
const STEPS = [0, 0.3, 0.6, 0.85];

export class StarMeter {
  constructor(parent = document.body) {
    const el = document.createElement('div');
    el.className = 'g-stars';
    el.innerHTML = `<span>${STAR}${STAR}</span>`.repeat(3);
    parent.appendChild(el);
    this.el = el;
    this.stars = Array.from(el.children);
    this.last = -1;
  }

  /** @param {number} avg 0..1 */
  set(avg) {
    const v = Math.round(avg * 50) / 50;
    if (v === this.last) return;
    this.last = v;
    for (let i = 0; i < 3; i++) {
      const f = Math.max(0, Math.min(1, (v - STEPS[i]) / (STEPS[i + 1] - STEPS[i])));
      this.stars[i].style.setProperty('--f', f.toFixed(2));
    }
  }

  reset() {
    this.last = -1;
    this.set(0);
  }

  show(on) {
    this.el.classList.toggle('on', on);
  }
}
