# Lessons

## 2026-08-26 — CDK custom drag preview "no difference"
- **Pattern**: When a custom `<ng-template cdkDragPreview>` doesn't take effect, don't guess one root cause and ship it. The preview context is the CdkDragPreview directive's `[data]` **input** (not `cdkDragData`), so `let-data="data"` without binding `[data]` yields an undefined context and the custom preview silently fails — even when the template is correctly placed inside the cdkDrag element.
- **Rule**: Copy the proven in-repo pattern (project-card.html) exactly: no `let-data`, reference the `@for` loop variable directly. Pair template fixes with a CSS fallback on `.cdk-drag-preview` (the default clone's class) so the result is tidy even if template discovery fails.
- **Rule**: Read the library source (node_modules/@angular/cdk/fesm2022/drag-drop.mjs) to confirm the wiring mechanism *before* presenting a fix as the cause.
