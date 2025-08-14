import 'dotenv/config';
import { setDefaultResultOrder } from 'node:dns';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { WebSocketServer } from 'ws';
import { z } from 'zod';
import { getAuthUser } from './auth.js';
import { initModels, sequelize, AuctionModel, BidModel, CounterOfferModel, NotificationModel } from './sequelize.js';
import { Redis } from '@upstash/redis';
import { nanoid } from 'nanoid';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { sendEmail, buildInvoiceHtml } from './email.js';
import { getUserEmail } from './users.js';

// Basic runtime config
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'http://localhost:5173';

// store abstraction removed from runtime; Sequelize is the primary store

// Fastify app
const app = Fastify({ logger: true });

// Prefer IPv4 first to avoid IPv6 routing issues in some hosts
try { setDefaultResultOrder('ipv4first') } catch {}

await app.register(cors, { origin: true, credentials: true });
await app.register(sensible);
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
// Serve static UI if present (client build copied to ../client-dist)
// Admin diagnostics: validates configured services and key envs
try {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  const publicDir = join(__dirname, '../../client-dist')
  await app.register(fastifyStatic, { root: publicDir })
} catch {}

// Init Sequelize models (if DATABASE_URL configured)
await initModels().catch((e) => app.log.warn(e, 'Sequelize init failed'));

// Redis for highest-bid cache
const redisForBids = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! })
  : null as any;

// Health
app.get('/health', async () => ({ ok: true }));

// Admin diagnostics: checks DB/Redis/env and optionally attempts connections.
app.get('/health/check', async (req, reply) => {
  const user = await getUserId(req)
  if (!user) return reply.unauthorized('Auth required')
  const res: any = { ok: true, services: {} }
  // DB
  if (sequelize) {
    try { await sequelize.authenticate(); res.services.db = { ok: true } } catch (e: any) { res.ok = false; res.services.db = { ok: false, error: e.message } }
  } else {
    res.ok = false; res.services.db = { ok: false, error: 'DATABASE_URL missing' }
  }
  // Redis
  if (redisForBids) {
    try { const pong = await redisForBids.ping(); res.services.redis = { ok: pong === 'PONG' } } catch (e: any) { res.ok = false; res.services.redis = { ok: false, error: e.message } }
  } else {
    res.services.redis = { ok: false, error: 'UPSTASH not configured' }
  }
  // SendGrid presence
  res.services.sendgrid = { ok: !!process.env.SENDGRID_API_KEY && !!process.env.SENDGRID_FROM_EMAIL }
  // Origin
  res.publicOrigin = PUBLIC_ORIGIN
  return res
})

// Domain models
type Auction = {
  id: string;
  title: string;
  description?: string;
  startingPrice: number;
  currentPrice: number;
  endsAt: string; // ISO
  createdAt: string; // ISO
};

// Validate create auction payload
const CreateAuctionSchema = z.object({
  title: z.string().min(3).max(120),
  description: z.string().max(2000).optional(),
  startingPrice: z.number().nonnegative(),
  bidIncrement: z.number().positive(),
  goLiveAt: z.string().datetime(),
  durationMinutes: z.number().int().min(1).max(7 * 24 * 60)
});

// Simple auth placeholder: pass userId via header for now (replace with Supabase auth/JWT)
async function getUserId(req: any): Promise<string | null> {
  const u = await getAuthUser(req)
  return u?.id ?? null
}

// Create auction
app.post('/api/auctions', async (req, reply) => {
  const userId = await getUserId(req);
  if (!userId) return reply.unauthorized('Missing user');

  const parsed = CreateAuctionSchema.safeParse(req.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);

  // Persist using Sequelize (Supabase Postgres)
  if (!sequelize) return reply.internalServerError('DB not configured');
  const now = new Date(parsed.data.goLiveAt)
  const ends = new Date(now.getTime() + parsed.data.durationMinutes * 60_000)
  const row = await AuctionModel.create({
    id: nanoid(12),
    sellerId: userId,
    title: parsed.data.title,
    description: parsed.data.description ?? null,
    startingPrice: parsed.data.startingPrice,
    bidIncrement: parsed.data.bidIncrement,
    goLiveAt: now,
    endsAt: ends,
    currentPrice: parsed.data.startingPrice,
    status: new Date() >= now ? 'live' : 'scheduled'
  } as any)
  const auction: Auction = {
    id: row.id,
    title: row.title,
    description: row.description ?? undefined,
    startingPrice: Number(row.startingPrice),
    currentPrice: Number(row.currentPrice),
    endsAt: row.endsAt.toISOString(),
    createdAt: (row as any).createdAt?.toISOString?.() || new Date().toISOString()
  }
  // Seed Redis cache for fast access
  if (redisForBids) await redisForBids.hset(`auction:${row.id}`, { current: auction.currentPrice, step: parsed.data.bidIncrement, endsAt: auction.endsAt })
  return reply.code(201).send(auction);
});

// List auctions (basic)
app.get('/api/auctions', async () => {
  if (!sequelize) return { items: [] };
  const rows = await AuctionModel.findAll({ order: [['createdAt', 'DESC']] })
  const list = rows.map((r: any) => ({
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    startingPrice: Number(r.startingPrice),
    currentPrice: Number(r.currentPrice),
    bidIncrement: Number(r.bidIncrement),
    goLiveAt: new Date(r.goLiveAt).toISOString(),
    endsAt: new Date(r.endsAt).toISOString(),
    createdAt: new Date(r.createdAt).toISOString()
  }))
  return { items: list };
});

// Single auction and bids
app.get('/api/auctions/:id', async (req, reply) => {
  if (!sequelize) return reply.notFound()
  const { id } = req.params as { id: string }
  const r = await AuctionModel.findByPk(id)
  if (!r) return reply.notFound()
  return {
    id: r.id,
    title: r.title,
    description: r.description ?? undefined,
    startingPrice: Number(r.startingPrice),
    currentPrice: Number(r.currentPrice),
    bidIncrement: Number(r.bidIncrement),
    goLiveAt: new Date(r.goLiveAt).toISOString(),
    endsAt: new Date(r.endsAt).toISOString(),
    status: r.status,
    sellerId: r.sellerId,
  }
})

app.get('/api/auctions/:id/bids', async (req, reply) => {
  if (!sequelize) return reply.send({ items: [] })
  const { id } = req.params as { id: string }
  const rows = await BidModel.findAll({ where: { auctionId: id }, order: [['createdAt','DESC']] })
  return { items: rows.map((b: any) => ({ id: b.id, bidderId: b.bidderId, amount: Number(b.amount), createdAt: new Date(b.createdAt).toISOString() })) }
})

// Notifications for current user
app.get('/api/notifications', async (req, reply) => {
  const userId = await getUserId(req)
  if (!userId) return reply.unauthorized('Missing user')
  if (!sequelize) return reply.send({ items: [] })
  const rows = await NotificationModel.findAll({ where: { userId }, order: [['createdAt','DESC']], limit: 50 })
  return { items: rows.map((n: any) => ({ id: n.id, type: n.type, payload: n.payload, read: n.read, createdAt: new Date(n.createdAt).toISOString() })) }
})

// Bid schema
const BidSchema = z.object({ amount: z.number().positive() });

// HTTP place bid (also emits WS event)
app.post('/api/auctions/:id/bids', async (req, reply) => {
  const userId = await getUserId(req);
  if (!userId) return reply.unauthorized('Missing user');

  const { id } = req.params as { id: string };
  const parsed = BidSchema.safeParse(req.body);
  if (!parsed.success) return reply.badRequest(parsed.error.message);

  if (!sequelize) return reply.internalServerError('DB not configured');
  // Load auction row first
  const row = await AuctionModel.findByPk(id)
  if (!row) return reply.notFound('Auction not found')

  let current = Number(row.currentPrice)
  let step = Number(row.bidIncrement)
  let endsAtIso = new Date(row.endsAt).toISOString()

  if (redisForBids) {
    const meta = await redisForBids.hgetall(`auction:${id}`) as Record<string, string> | null
    if (meta && (meta as any).current) current = Number((meta as any).current)
    if (meta && (meta as any).step) step = Number((meta as any).step)
    if (meta && (meta as any).endsAt) endsAtIso = String((meta as any).endsAt)
    else {
      // seed if cold
      await redisForBids.hset(`auction:${id}`, { current, step, endsAt: endsAtIso })
    }
  }

  const nowIso = new Date().toISOString()
  if (nowIso > endsAtIso || new Date() > new Date(row.endsAt)) return reply.conflict('Auction ended')
  if (parsed.data.amount < current + step) return reply.conflict('Bid too low')

  const prev = Number(row.currentPrice)
  row.currentPrice = parsed.data.amount as any
  await row.save()
  await BidModel.create({ id: nanoid(12), auctionId: id, bidderId: userId, amount: parsed.data.amount } as any)
  if (redisForBids) await redisForBids.hset(`auction:${id}`, { current: parsed.data.amount })

  // Notify: outbid previous highest bidder (optional: fetch from last bid)
  const lastBid = await BidModel.findOne({ where: { auctionId: id }, order: [['createdAt', 'DESC']] })
  if (lastBid && lastBid.bidderId !== userId) {
    await NotificationModel.create({ id: nanoid(12), userId: lastBid.bidderId, type: 'bid:outbid', payload: { auctionId: id, amount: parsed.data.amount }, read: false } as any)
  }

  // WS broadcast
  const payload = {
    type: 'bid:accepted',
    auctionId: id,
    amount: parsed.data.amount,
    userId,
    at: new Date().toISOString()
  };
  broadcast(JSON.stringify(payload));
  return reply.code(201).send({ ok: true });
});

// Auction end and seller decision
app.post('/api/auctions/:id/end', async (req, reply) => {
  const userId = await getUserId(req);
  if (!userId) return reply.unauthorized('Missing user');
  if (!sequelize) return reply.internalServerError('DB not configured');
  const { id } = req.params as { id: string }
  const a = await AuctionModel.findByPk(id)
  if (!a) return reply.notFound('Not found')
  if (a.sellerId !== userId) return reply.forbidden('Not seller')
  a.status = 'ended' as any
  await a.save()
  broadcast(JSON.stringify({ type: 'auction:ended', auctionId: id, final: Number(a.currentPrice) }))
  // Notify seller with summary
  await NotificationModel.create({ id: nanoid(12), userId, type: 'auction:ended', payload: { auctionId: id, final: Number(a.currentPrice) }, read: false } as any)
  return { ok: true }
})

const DecisionSchema = z.object({ action: z.enum(['accept','reject','counter']), amount: z.number().positive().optional() })
app.post('/api/auctions/:id/decision', async (req, reply) => {
  const userId = await getUserId(req);
  if (!userId) return reply.unauthorized('Missing user');
  if (!sequelize) return reply.internalServerError('DB not configured');
  const { id } = req.params as { id: string }
  const parsed = DecisionSchema.safeParse(req.body)
  if (!parsed.success) return reply.badRequest(parsed.error.message)
  const a = await AuctionModel.findByPk(id)
  if (!a) return reply.notFound('Not found')
  if (a.sellerId !== userId) return reply.forbidden('Not seller')
  const topBid = await BidModel.findOne({ where: { auctionId: id }, order: [['amount','DESC']] })
  if (!topBid) return reply.conflict('No bids')

  if (parsed.data.action === 'accept') {
    a.status = 'closed' as any
    await a.save()
    broadcast(JSON.stringify({ type: 'auction:accepted', auctionId: id, winnerId: topBid.bidderId, amount: Number(topBid.amount) }))
    await NotificationModel.create({ id: nanoid(12), userId: topBid.bidderId, type: 'offer:accepted', payload: { auctionId: id, amount: Number(topBid.amount) }, read: false } as any)
  // Email buyer & seller (best-effort)
  const buyerEmail = await getUserEmail(topBid.bidderId)
  const sellerEmail = await getUserEmail(a.sellerId)
  const html = buildInvoiceHtml({ auctionTitle: a.title, amount: Number(topBid.amount), buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: a.id })
  if (buyerEmail) await sendEmail(buyerEmail, `You won: ${a.title}`, `You won auction ${a.title} for $${Number(topBid.amount).toFixed(2)}`, { html })
  if (sellerEmail) await sendEmail(sellerEmail, `Sold: ${a.title}`, `Your auction ${a.title} sold for $${Number(topBid.amount).toFixed(2)}`, { html })
    return { ok: true }
  }
  if (parsed.data.action === 'reject') {
    a.status = 'closed' as any
    await a.save()
    broadcast(JSON.stringify({ type: 'auction:rejected', auctionId: id }))
    await NotificationModel.create({ id: nanoid(12), userId: topBid.bidderId, type: 'offer:rejected', payload: { auctionId: id }, read: false } as any)
    return { ok: true }
  }
  // counter
  if (!parsed.data.amount) return reply.badRequest('Counter amount required')
  const c = await CounterOfferModel.create({ id: nanoid(12), auctionId: id, sellerId: userId, buyerId: topBid.bidderId, amount: parsed.data.amount } as any)
  broadcast(JSON.stringify({ type: 'offer:counter', auctionId: id, amount: parsed.data.amount, buyerId: topBid.bidderId }))
  await NotificationModel.create({ id: nanoid(12), userId: topBid.bidderId, type: 'offer:counter', payload: { auctionId: id, amount: parsed.data.amount }, read: false } as any)
  return { ok: true }
})

const CounterReplySchema = z.object({ accept: z.boolean() })
app.post('/api/counter/:id/reply', async (req, reply) => {
  const userId = await getUserId(req);
  if (!userId) return reply.unauthorized('Missing user');
  if (!sequelize) return reply.internalServerError('DB not configured');
  const { id } = req.params as { id: string }
  const parsed = CounterReplySchema.safeParse(req.body)
  if (!parsed.success) return reply.badRequest(parsed.error.message)
  const offer = await CounterOfferModel.findByPk(id)
  if (!offer) return reply.notFound('Not found')
  if (offer.buyerId !== userId) return reply.forbidden('Not buyer')
  const a = await AuctionModel.findByPk(offer.auctionId)
  if (!a) return reply.notFound('Auction not found')
  if (parsed.data.accept) {
    offer.status = 'accepted' as any
    await offer.save()
    a.currentPrice = offer.amount as any
    a.status = 'closed' as any
    await a.save()
    broadcast(JSON.stringify({ type: 'offer:accepted', auctionId: a.id, amount: Number(offer.amount) }))
  // Email buyer & seller
  const buyerEmail = await getUserEmail(offer.buyerId)
  const sellerEmail = await getUserEmail(offer.sellerId)
  const html = buildInvoiceHtml({ auctionTitle: a.title, amount: Number(offer.amount), buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: a.id })
  if (buyerEmail) await sendEmail(buyerEmail, `Offer accepted: ${a.title}`, `Seller accepted at $${Number(offer.amount).toFixed(2)}`, { html })
  if (sellerEmail) await sendEmail(sellerEmail, `You accepted: ${a.title}`, `You accepted the offer at $${Number(offer.amount).toFixed(2)}`, { html })
  } else {
    offer.status = 'rejected' as any
    await offer.save()
    a.status = 'closed' as any
    await a.save()
    broadcast(JSON.stringify({ type: 'offer:rejected', auctionId: a.id }))
  }
  return { ok: true }
})

// HTTP server + WS
let wss: WebSocketServer | null = null;

function broadcast(data: string) {
  if (!wss) return;
  wss.clients.forEach((client) => {
    if ((client as any).readyState === 1 /* OPEN */) (client as any).send(data);
  });
}

await app.listen({ port: PORT, host: '0.0.0.0' });
wss = new WebSocketServer({ server: app.server });
wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
});
app.log.info(`Server listening on http://localhost:${PORT}`);

// Background: end auctions whose time passed
if (sequelize) {
  setInterval(async () => {
    const now = new Date()
    try {
      const rows = await AuctionModel.findAll({ where: { status: 'live' } })
      for (const r of rows) {
        if (new Date(r.endsAt) <= now) {
          r.status = 'ended'
          await r.save()
          broadcast(JSON.stringify({ type: 'auction:ended', auctionId: r.id, final: Number(r.currentPrice) }))
          await NotificationModel.create({ id: nanoid(12), userId: r.sellerId, type: 'auction:ended', payload: { auctionId: r.id, final: Number(r.currentPrice) }, read: false })
        }
      }
    } catch (e) {
      app.log.error(e)
    }
  }, 5000).unref()
}
