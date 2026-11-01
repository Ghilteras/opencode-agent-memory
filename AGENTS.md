# Repository rules

- Run checks with `bun run typecheck` and `bun run test`. The package scripts use Bun; `pnpm check` is not defined. There is no build script.
- Run diagnostics with `bun run journal:doctor`.
- `bun run test` covers `src/*.test.ts` only. `tests/main-guard-closeout.sh` is a separate bash harness that `bun run test` does not run.
- Release only by pushing a `v*` tag from a clean tree, and the tag must equal the version in `package.json`. CI runs typecheck and tests, then publishes with npm provenance using OIDC. Never publish manually, and never bump or publish from a dirty tree. `workflow_dispatch` does not publish.
- Lefthook runs `scripts/main-guard.sh` for commit, merge and push checks. Do not bypass it. It blocks writes from the main checkout on `main`, and raw pushes to `main`; land changes through a pull request.
- File map: `src/` is the published package surface; `.github/workflows/publish.yml` owns release automation.
- Preserve embedding compatibility: `Xenova/paraphrase-multilingual-MiniLM-L12-v2`, `q8`, 384 dimensions, and the versioned `{ v, model, dimension, vector }` sidecar format.
- Consumers pin exact package versions; coordinate compatibility changes accordingly.
