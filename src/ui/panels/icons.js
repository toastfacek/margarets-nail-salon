/**
 * icons.js (WP8)
 * Inline SVG icons for the free-mode panels, drawn in code so they look the
 * same on every platform (no emoji as UI). Sticker emoji stay: they are what
 * lands on the nail.
 */

const svg = (body, box = 32) => `<svg viewBox="0 0 ${box} ${box}" aria-hidden="true">${body}</svg>`;

/** Gem pickers, one per GemTool type id (the gem's own colour and outline). */
export const GEM_ICONS = {
  diamond: svg('<path d="M9 7h14l6 8-13 14L3 15z" fill="#4fd8e8"/><path d="M3 15h26M12 7l-3 8 7 14 7-14-3-8" fill="none" stroke="#fff" stroke-width="1.6" opacity=".85"/>'),
  crystal: svg('<path d="M16 3l11 13-11 13L5 16z" fill="#8fc8ff"/><path d="M16 3v26M5 16h22" stroke="#fff" stroke-width="1.6" opacity=".85"/>'),
  star: svg('<path d="M16 3l4 8.5 9.2 1.2-6.7 6.4 1.7 9.1L16 23.8l-8.2 4.4 1.7-9.1-6.7-6.4 9.2-1.2z" fill="#ffd21f" stroke="#e0a800" stroke-width="1.4" stroke-linejoin="round"/>'),
  flower: svg('<g fill="#ff69b4"><circle cx="16" cy="8.5" r="6"/><circle cx="23.5" cy="14" r="6"/><circle cx="20.5" cy="23" r="6"/><circle cx="11.5" cy="23" r="6"/><circle cx="8.5" cy="14" r="6"/></g><circle cx="16" cy="16.5" r="4.2" fill="#ffd21f"/>'),
  pearl: svg('<circle cx="16" cy="16" r="12" fill="#f4eef6" stroke="#cbbcd6" stroke-width="1.5"/><circle cx="12" cy="11.5" r="3.6" fill="#fff"/>'),
  heart: svg('<path d="M16 28C7 21.5 3 17 3 11.5 3 7.5 6 5 9.5 5c2.8 0 5 1.5 6.5 3.8C17.5 6.5 19.7 5 22.5 5 26 5 29 7.5 29 11.5 29 17 25 21.5 16 28z" fill="#ff69b4"/><path d="M8.5 11c0-2 1.4-3.3 3.2-3.3" stroke="#fff" stroke-width="2.2" stroke-linecap="round" fill="none"/>'),
};

/** Bling categories: a sticker (peel corner) and a gem. */
export const CAT_ICONS = {
  stickers: svg('<path d="M5 5h22v15l-7 7H5z" fill="#fff" stroke="#c77dff" stroke-width="2" stroke-linejoin="round"/><path d="M27 20h-7v7" fill="#ead6ff" stroke="#c77dff" stroke-width="2" stroke-linejoin="round"/><path d="M15 8.5l2 4.2 4.6.6-3.3 3.2.8 4.6-4.1-2.2-4.1 2.2.8-4.6-3.3-3.2 4.6-.6z" fill="#ffd21f"/>'),
  gems: GEM_ICONS.diamond,
};

/** Pen styles, one per BrushTool material id: a sample stroke of each. */
export const PEN_ICONS = {
  solid: svg('<path d="M5 22c4-9 8-9 11-3s7 6 11-3" fill="none" stroke="var(--pc)" stroke-width="3.5" stroke-linecap="round"/>'),
  dotted: svg('<g fill="var(--pc)"><circle cx="6" cy="21" r="2.6"/><circle cx="12" cy="15" r="2.6"/><circle cx="18" cy="17" r="2.6"/><circle cx="24" cy="12" r="2.6"/></g>'),
  metallic: svg('<defs><linearGradient id="pm" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#a8a8b8"/><stop offset="1" stop-color="#5c5c70"/></linearGradient></defs><path d="M5 22c4-9 8-9 11-3s7 6 11-3" fill="none" stroke="url(#pm)" stroke-width="5" stroke-linecap="round"/>'),
  rainbow: svg('<g fill="none" stroke-width="2.6" stroke-linecap="round"><path d="M5 24a11 11 0 0 1 22 0" stroke="#ff4d6d"/><path d="M8.5 24a7.5 7.5 0 0 1 15 0" stroke="#ffd21f"/><path d="M12 24a4 4 0 0 1 8 0" stroke="#4fd8e8"/></g>'),
  glitter: svg('<g fill="var(--pc)"><path d="M11 5l1.6 4.4L17 11l-4.4 1.6L11 17l-1.6-4.4L5 11l4.4-1.6z"/><path d="M22 14l1.1 2.9L26 18l-2.9 1.1L22 22l-1.1-2.9L18 18l2.9-1.1z"/><circle cx="9" cy="24" r="1.8"/><circle cx="25" cy="7" r="1.5"/></g>'),
  marker: svg('<path d="M6 21c5-7 15-7 20 0" fill="none" stroke="var(--pc)" stroke-width="8" stroke-linecap="round" opacity=".55"/>'),
};
