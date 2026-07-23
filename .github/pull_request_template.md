## What

## Gate checklist

- [ ] `pnpm run test:coverage` green (thresholds 95/90/95/95)
- [ ] `pnpm run lint` / `typecheck` / `format:check` green
- [ ] Parser change → fixture added (real file, synthetic builder, or fuzz case)
- [ ] Writer change → round-trip suite still byte-identical
- [ ] Public API change → TSDoc + README/migration docs updated
- [ ] Touches length/offset/inflate code → fuzz coverage for the new path
