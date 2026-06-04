# TypeScript / Bun / Astro-Workers Standards

Authoritative language rule for this repo. Supersedes any Python references in the other `.rules/` files (this project has no Python).

## Toolchain
- **Bun** for all package management and scripts. Never `npm`/`npx` for project deps. (The one exception is Cloudflare ops via `npx cfman wrangler --account sccn` — the documented SCCN path.)
- **Biome** for lint + format: `bun run biome check --fix .`. No ESLint/Prettier.
- **TypeScript strict.** `tsc --noEmit` must pass. No `any`; prefer `unknown` + narrowing. No non-null `!` assertions unless a comment proves the invariant.
- **Hono on Workers** (matching nemar-cli `backend/`). The UI is one server-rendered HTML page (template string) plus a small client script; no SPA framework. The worker default export is `{ fetch: app.fetch, scheduled }`.

## Cloudflare Workers idioms
- Use the `fetch`/Web APIs only — no Node-specific libraries in worker code (`nodejs_compat` is available but avoid relying on it).
- Bindings come off `env`/`locals.runtime.env`. Treat optional bindings as optional (guard before use), matching nemar-cli's pattern.
- D1: always parameterize (`.bind(...)`). Against the shared `nemar-db`, issue **`SELECT` only** — never write, never run migrations.
- Cron lives in the worker `scheduled()` handler; keep it to a few bounded, indexed aggregate queries.

## Code style
- Stateless modules exporting functions (mirror nemar-cli `backend/src/services/*`).
- Keep pure logic (schema building, classification, SQL-string construction) in functions that are unit-testable without a binding.
- Errors: no empty catch blocks, no silent failures; log with a clear prefix (`[metrics] ...`). Telemetry/non-critical writes must never break a response.
- Comments explain *why*, matching surrounding density.

## Testing (see testing.md)
- `bun test`, real data only, no mocks. Test pure functions directly; exercise D1 SQL against a real in-memory SQLite (`bun:sqlite`) the way nemar-cli's `migrations.test.ts` does.
