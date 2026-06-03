# IELTSY Design System: Exam Desk

> Source of truth for GitHub Pages and future IELTSY web surfaces.
> Page-specific files in `design-system/ieltsy/pages/` may override this file.

## Pattern

**Pattern name:** Exam Desk

IELTSY is an adult IELTS study cockpit. It should look like a compact exam desk: navigation rail, study surface, command dock, reading paper, and notes tray. This is not a landing page and not a generic card list.

The page anatomy is fixed:

1. **Desk Rail**: persistent app navigation. Desktop uses a left rail; mobile uses a bottom rail.
2. **Desk Surface**: the page canvas with strong grid alignment and visible sections.
3. **Study Dock**: compact command controls, visually separate from content.
4. **Reading Paper**: the article surface, optimized for long reading.
5. **Notes Tray**: vocabulary, grammar, and mistakes panels.

## Visual Language

- Use a deliberate “desk” composition: left rail, large work surface, and side tray.
- Use matte paper colors and high contrast ink.
- Use one strong accent only for progress/action; use amber only for target words.
- Use visible dividers, rails, and tracks. Avoid floating generic cards.
- Use dense but calm layouts. The first viewport should show useful study content, not marketing copy.
- No gradients, blobs, glass, hero illustration, or app-store landing sections.

## Tokens

### Color

| Token | Value | Usage |
|---|---:|---|
| `--desk` | `#EDEFE8` | Whole app background |
| `--surface` | `#F8F7F1` | Main desk surface |
| `--paper` | `#FFFDF7` | Reading paper and notes |
| `--ink` | `#111318` | Primary text |
| `--ink-2` | `#3F4652` | Secondary text |
| `--ink-3` | `#767D86` | Muted text |
| `--line` | `#D4D8CE` | Standard dividers |
| `--line-2` | `#9FA79C` | Strong dividers |
| `--accent` | `#0F766E` | Primary action |
| `--accent-2` | `#0B4F4A` | Accent text |
| `--study` | `#4338CA` | Sentence/learning markers |
| `--target` | `#A45C00` | Target word text |
| `--target-bg` | `#FFE8A3` | Target word highlight |
| `--done` | `#157F3B` | Completed state |

### Typography

- **UI:** Inter/system sans.
- **Reading:** Georgia / Times serif.
- **Data rails:** SF Mono / Consolas.
- Title text is large only in page covers. Panels use compact headings.
- Letter spacing is `0`; uppercase micro labels may use `0.08em`.

### Layout

- Desktop shell: `72px` left rail + flexible desk surface.
- Desktop study page: `76px` command dock + article column + `340px` notes tray.
- Mobile shell: bottom rail, page padding bottom at least `88px`.
- Minimum touch target: `44px`.
- Radius max: `8px`.
- Use borders instead of shadows for structure.

## Components

### Desk Rail

- Desktop: fixed-width vertical rail with brand mark, two nav buttons, and repository/status slot.
- Mobile: fixed bottom rail with icon + label nav items.
- Active state uses filled paper background and accent border.

### Today Panel

- Home page starts with a large latest-lesson panel.
- It contains date, title, metadata, and primary continue action.
- Timeline and metrics sit next to or below it as separate desk sections.

### Timeline Row

- Date rail at left, lesson title in the middle, compact metadata at right.
- Hover changes background/border only.
- Use a right arrow icon, not text arrows.

### Study Dock

- A vertical stack on desktop; horizontal wrap on mobile.
- Contains play all, translation, practice, done.
- Active state must be obvious through border and background.

### Reading Paper

- Article appears on a paper-like surface with a left sentence gutter.
- Every sentence row has a 44px play button, circled number, English text, and optional Chinese text.
- Practice mode hides target words without changing line height.

### Notes Tray

- Vocabulary and grammar are direct panels in a side tray.
- Vocabulary rows show word, POS, and sentence refs.
- Grammar examples use compact code styling.

## Page Templates

### Home

Use:

- `desk-home`
- `today-panel`
- `metric-strip`
- `timeline-list`

Do not use hero/marketing components.

### Lesson

Use:

- `lesson-cover`
- `lesson-workbench`
- `study-dock`
- `reading-paper`
- `notes-tray`

Reader must appear before notes in DOM order on mobile.

### Mistakes

Use:

- `desk-page`
- `lesson-cover`
- `timeline-list`
- `markdown-paper`

## Accessibility And Interaction

- All interactive elements use SVG icons and visible text or `aria-label`.
- Use `:focus-visible` with 2px accent outline.
- Respect `prefers-reduced-motion`.
- Do not rely on color alone for active states.
- Mobile touch targets are at least 44px with 8px gaps.

## Anti-Patterns

- No generic top navbar.
- No centered marketing hero.
- No nested cards.
- No emoji icons.
- No gradient/orb/blob decoration.
- No hover transforms that shift layout.
- No low-contrast gray text.
- No all-purple, all-teal, dark slate, or beige-only UI.

## Verification

- `pnpm exec tsc --noEmit`
- `pnpm pages:build`
- Generated pages contain `desk-rail`, `today-panel`, `lesson-workbench`, `study-dock`, `reading-paper`, and `notes-tray`.
- Local HTTP checks return 200 for `/`, `/days/YYYY-MM-DD/`, and `/mistakes/`.
