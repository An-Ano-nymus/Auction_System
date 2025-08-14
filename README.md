# Auction System Monorepo

A full-stack, real-time auction platform.

Tech stack
- React (Vite) frontend
- Node.js + Fastify backend
- WebSockets for live bidding
- Supabase (Postgres) as DB and Auth
- Upstash Redis for caching/rate limits/locks
- SendGrid for email

## Structure
- apps/client: React app
- apps/server: Node backend (Fastify + ws)
- packages/shared: Shared types and utils

## Quick start
1) Fill environment variables from `.env.example` files in both apps.
2) Install dependencies at root and in apps.
3) Run dev servers.

See per-app READMEs for details.
