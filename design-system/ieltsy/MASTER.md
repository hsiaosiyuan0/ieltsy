# IELTSY Design System: Study Ledger

> Source of truth for GitHub Pages and future IELTSY web surfaces.
> Page-specific files in `design-system/ieltsy/pages/` may override this file.

## Design Pattern

**Pattern name:** Study Ledger

IELTSY is an adult exam-prep study archive, not a marketing site. The interface should feel like a calm paper ledger with precise tool controls: readable, dense enough for repeated study, and quiet on mobile.

Use three layers consistently:

1. **Ledger Shell**: sticky compact header, restrained brand mark, page navigation.
2. **Lesson Cover**: date, title, metadata, and primary continuation action.
3. **Study Surface**: reading column plus companion panels for vocabulary, grammar, and mistakes.

## Visual Principles

- Reading comes first. Keep the article column visually dominant.
- Use panels for tools and repeated records only; do not put cards inside cards.
- Use strong contrast and matte surfaces. Avoid glass, gradients, decorative blobs, and marketing hero layouts.
- Keep controls compact and predictable. Minimum touch target: 44px.
- Use SVG icons for repeated tool commands; no emoji icons.
- Motion is functional only: color, border, or opacity transitions between 120ms and 180ms.

## Tokens

### Color

| Token | Value | Usage |
|---|---:|---|
| `--canvas` | `#F7F8F5` | App background |
| `--paper` | `#FFFFFF` | Main reading/panel surface |
| `--paper-quiet` | `#F1F4EF` | Subtle selected state |
| `--ink` | `#171A1F` | Primary text |
| `--ink-soft` | `#4E5661` | Secondary text |
| `--ink-faint` | `#77808B` | Metadata |
| `--rule` | `#D8DED6` | Borders and dividers |
| `--rule-strong` | `#AEB8AE` | Active borders |
| `--accent` | `#0F766E` | Primary action and focus |
| `--accent-ink` | `#0B4F4A` | Accent text |
| `--study` | `#4F46E5` | Sentence numbers and learning markers |
| `--review` | `#B45309` | Target words |
| `--review-bg` | `#FFF2CC` | Target highlight |
| `--success` | `#15803D` | Completion state |

### Typography

- **UI font:** `Inter`, `ui-sans-serif`, `system-ui`, `-apple-system`, `BlinkMacSystemFont`, `"Segoe UI"`, `sans-serif`
- **Reading font:** `Georgia`, `"Times New Roman"`, `serif`
- **Mono font:** `"SFMono-Regular"`, `Consolas`, `"Liberation Mono"`, monospace

Scale:

| Token | Value | Usage |
|---|---:|---|
| `--text-xs` | `0.78rem` | Micro metadata |
| `--text-sm` | `0.9rem` | Labels, secondary UI |
| `--text-md` | `1rem` | Body UI |
| `--text-lg` | `1.125rem` | Panel headings |
| `--text-read` | `1.18rem` | English reading text |
| `--text-title` | `clamp(2rem, 5vw, 4.4rem)` | Page/lesson titles |

Rules:

- Letter spacing is `0` except small uppercase labels may use `0.08em`.
- Do not scale fonts directly with viewport width outside the title token.
- Reading line length should stay between 58 and 74 characters on desktop.

### Shape And Spacing

- Radius: `8px` max for panels and buttons.
- Grid gap: `16px` desktop, `12px` mobile.
- Page width: `min(1180px, calc(100% - 32px))`.
- Reader width: prioritize `minmax(0, 1fr)` with a companion column capped at `360px`.
- Sticky bars must have visible borders and not obscure content.

## Components

### Ledger Shell

- Sticky top header with brand at left and two navigation items at right.
- Header background uses `--canvas` with a solid border; no floating blur-heavy nav.
- Active nav item uses `--paper-quiet`, `--accent-ink`, and a clear border.

### Command Button

- Minimum height `44px`.
- Border: `1px solid var(--rule)`.
- Active: `var(--paper-quiet)` background, `var(--accent)` border.
- Focus: `2px solid var(--accent)` outline plus 2px offset.
- Icons use one consistent 24px SVG style.

### Lesson Row

- Repeated item card with date rail, title, and compact metadata.
- Hover changes border/background only; no transform that shifts layout.
- Entire row is clickable and has `cursor: pointer`.

### Reader Sentence

- Three fixed zones on desktop: play button, circled number, text.
- Mobile collapses to play button plus content.
- Sentence play is an icon button with an accessible label.
- Target words use `--review-bg`; in practice mode the word is hidden but occupies the same inline space.

### Study Panels

- Panels are direct children of page layout, never nested cards.
- Vocabulary list uses compact rows with word, POS, and sentence refs.
- Grammar notes use code styling with high contrast and no decorative background.

## Page Templates

### Home

- Use `home-ledger`: title, latest action, summary metrics, chronological lesson list.
- The first viewport should immediately show the latest lesson and list start.
- Do not use a marketing hero, feature explanation, screenshot carousel, testimonials, ratings, or app-store CTAs.

### Lesson

- Use `lesson-cover`, `command-bar`, and `lesson-grid`.
- The command bar contains: play all, translation toggle, practice toggle, done marker.
- The reader must appear before vocabulary panels in DOM order.

### Mistakes

- Use the same `lesson-cover` and `ledger-list` patterns.
- Markdown content uses the same panel style as the reader.

## Interaction Rules

- Respect `prefers-reduced-motion: reduce`.
- Every clickable element needs a visible hover/focus state.
- Keyboard users must be able to reveal and speak target words with Enter or Space.
- Local-only completion state must be visually clear but not described as synced.
- Browser speech is optional: if unsupported, controls remain stable.

## Anti-Patterns

- No emoji icons.
- No one-note purple, beige, dark slate, or orange-heavy palette.
- No gradient orb or decorative blob backgrounds.
- No nested cards.
- No hero-scale text inside compact panels.
- No hidden focus outlines.
- No layout-shifting hover transforms.
- No text that explains the UI mechanics on screen.

## Pre-Delivery Checklist

- `pnpm exec tsc --noEmit` passes.
- `pnpm pages:build` passes.
- Generated `dist/index.html` and at least one `dist/days/YYYY-MM-DD/index.html` contain the Study Ledger classes.
- Responsive breakpoints checked for 375px, 768px, 1024px, and 1440px by CSS inspection or browser QA.
- Focus states, reduced motion, and 44px touch targets are present in CSS.
