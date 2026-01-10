# Design Guide

## Art Direction

**Style**: Bubbly, kawaii-inspired, cartoony and playful

### Key Principles
1. **Soft & Rounded** - No sharp edges, everything has curves
2. **Pastel Paradise** - Soft, dreamy colors
3. **Sparkle Everywhere** - Subtle particle effects and shine
4. **Big & Friendly** - Oversized touch targets, welcoming feel

---

## Color Palette

### Primary Colors
| Name | Hex | Usage |
|------|-----|-------|
| Bubblegum | `#FF69B4` | Primary buttons, accents |
| Cotton Candy | `#FFB6C1` | Secondary elements |
| Lavender Dream | `#E6E6FA` | Backgrounds, cards |
| Mint Fresh | `#98FF98` | Success states, accents |
| Peach Glow | `#FFDAB9` | Warm accents |

### Backgrounds
| Name | Value |
|------|-------|
| Main BG | Gradient `#FFE5EC` → `#FFF0F5` |
| Card BG | `#FFFFFF` with 80% opacity |
| Overlay | `#000000` with 30% opacity |

### Text Colors
| Usage | Hex |
|-------|-----|
| Headings | `#9370DB` (Medium Purple) |
| Body | `#8B7B8B` (Soft Gray) |
| On Dark | `#FFFFFF` |

---

## Typography

### Font Family
- **Primary**: "Baloo 2" (Google Fonts) - Bubbly, playful
- **Fallback**: "Nunito", sans-serif

### Font Sizes (Mobile-First)
| Element | Size | Weight |
|---------|------|--------|
| H1 | 2rem | 700 |
| H2 | 1.5rem | 600 |
| Button | 1.25rem | 600 |
| Body | 1rem | 400 |

---

## UI Components

### Buttons
```css
.button {
  min-height: 48px;      /* Touch-friendly */
  min-width: 48px;
  border-radius: 16px;   /* Rounded */
  padding: 12px 24px;
  font-weight: 600;
  box-shadow: 0 4px 0 rgba(0,0,0,0.1);  /* Soft depth */
  transition: transform 0.1s, box-shadow 0.1s;
}

.button:active {
  transform: translateY(2px);
  box-shadow: 0 2px 0 rgba(0,0,0,0.1);
}
```

### Tool Icons
- Size: 48x48px minimum
- Style: Filled with soft shadows
- Active state: Scale up + glow effect

### Cards/Panels
- Border radius: 20px
- Background: Semi-transparent white
- Subtle backdrop blur

---

## Animations

### Micro-interactions
| Action | Animation |
|--------|-----------|
| Button tap | Scale down 0.95 → bounce back |
| Tool select | Pop + sparkle burst |
| Sticker place | Bounce in + "pop" sound |
| Success | Confetti + jingle |

### CSS Keyframes
```css
@keyframes bounce {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.1); }
}

@keyframes sparkle {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}
```

---

## Sound Design

### Categories
| Category | Style |
|----------|-------|
| UI Clicks | Soft, bubbly pops |
| Tools | Satisfying, ASMR-like |
| Success | Cheerful jingles |
| Background | Calm spa/lofi music |

### Sound Guidelines
- All sounds soft and non-jarring
- Volume balanced for kids' ears
- Music should be toggleable
- Filing sound varies with speed (faster = higher pitch)

---

## Responsive Breakpoints

| Device | Width |
|--------|-------|
| Phone | < 480px |
| Tablet (target) | 768px - 1024px |
| Desktop | > 1024px |

**Note**: Primary target is tablet in landscape orientation.
