# Hexstory

Read `docs/DESIGN.md` first: it is the single source of truth for how the app works (stack, data model,
moderation rules, security, UI decisions, procedures).

**Whenever you change behaviour, schema, tooling, policy numbers, routes or procedures, update
`docs/DESIGN.md` in the same change**, including a dated line in its Changelog section.

- Monorepo: `packages/shared` (types, Zod schemas, hex/date helpers), `apps/api` (Fastify), `apps/web` (React).
- Secrets come from Doppler (`doppler run --`); never write secrets to files.
- Schema changes: add a new `apps/api/migrations/NNN_name.sql`; never edit an applied migration.
- Run `npm run typecheck` and `npm test` before finishing (API tests need `TEST_DATABASE_URL`).
