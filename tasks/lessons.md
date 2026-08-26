# Lessons

## 2026-08-26 — CDK custom drag preview "no difference"
- **Pattern**: When a custom `<ng-template cdkDragPreview>` doesn't take effect, don't guess one root cause and ship it. The preview context is the CdkDragPreview directive's `[data]` **input** (not `cdkDragData`), so `let-data="data"` without binding `[data]` yields an undefined context and the custom preview silently fails — even when the template is correctly placed inside the cdkDrag element.
- **Rule**: Copy the proven in-repo pattern (project-card.html) exactly: no `let-data`, reference the `@for` loop variable directly. Pair template fixes with a CSS fallback on `.cdk-drag-preview` (the default clone's class) so the result is tidy even if template discovery fails.
- **Rule**: Read the library source (node_modules/@angular/cdk/fesm2022/drag-drop.mjs) to confirm the wiring mechanism *before* presenting a fix as the cause.

## 2026-08-26 — Custom drag preview silently inert: directive not in component `imports`
- **Pattern**: The pill preview rendered as a cloned full row despite correct template + SCSS. Root cause: `CdkDragPreview` was missing from the component's `imports` array. In Angular standalone components, an un-imported attribute directive on `<ng-template>` (e.g. `cdkDragPreview`) is **silently ignored at compile time** — no error, no warning, the template is just dead markup.
- **Rule**: Before debugging CDK internals or styles, check the component `imports` array contains every directive referenced in the template. Prove preview identity in the running app (puppeteer: inspect `.cdk-drag-preview` class list) rather than trusting the template source.
- **Rule**: External edits can revert earlier fixes. When reconciling, grep for the load-bearing import before assuming a fix still holds.

## 2026-08-26 — Import silently mutating data: re-placement on load
- **Pattern**: v5 export → import moved `assignments.start` (S2 → S1). `applyData` runs `saveSettings` → `clampToQuarter` → `replaceOrUnassign`, which re-placed **every** allocation at the earliest free window even when the saved placement was still valid.
- **Rule**: Load/import paths must be idempotent and fidelity-preserving — any "normalize on load" step (clamping, re-placing, sanitizing) should be a no-op on already-valid data. Test round-trips with byte/JSON-identity checks, and include fixture fields (like `settings`) that trigger side-effectful code paths.

## 2026-08-26 — Check existing tooling before inventing solutions
- **Pattern**: Hand-rolled a single-file inliner when `npm run build:single` already existed.
- **Rule**: Read package.json scripts / scripts/ directory before writing new build tooling — the repo usually already has it.
