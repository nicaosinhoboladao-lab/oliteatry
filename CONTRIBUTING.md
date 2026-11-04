# Contributing to OLiteatry

Short version: keep `src/core` engine-free, keep `npm test` green, and don't break a saved project.

## Setup

```bash
npm install
npm start          # app
npm test           # core unit tests (fast, no GPU needed)
npm run selftest   # launches, screenshots to dist-selftest/, prints JSON diagnostics
npm run dist       # Windows portable build
```

Node 20+. WebGL2 is required for the renderer; the core tests run headless.

## Ground rules

1. **`src/core` must stay engine-free.** No `THREE`, no renderer imports, no `window`/`document`
   outside `I18n.apply()` (the DOM helper). This is what keeps the project format portable and the
   motion engine testable. CI greps for it.
2. **Determinism is a feature.** Never call `Math.random()` in `src/core`. Use `Rng` from
   `prng.js`, keyed on the project seed. Any change that makes the same time sample differently on
   a second run is a regression.
3. **Project schema changes need three things:** a migration in `project.js`, a fixture under
   `tests/fixtures/`, and a note in the PR. Never re-use a version number.
4. **No engine types in saved files.** If a field would serialise a matrix, a THREE object or a
   class instance, it doesn't belong in `project.json`.
5. **UI strings go through the catalog.** Use `data-loc="some.key"`; `npm test` checks key parity
   between `pt-BR` and `en`.

## Commit style

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`). One logical change per PR.
Sign off your commits (`git commit -s`, DCO).

## Localisation

`src/locales/*.json` is a flat catalog. To add a language:

1. copy `en.json` to `<language>.json` and translate the values (never the keys);
2. add it to `I18n.load()` in `src/renderer/app.js` and to the language `<select>`;
3. keep the `{placeholders}` untouched — numbers are formatted per locale by `I18n.t`.

## Assets

Only **CC0 / CC-BY / OFL** assets may be committed, with a provenance row
(`path, author, licence, source URL`). No "found on the internet" models, no ripped game assets,
no voices cloned without consent.

## Reporting bugs

Include the selftest report: run `npm run selftest` and paste `dist-selftest/report.json`
(it contains GPU, WebGL version, frame count, clip count and any renderer errors — no personal data).
