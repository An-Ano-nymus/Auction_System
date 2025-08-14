# Deployment & Integrations (Render, Cron Warmup, SendGrid)

This guide shows how to deploy the app to Render using Docker, keep the free instance warm with cron-job.org, and send emails with SendGrid.

## 1) Render.com (Docker Hosting)

Prereqs:
- A Render account (free plan OK)
- A Postgres DB URL (Supabase works) and Upstash Redis REST URL/token
- SendGrid API key + sender email (verified)

Steps:
1. Fork or push this repo to GitHub.
2. In Render, click New > Blueprint and select this repo.
3. Render reads `render.yaml`. Confirm:
   - Runtime: Docker
   - Dockerfile path: `./Dockerfile`
   - Health check: `/health`
4. Set environment variables in the service settings after the first deploy:
   - SUPABASE_URL, SUPABASE_ANON_KEY (for client auth), SUPABASE_KEY (server verify)
   - DATABASE_URL (Supabase Postgres connection string)
   - UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
   - SENDGRID_API_KEY, SENDGRID_FROM_EMAIL
   - PUBLIC_ORIGIN (Render service URL, e.g., https://your-service.onrender.com)
5. Deploy. Render will build the monorepo via the Dockerfile, expose port 8080, and run the Fastify server that also serves the built client (from `/apps/client-dist`).

Notes:
- The server serves static files if `/apps/client-dist` exists (configured in `apps/server/src/index.ts` via `@fastify/static`).
- If you change the Vite base path or need SPA routing, ensure the server returns index.html for unknown routes (can be added later if needed).

## 2) Free Instance Warmup (cron-job.org)

Render free instances sleep when idle. Use a third-party cron pinger to keep it warm.

1. Create an account at https://cron-job.org.
2. Add a new cron job:
   - URL: `https://your-service.onrender.com/health`
   - Method: GET
   - Schedule: Every 5 minutes
   - Timeout: 10 seconds
3. Save. The periodic request keeps the instance hot and the background scheduler active.

Optional: Add a second job that hits `/api/auctions` to also warm any DB/Redis paths.

## 3) SendGrid Email API

1. Create a SendGrid account and generate an API key with Mail Send permissions.
2. Verify a sender identity and use that address as `SENDGRID_FROM_EMAIL`.
3. In Render service env vars, add:
   - `SENDGRID_API_KEY`
   - `SENDGRID_FROM_EMAIL`
4. The server uses `apps/server/src/email.ts` helper. Example usage is wired in decision flows can be added:

   - On accept/reject/counter-accept, you can send emails to buyer/seller:
     - Subject: Auction result
     - HTML: Optional invoice via `buildInvoiceHtml(..)`

Troubleshooting:
- If emails are not sent, check logs for SendGrid errors and ensure the sender identity is verified.
- In dev without keys, email calls are skipped.

## Environment Variables (Summary)

See `apps/server/.env.example` and `render.yaml`. Key vars:
- `PORT=8080` (Render injects PORT, but we default to 8080)
- `PUBLIC_ORIGIN=https://your-service.onrender.com`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_KEY`
- `DATABASE_URL` (postgresql://...)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL`

## Local build & run (optional)

- Docker build:
  - `docker build -t auction-system .`
- Run:
  - `docker run -p 8080:8080 --env-file apps/server/.env auction-system`

Ensure the env file includes all required variables.
