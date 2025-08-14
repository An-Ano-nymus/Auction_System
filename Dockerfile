# Multi-stage build: build client and server, then run server serving static client
FROM node:20-alpine AS builder
WORKDIR /app
# Install dependencies
COPY package.json package-lock.json* .npmrc* ./
COPY apps/server/package.json apps/server/package.json
COPY apps/client/package.json apps/client/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install && npm -w apps/server install redis@^4
# Copy sources
COPY . .
# Build all workspaces
RUN npm run build
# Prepare client assets at /app/apps/client-dist
RUN mkdir -p /app/apps/client-dist && cp -r apps/client/dist/* /app/apps/client-dist/

FROM node:20-alpine AS runner
ENV NODE_ENV=production
ENV NODE_OPTIONS=--dns-result-order=ipv4first
ENV PGSSLMODE=require
WORKDIR /app
# Copy built artifacts and node_modules from builder for simplicity
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/apps/server /app/apps/server
COPY --from=builder /app/apps/client-dist /app/apps/client-dist
# Expose server port
EXPOSE 8080
# Default environment (override on render)
ENV PORT=8080
# Start server
CMD ["node", "apps/server/dist/index.js"]
