# Backend (Fastify)

Endpoints
- GET /health
- GET /api/auctions
- POST /api/auctions
- POST /api/auctions/:id/bids

Auth: Supabase JWT (Authorization: Bearer <token>) when SUPABASE env is set; otherwise dev fallback header `x-user-id`.
Persistence: Pluggable store: Supabase (if env set), else Upstash Redis, else in-memory.
WebSockets: global feed broadcasts `bid:accepted` events.

## Database
- To use Supabase, set SUPABASE_URL and SUPABASE_ANON_KEY in `.env`.
- Apply `supabase.sql` in your project to create tables.
