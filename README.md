# Hexstory

**Every place has a story.** A world map divided into hexagons where anyone can read, write and discuss what
happened in a place.

Everything about how it works (architecture, moderation rules, security, procedures) is in
[docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Requirements: Node 24, PostgreSQL 14+, the [Doppler CLI](https://docs.doppler.com/docs/install-cli).

```bash
npm install
doppler setup                 # picks project "hexstory", config "dev" from doppler.yaml
npm run dev                   # migrates the DB, starts API (:3000) + web (:5173)
```

Open http://localhost:5173. Optional sample content: `doppler run -- npm run seed -w @hexstory/api`.

See `.env.example` for the variables Doppler provides, and DESIGN.md → "Running it" for details.
Local development needs no cloud services (images on disk, chat coordination in memory).

## Deploying

Production runs on Vercel with Neon Postgres, Cloudflare R2 and Redis Cloud. Step-by-step setup, the
release procedure (migrations are an explicit step) and a smoke-test checklist are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
