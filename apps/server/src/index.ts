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
import { initRedis, redisInfo } from './redisClient.js';
import { nanoid } from 'nanoid';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { sendEmail, buildInvoiceHtml } from './email.js';
import { getUserEmail, getUserPhone } from './users.js';
import { sendSms } from './sms.js';
import * as supaRepo from './supaRepo.js'

// Basic runtime config
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'http://localhost:5173';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const USE_SUPABASE_REST = process.env.USE_SUPABASE_REST === 'true'

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
  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic, { root: publicDir })
    app.log.info({ publicDir }, 'Static UI enabled')
  } else {
    app.log.info({ publicDir }, 'Static UI skipped (folder missing)')
  }
} catch {}

// Init Sequelize models (if DATABASE_URL configured) — skip when using Supabase REST mode
if (!USE_SUPABASE_REST) {
  await initModels().catch((e) => app.log.warn(e, 'Sequelize init failed'))
}

// Redis for highest-bid cache (node-redis if REDIS_URL; else Upstash REST fallback)
const redisForBids = await initRedis();

// Health
app.get('/health', async () => ({ ok: true }));

// Runtime config for client (only safe/public values)
app.get('/config', async () => ({
  supabaseUrl: process.env.SUPABASE_URL || null,
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
  publicOrigin: process.env.PUBLIC_ORIGIN || null,
}))

// Admin diagnostics: checks DB/Redis/env and optionally attempts connections.
app.get('/health/check', async (req, reply) => {
  const u = await getUserId(req)
  // dev fallback: allow if x-user-id header is present
  const devUser = (!u && typeof (req.headers['x-user-id']) === 'string') ? { id: String(req.headers['x-user-id']) } : null
  if (!u && !devUser) return reply.unauthorized('Auth required')
  const res: any = { ok: true, services: {} }
  // DB / Supabase
  if (USE_SUPABASE_REST) {
    res.services.db = { ok: !!supaRepo.supa }
    if (!supaRepo.supa) res.ok = false
  } else if (sequelize) {
    try { await sequelize.authenticate(); res.services.db = { ok: true } } catch (e: any) { res.ok = false; res.services.db = { ok: false, error: e.message } }
  } else {
    res.ok = false; res.services.db = { ok: false, error: 'DATABASE_URL missing' }
  }
  // Redis
  if (redisForBids) {
    try {
      const key = `diag:ping:${nanoid(6)}`
      // short TTL to avoid leftovers
      await (redisForBids as any).set(key, '1', { ex: 5 })
      const got = await (redisForBids as any).get(key)
      const ok = got === '1'
      res.services.redis = { ok, ...redisInfo() }
    } catch (e: any) {
      res.services.redis = { ok: false, error: e.message, ...redisInfo() }
    }
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
  title: z.string().trim().min(1).max(120),
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
  if (USE_SUPABASE_REST) {
    const out = await supaRepo.createAuction(parsed.data, userId)
    return reply.code(out.status).send(out.body)
  }
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
  if (redisForBids) await redisForBids.hset(`auction:${row.id}`, { current: auction.currentPrice, step: parsed.data.bidIncrement, endsAt: auction.endsAt })
  return reply.code(201).send(auction);
});

// List auctions (basic)
app.get('/api/auctions', async (req) => {
  if (USE_SUPABASE_REST) {
    const { status, offset, limit } = (req.query || {}) as any
    const off = offset ? Number(offset) : undefined
    const lim = limit ? Number(limit) : undefined
    const out = await supaRepo.listAuctions({ status, offset: off, limit: lim })
    return out.body
  }
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
  if (USE_SUPABASE_REST) {
    const out = await supaRepo.getAuction((req.params as any).id)
    return reply.code(out.status).send(out.body)
  }
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
  if (USE_SUPABASE_REST) {
    const { offset, limit } = (req.query || {}) as any
    const off = offset ? Number(offset) : undefined
    const lim = limit ? Number(limit) : undefined
    const out = await supaRepo.listBids((req.params as any).id, { offset: off, limit: lim })
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.send({ items: [] })
  const { id } = req.params as { id: string }
  const rows = await BidModel.findAll({ where: { auctionId: id }, order: [['createdAt','DESC']] })
  return { items: rows.map((b: any) => ({ id: b.id, bidderId: b.bidderId, amount: Number(b.amount), createdAt: new Date(b.createdAt).toISOString() })) }
})

// Winner/top bid
app.get('/api/auctions/:id/winner', async (req, reply) => {
  const { id } = req.params as { id: string }
  if (USE_SUPABASE_REST) {
    const top = await supaRepo.getTopBid(id)
    if (!top) return reply.notFound()
    return reply.send(top)
  }
  if (!sequelize) return reply.notFound()
  const row = await BidModel.findOne({ where: { auctionId: id }, order: [['amount','DESC']] })
  if (!row) return reply.notFound()
  return reply.send({ bidderId: row.bidderId, amount: Number(row.amount) })
})

// Notifications for current user
app.get('/api/notifications', async (req, reply) => {
  const userId = await getUserId(req)
  if (!userId) return reply.unauthorized('Missing user')
  if (USE_SUPABASE_REST) {
    const out = await supaRepo.listNotifications(userId)
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.send({ items: [] })
  const rows = await NotificationModel.findAll({ where: { userId }, order: [['createdAt','DESC']], limit: 50 })
  return { items: rows.map((n: any) => ({ id: n.id, type: n.type, payload: n.payload, read: n.read, createdAt: new Date(n.createdAt).toISOString() })) }
})

// Who am I
app.get('/api/me', async (req, reply) => {
  const user = await getUserId(req)
  if (!user) return reply.unauthorized('Missing user')
  return { id: user, isAdmin: !!ADMIN_USER_ID && user === ADMIN_USER_ID }
})

// Admin endpoints
app.get('/admin/auctions', async (req, reply) => {
  const user = await getUserId(req)
  if (!user) return reply.unauthorized('Missing user')
  if (!ADMIN_USER_ID || user !== ADMIN_USER_ID) return reply.forbidden('Not admin')
  if (USE_SUPABASE_REST) {
  const { status, offset, limit } = (req.query || {}) as any
  const off = offset ? Number(offset) : undefined
  const lim = limit ? Number(limit) : undefined
  const out = await supaRepo.listAuctions({ status, offset: off, limit: lim })
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.send({ items: [] })
  const rows = await AuctionModel.findAll({ order: [['createdAt','DESC']], limit: 200 })
  return { items: rows.map((r:any)=>({ id:r.id, title:r.title, status:r.status, currentPrice:Number(r.currentPrice), bidIncrement:Number(r.bidIncrement), goLiveAt:new Date(r.goLiveAt).toISOString(), endsAt:new Date(r.endsAt).toISOString() })) }
})

// Host-owned auctions (seller view)
app.get('/host/auctions', async (req, reply) => {
  const user = await getUserId(req)
  if (!user) return reply.unauthorized('Missing user')
  if (USE_SUPABASE_REST) {
    const out = await supaRepo.listAuctionsBySeller(user)
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.send({ items: [] })
  const rows = await AuctionModel.findAll({ where: { sellerId: user }, order: [['createdAt','DESC']], limit: 200 })
  return { items: rows.map((r:any)=>({ id:r.id, title:r.title, status:r.status, currentPrice:Number(r.currentPrice), bidIncrement:Number(r.bidIncrement), goLiveAt:new Date(r.goLiveAt).toISOString(), endsAt:new Date(r.endsAt).toISOString() })) }
})

const AdminAdjustSchema = z.object({ minutes: z.number().int().min(1).max(7*24*60).optional() })
app.post('/admin/auctions/:id/start', async (req, reply) => {
  const user = await getUserId(req)
  if (!user) return reply.unauthorized('Missing user')
  if (!ADMIN_USER_ID || user !== ADMIN_USER_ID) return reply.forbidden('Not admin')
  const { id } = req.params as { id:string }
  const parsed = AdminAdjustSchema.safeParse(req.body || {})
  if (!parsed.success) return reply.badRequest(parsed.error.message)
  if (USE_SUPABASE_REST) {
    const out = await supaRepo.startAuction(id, parsed.data.minutes ?? 10)
    // in Supabase mode, ensure current user is seller; otherwise forbid
    const a = await supaRepo.getAuction(id)
    if (a.status === 200 && (a.body?.sellerId !== user)) return reply.forbidden('Not seller')
    if (out.status === 200) {
      const msg = JSON.stringify({ type:'auction:started', auctionId: id })
      broadcast(msg)
      try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
    }
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.internalServerError('DB not configured')
  const a = await AuctionModel.findByPk(id)
  if (!a) return reply.notFound('Not found')
  const now = new Date()
  const duration = (parsed.data.minutes ?? 10) * 60_000
  a.goLiveAt = now as any
  a.endsAt = new Date(now.getTime()+duration) as any
  a.status = 'live' as any
  await a.save()
  // seed redis
  if (redisForBids) await redisForBids.hset(`auction:${a.id}`, { current: Number(a.currentPrice), step: Number(a.bidIncrement), endsAt: (a.endsAt as any).toISOString?.() || new Date(a.endsAt).toISOString() })
  broadcast(JSON.stringify({ type:'auction:started', auctionId: a.id }))
  return { ok:true }
})

app.post('/admin/auctions/:id/reset', async (req, reply) => {
  const user = await getUserId(req)
  if (!user) return reply.unauthorized('Missing user')
  if (!ADMIN_USER_ID || user !== ADMIN_USER_ID) return reply.forbidden('Not admin')
  const { id } = req.params as { id:string }
  const parsed = AdminAdjustSchema.safeParse(req.body || {})
  if (!parsed.success) return reply.badRequest(parsed.error.message)
  if (USE_SUPABASE_REST) {
    const out = await supaRepo.resetAuction(id, parsed.data.minutes ?? 10)
    const a = await supaRepo.getAuction(id)
    if (a.status === 200 && (a.body?.sellerId !== user)) return reply.forbidden('Not seller')
    if (out.status === 200) {
      const msg = JSON.stringify({ type:'auction:reset', auctionId: id })
      broadcast(msg)
      try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
    }
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.internalServerError('DB not configured')
  const a = await AuctionModel.findByPk(id)
  if (!a) return reply.notFound('Not found')
  const now = new Date()
  const duration = (parsed.data.minutes ?? 10) * 60_000
  a.currentPrice = a.startingPrice
  a.goLiveAt = now as any
  a.endsAt = new Date(now.getTime()+duration) as any
  a.status = 'scheduled' as any
  await a.save()
  if (redisForBids) await redisForBids.hset(`auction:${a.id}`, { current: Number(a.currentPrice), step: Number(a.bidIncrement), endsAt: (a.endsAt as any).toISOString?.() || new Date(a.endsAt).toISOString() })
  broadcast(JSON.stringify({ type:'auction:reset', auctionId: a.id }))
  return { ok:true }
})

// Seller controls (start/reset own auction)
app.post('/host/auctions/:id/start', async (req, reply) => {
  const user = await getUserId(req)
  if (!user) return reply.unauthorized('Missing user')
  const { id } = req.params as { id:string }
  const parsed = AdminAdjustSchema.safeParse(req.body || {})
  if (!parsed.success) return reply.badRequest(parsed.error.message)
  if (USE_SUPABASE_REST) {
    const a = await supaRepo.getAuction(id)
    if (a.status !== 200 || a.body?.sellerId !== user) return reply.forbidden('Not seller')
    const out = await supaRepo.startAuction(id, parsed.data.minutes ?? 10)
    if (out.status === 200) {
      const msg = JSON.stringify({ type:'auction:started', auctionId: id })
      broadcast(msg)
      try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
    }
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.internalServerError('DB not configured')
  const a = await AuctionModel.findByPk(id)
  if (!a || a.sellerId !== user) return reply.forbidden('Not seller')
  const now = new Date()
  const duration = (parsed.data.minutes ?? 10) * 60_000
  a.goLiveAt = now as any
  a.endsAt = new Date(now.getTime()+duration) as any
  a.status = 'live' as any
  await a.save()
  if (redisForBids) await redisForBids.hset(`auction:${a.id}`, { current: Number(a.currentPrice), step: Number(a.bidIncrement), endsAt: (a.endsAt as any).toISOString?.() || new Date(a.endsAt).toISOString() })
  const msg = JSON.stringify({ type:'auction:started', auctionId: a.id })
  broadcast(msg)
  try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
  return { ok:true }
})

app.post('/host/auctions/:id/reset', async (req, reply) => {
  const user = await getUserId(req)
  if (!user) return reply.unauthorized('Missing user')
  const { id } = req.params as { id:string }
  const parsed = AdminAdjustSchema.safeParse(req.body || {})
  if (!parsed.success) return reply.badRequest(parsed.error.message)
  if (USE_SUPABASE_REST) {
    const a = await supaRepo.getAuction(id)
    if (a.status !== 200 || a.body?.sellerId !== user) return reply.forbidden('Not seller')
    const out = await supaRepo.resetAuction(id, parsed.data.minutes ?? 10)
    if (out.status === 200) {
      const msg = JSON.stringify({ type:'auction:reset', auctionId: id })
      broadcast(msg)
      try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
    }
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.internalServerError('DB not configured')
  const a = await AuctionModel.findByPk(id)
  if (!a || a.sellerId !== user) return reply.forbidden('Not seller')
  const now = new Date()
  const duration = (parsed.data.minutes ?? 10) * 60_000
  a.currentPrice = a.startingPrice
  a.goLiveAt = now as any
  a.endsAt = new Date(now.getTime()+duration) as any
  a.status = 'scheduled' as any
  await a.save()
  if (redisForBids) await redisForBids.hset(`auction:${a.id}`, { current: Number(a.currentPrice), step: Number(a.bidIncrement), endsAt: (a.endsAt as any).toISOString?.() || new Date(a.endsAt).toISOString() })
  const msg = JSON.stringify({ type:'auction:reset', auctionId: a.id })
  broadcast(msg)
  try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
  return { ok:true }
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

  if (USE_SUPABASE_REST) {
    const out = await supaRepo.placeBid(id, userId, parsed.data.amount)
    if (out.status === 201) {
      const msg = JSON.stringify({ type: 'bid:accepted', auctionId: id, amount: parsed.data.amount, userId, at: new Date().toISOString() })
      broadcast(msg); try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
      // also push notifications if provided
      const notify = out.body?.notify as Array<{ userId: string; type: string; payload: any }> | undefined
      if (notify && Array.isArray(notify)) {
        for (const n of notify) {
          const nm = JSON.stringify({ type: 'notify', userId: n.userId, payload: { type: n.type, ...n.payload }, at: new Date().toISOString() })
          broadcast(nm); try { await (redisForBids as any)?.publish?.('ws:broadcast', nm) } catch {}
        }
      }
    }
    return reply.code(out.status).send(out.body)
  }
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
  // cross-instance broadcast via Redis pub/sub if available
  try { await (redisForBids as any)?.publish?.('ws:broadcast', JSON.stringify(payload)) } catch {}
  return reply.code(201).send({ ok: true });
});

// Auction end and seller decision
app.post('/api/auctions/:id/end', async (req, reply) => {
  const userId = await getUserId(req);
  if (!userId) return reply.unauthorized('Missing user');
  if (USE_SUPABASE_REST) {
    const out = await supaRepo.endAuction((req.params as any).id, userId)
    return reply.code(out.status).send(out.body)
  }
  if (!sequelize) return reply.internalServerError('DB not configured');
  const { id } = req.params as { id: string }
  const a = await AuctionModel.findByPk(id)
  if (!a) return reply.notFound('Not found')
  if (a.sellerId !== userId) return reply.forbidden('Not seller')
  a.status = 'ended' as any
  await a.save()
  broadcast(JSON.stringify({ type: 'auction:ended', auctionId: id, final: Number(a.currentPrice) }))
  try { await (redisForBids as any)?.publish?.('ws:broadcast', JSON.stringify({ type: 'auction:ended', auctionId: id, final: Number(a.currentPrice) })) } catch {}
  // Notify seller with summary
  await NotificationModel.create({ id: nanoid(12), userId, type: 'auction:ended', payload: { auctionId: id, final: Number(a.currentPrice) }, read: false } as any)
  return { ok: true }
})

const DecisionSchema = z.object({ action: z.enum(['accept','reject','counter']), amount: z.number().positive().optional() })
app.post('/api/auctions/:id/decision', async (req, reply) => {
  const userId = await getUserId(req);
  if (!userId) return reply.unauthorized('Missing user');
  if (USE_SUPABASE_REST) {
    const { id } = req.params as { id: string }
    const parsed = DecisionSchema.safeParse(req.body)
    if (!parsed.success) return reply.badRequest(parsed.error.message)
    const out = await supaRepo.decision(id, userId, parsed.data.action, parsed.data.amount)
  if (out.status === 200) {
      if (parsed.data.action === 'accept' && out.body?.winnerId) {
    const buyerEmail = await getUserEmail(out.body.winnerId)
    const sellerEmail = await getUserEmail(out.body.sellerId || userId)
    const html = buildInvoiceHtml({ auctionTitle: out.body.auctionTitle || 'Auction', amount: Number(out.body.amount), buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: id })
    try { if (buyerEmail) await sendEmail(buyerEmail, `You won: ${out.body.auctionTitle || 'Auction'}`, `You won auction ${out.body.auctionTitle || id} for $${Number(out.body.amount).toFixed(2)}`, { html }) } catch {}
    try { if (sellerEmail) await sendEmail(sellerEmail, `Sold: ${out.body.auctionTitle || 'Auction'}`, `Your auction ${out.body.auctionTitle || id} sold for $${Number(out.body.amount).toFixed(2)}`, { html }) } catch {}
    const buyerPhone = await getUserPhone(out.body.winnerId)
    const sellerPhone = await getUserPhone(out.body.sellerId || userId)
    try { if (buyerPhone) await sendSms(buyerPhone, `You won ${out.body.auctionTitle || 'item'} for $${Number(out.body.amount).toFixed(2)}`) } catch {}
    try { if (sellerPhone) await sendSms(sellerPhone, `Sold ${out.body.auctionTitle || 'item'} for $${Number(out.body.amount).toFixed(2)}`) } catch {}
        const msg = JSON.stringify({ type: 'auction:accepted', auctionId: id, winnerId: out.body.winnerId, amount: Number(out.body.amount) })
        broadcast(msg); try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
  // notify buyer and seller
  const nb = JSON.stringify({ type: 'notify', userId: out.body.winnerId, payload: { type: 'offer:accepted', auctionId: id, amount: Number(out.body.amount) }, at: new Date().toISOString() })
  broadcast(nb); try { await (redisForBids as any)?.publish?.('ws:broadcast', nb) } catch {}
  const ns = JSON.stringify({ type: 'notify', userId: out.body.sellerId || userId, payload: { type: 'offer:accepted', auctionId: id, amount: Number(out.body.amount) }, at: new Date().toISOString() })
  broadcast(ns); try { await (redisForBids as any)?.publish?.('ws:broadcast', ns) } catch {}
      } else if (parsed.data.action === 'reject') {
        const msg = JSON.stringify({ type: 'auction:rejected', auctionId: id })
        broadcast(msg); try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
  const nr = JSON.stringify({ type: 'notify', userId: out.body?.winnerId || out.body?.buyerId, payload: { type: 'offer:rejected', auctionId: id }, at: new Date().toISOString() })
  try { broadcast(nr); await (redisForBids as any)?.publish?.('ws:broadcast', nr) } catch {}
      } else if (parsed.data.action === 'counter') {
        const msg = JSON.stringify({ type: 'offer:counter', auctionId: id, amount: parsed.data.amount })
        broadcast(msg); try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
  const nc = JSON.stringify({ type: 'notify', userId: out.body?.buyerId, payload: { type: 'offer:counter', auctionId: id, amount: parsed.data.amount }, at: new Date().toISOString() })
  try { broadcast(nc); await (redisForBids as any)?.publish?.('ws:broadcast', nc) } catch {}
      }
    }
    return reply.code(out.status).send(out.body)
  }
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
  try { if (buyerEmail) await sendEmail(buyerEmail, `You won: ${a.title}`, `You won auction ${a.title} for $${Number(topBid.amount).toFixed(2)}`, { html }) } catch {}
  try { if (sellerEmail) await sendEmail(sellerEmail, `Sold: ${a.title}`, `Your auction ${a.title} sold for $${Number(topBid.amount).toFixed(2)}`, { html }) } catch {}
  // SMS (best-effort)
  const buyerPhone = await getUserPhone(topBid.bidderId)
  const sellerPhone = await getUserPhone(a.sellerId)
  try { if (buyerPhone) await sendSms(buyerPhone, `You won ${a.title} for $${Number(topBid.amount).toFixed(2)}`) } catch {}
  try { if (sellerPhone) await sendSms(sellerPhone, `Sold ${a.title} for $${Number(topBid.amount).toFixed(2)}`) } catch {}
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
  try { await (redisForBids as any)?.publish?.('ws:broadcast', JSON.stringify({ type: 'offer:counter', auctionId: id, amount: parsed.data.amount, buyerId: topBid.bidderId })) } catch {}
  await NotificationModel.create({ id: nanoid(12), userId: topBid.bidderId, type: 'offer:counter', payload: { auctionId: id, amount: parsed.data.amount }, read: false } as any)
  return { ok: true }
})

const CounterReplySchema = z.object({ accept: z.boolean() })
app.post('/api/counter/:id/reply', async (req, reply) => {
  const userId = await getUserId(req);
  if (!userId) return reply.unauthorized('Missing user');
  if (USE_SUPABASE_REST) {
    const out = await supaRepo.counterReply((req.params as any).id, userId, !!(req.body as any).accept)
    if (out.status === 200) {
      if ((req.body as any).accept) {
        const aTitle = out.body?.auctionTitle || 'Auction'
        const amount = Number(out.body?.amount)
        const sellerEmail = await getUserEmail(out.body?.sellerId)
        const buyerEmail = await getUserEmail(userId)
        const html = buildInvoiceHtml({ auctionTitle: aTitle, amount, buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: out.body?.auctionId || '' })
  try { if (buyerEmail) await sendEmail(buyerEmail, `Offer accepted: ${aTitle}`, `Seller accepted at $${amount.toFixed(2)}`, { html }) } catch {}
  try { if (sellerEmail) await sendEmail(sellerEmail, `You accepted: ${aTitle}`, `You accepted the offer at $${amount.toFixed(2)}`, { html }) } catch {}
        const msg = JSON.stringify({ type: 'offer:accepted', auctionId: out.body?.auctionId, amount })
        broadcast(msg); try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
  const n1 = JSON.stringify({ type: 'notify', userId: userId, payload: { type: 'offer:accepted', auctionId: out.body?.auctionId, amount }, at: new Date().toISOString() })
  const n2 = JSON.stringify({ type: 'notify', userId: out.body?.sellerId, payload: { type: 'offer:accepted', auctionId: out.body?.auctionId, amount }, at: new Date().toISOString() })
  try { broadcast(n1); await (redisForBids as any)?.publish?.('ws:broadcast', n1) } catch {}
  try { broadcast(n2); await (redisForBids as any)?.publish?.('ws:broadcast', n2) } catch {}
      } else {
        const msg = JSON.stringify({ type: 'offer:rejected', auctionId: out.body?.auctionId })
        broadcast(msg); try { await (redisForBids as any)?.publish?.('ws:broadcast', msg) } catch {}
  const n = JSON.stringify({ type: 'notify', userId: userId, payload: { type: 'offer:rejected', auctionId: out.body?.auctionId }, at: new Date().toISOString() })
  try { broadcast(n); await (redisForBids as any)?.publish?.('ws:broadcast', n) } catch {}
      }
    }
    return reply.code(out.status).send(out.body)
  }
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
  try { await (redisForBids as any)?.publish?.('ws:broadcast', JSON.stringify({ type: 'offer:accepted', auctionId: a.id, amount: Number(offer.amount) })) } catch {}
  // Email buyer & seller
  const buyerEmail = await getUserEmail(offer.buyerId)
  const sellerEmail = await getUserEmail(offer.sellerId)
  const html = buildInvoiceHtml({ auctionTitle: a.title, amount: Number(offer.amount), buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: a.id })
  try { if (buyerEmail) await sendEmail(buyerEmail, `Offer accepted: ${a.title}`, `Seller accepted at $${Number(offer.amount).toFixed(2)}`, { html }) } catch {}
  try { if (sellerEmail) await sendEmail(sellerEmail, `You accepted: ${a.title}`, `You accepted the offer at $${Number(offer.amount).toFixed(2)}`, { html }) } catch {}
  const buyerPhone = await getUserPhone(offer.buyerId)
  const sellerPhone = await getUserPhone(offer.sellerId)
  try { if (buyerPhone) await sendSms(buyerPhone, `Seller accepted your offer for ${a.title} at $${Number(offer.amount).toFixed(2)}`) } catch {}
  try { if (sellerPhone) await sendSms(sellerPhone, `You accepted buyer offer for ${a.title} at $${Number(offer.amount).toFixed(2)}`) } catch {}
  } else {
    offer.status = 'rejected' as any
    await offer.save()
    a.status = 'closed' as any
    await a.save()
  broadcast(JSON.stringify({ type: 'offer:rejected', auctionId: a.id }))
  try { await (redisForBids as any)?.publish?.('ws:broadcast', JSON.stringify({ type: 'offer:rejected', auctionId: a.id })) } catch {}
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

// Subscribe to cross-instance WS broadcast if Redis supports it
try {
  await (redisForBids as any)?.subscribe?.('ws:broadcast', (message: string) => {
    broadcast(message)
  })
} catch {}

// SPA fallback: serve index.html for unmatched GET routes (except API/health)
try {
  app.get('/*', async (req, reply) => {
    const url = (req as any).url as string
    if (url.startsWith('/api') || url.startsWith('/health') || url.startsWith('/ws')) return reply.notFound()
    // fastify-static decorates reply with sendFile
    if (typeof (reply as any).sendFile === 'function') {
      return (reply as any).sendFile('index.html')
    }
    return reply.notFound()
  })
} catch {}
app.log.info(`Server listening on http://localhost:${PORT}`);

// Background: end auctions whose time passed (only in Sequelize mode)
if (sequelize && !USE_SUPABASE_REST) {
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
