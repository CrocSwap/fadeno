# Fadeno brand assets

The mark is **the thread** — a single line woven through workflow nodes (Esperanto *fadeno* = "thread"). Icon and wordmark share the same weave geometry, so they lock up cleanly.

Each logo ships as a **pinned light/dark pair** — the ink color is fixed in each file, not chosen by `prefers-color-scheme`. Pick the file that matches the background you're placing it on. (The earlier media-query approach broke in some viewers — e.g. Preview in dark mode drew cream ink on a white card.)

| File | Use |
|---|---|
| `logo-lockup.svg` | **Primary logo**, dark ink — for light/transparent backgrounds. README header, site, slides. |
| `logo-lockup-on-dark.svg` | Primary logo, cream ink — for dark backgrounds. |
| `logo-a-thread-wordmark.svg` / `…-on-dark.svg` | Wordmark only (light / dark). Use when the icon is shown separately nearby. |
| `logo-b-node-glyph.svg` / `…-on-dark.svg` | Icon only (light / dark). Avatars, social profile, GitHub org, sticker. |
| `favicon.svg` | Icon tuned for small sizes (thicker stroke, 3 nodes). Keeps a `prefers-color-scheme` rule — browsers honor it reliably for tab icons. |

**Rule of thumb:** use the plain filename on anything light; use the `-on-dark` filename on anything dark. When in doubt, the plain (dark-ink) version is the safe default.

## Color

- Thread accent: `#C9683C` (amber/rust — literalizes "thread"; not AI-purple, on purpose).
- Ink: `#1A1A1A` (light backgrounds) / `#F5F1EA` (dark backgrounds).

For the repo README on GitHub, use a `<picture>` with `prefers-color-scheme` sources pointing at the two pinned files, or just use the plain dark-ink version (it reads fine on GitHub's light theme, most viewers' default).

## Before shipping as final

These are production-ready in shape but two polish steps make them bulletproof:

1. **Outline the font.** The wordmark uses a system monospace fallback; convert the type to paths so it renders identically everywhere (no dependency on the viewer having JetBrains/Roboto Mono).
2. **Export PNG fallbacks** at 2x for places that don't take SVG (some social cards, OG images): 1200×630 OG image, 512/192 PWA icons, 32/16 favicon PNGs.
