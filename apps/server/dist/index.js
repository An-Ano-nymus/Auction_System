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
import * as supaRepo from './supaRepo.js';
// Basic runtime config
const PORT = Number(process.env.PORT || 8080);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'http://localhost:5173';
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const USE_SUPABASE_REST = process.env.USE_SUPABASE_REST === 'true';
// store abstraction removed from runtime; Sequelize is the primary store
// Fastify app
const app = Fastify({ logger: true });
// Prefer IPv4 first to avoid IPv6 routing issues in some hosts
try {
    setDefaultResultOrder('ipv4first');
}
catch { }
await app.register(cors, { origin: true, credentials: true });
await app.register(sensible);
await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
// Serve static UI if present (client build copied to ../client-dist)
// Admin diagnostics: validates configured services and key envs
try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const publicDir = join(__dirname, '../../client-dist');
    if (fs.existsSync(publicDir)) {
        await app.register(fastifyStatic, { root: publicDir });
        app.log.info({ publicDir }, 'Static UI enabled');
    }
    else {
        app.log.info({ publicDir }, 'Static UI skipped (folder missing)');
    }
}
catch { }
// Init Sequelize models (if DATABASE_URL configured)
await initModels().catch((e) => app.log.warn(e, 'Sequelize init failed'));
// Redis for highest-bid cache (node-redis if REDIS_URL; else Upstash REST fallback)
const redisForBids = await initRedis();
// Health
app.get('/health', async () => ({ ok: true }));
// Admin diagnostics: checks DB/Redis/env and optionally attempts connections.
app.get('/health/check', async (req, reply) => {
    const u = await getUserId(req);
    // dev fallback: allow if x-user-id header is present
    const devUser = (!u && typeof (req.headers['x-user-id']) === 'string') ? { id: String(req.headers['x-user-id']) } : null;
    if (!u && !devUser)
        return reply.unauthorized('Auth required');
    const res = { ok: true, services: {} };
    // DB / Supabase
    if (USE_SUPABASE_REST) {
        res.services.db = { ok: !!supaRepo.supa };
        if (!supaRepo.supa)
            res.ok = false;
    }
    else if (sequelize) {
        try {
            await sequelize.authenticate();
            res.services.db = { ok: true };
        }
        catch (e) {
            res.ok = false;
            res.services.db = { ok: false, error: e.message };
        }
    }
    else {
        res.ok = false;
        res.services.db = { ok: false, error: 'DATABASE_URL missing' };
    }
    // Redis
    if (redisForBids) {
        try {
            const key = `diag:ping:${nanoid(6)}`;
            // short TTL to avoid leftovers
            await redisForBids.set(key, '1', { ex: 5 });
            const got = await redisForBids.get(key);
            const ok = got === '1';
            res.services.redis = { ok, ...redisInfo() };
        }
        catch (e) {
            res.services.redis = { ok: false, error: e.message, ...redisInfo() };
        }
    }
    else {
        res.services.redis = { ok: false, error: 'UPSTASH not configured' };
    }
    // SendGrid presence
    res.services.sendgrid = { ok: !!process.env.SENDGRID_API_KEY && !!process.env.SENDGRID_FROM_EMAIL };
    // Origin
    res.publicOrigin = PUBLIC_ORIGIN;
    return res;
});
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
async function getUserId(req) {
    const u = await getAuthUser(req);
    return u?.id ?? null;
}
// Create auction
app.post('/api/auctions', async (req, reply) => {
    const userId = await getUserId(req);
    if (!userId)
        return reply.unauthorized('Missing user');
    const parsed = CreateAuctionSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.badRequest(parsed.error.message);
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.createAuction(parsed.data, userId);
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    const now = new Date(parsed.data.goLiveAt);
    const ends = new Date(now.getTime() + parsed.data.durationMinutes * 60_000);
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
    });
    const auction = {
        id: row.id,
        title: row.title,
        description: row.description ?? undefined,
        startingPrice: Number(row.startingPrice),
        currentPrice: Number(row.currentPrice),
        endsAt: row.endsAt.toISOString(),
        createdAt: row.createdAt?.toISOString?.() || new Date().toISOString()
    };
    if (redisForBids)
        await redisForBids.hset(`auction:${row.id}`, { current: auction.currentPrice, step: parsed.data.bidIncrement, endsAt: auction.endsAt });
    return reply.code(201).send(auction);
});
// List auctions (basic)
app.get('/api/auctions', async () => {
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.listAuctions();
        return out.body;
    }
    if (!sequelize)
        return { items: [] };
    const rows = await AuctionModel.findAll({ order: [['createdAt', 'DESC']] });
    const list = rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description ?? undefined,
        startingPrice: Number(r.startingPrice),
        currentPrice: Number(r.currentPrice),
        bidIncrement: Number(r.bidIncrement),
        goLiveAt: new Date(r.goLiveAt).toISOString(),
        endsAt: new Date(r.endsAt).toISOString(),
        createdAt: new Date(r.createdAt).toISOString()
    }));
    return { items: list };
});
// Single auction and bids
app.get('/api/auctions/:id', async (req, reply) => {
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.getAuction(req.params.id);
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.notFound();
    const { id } = req.params;
    const r = await AuctionModel.findByPk(id);
    if (!r)
        return reply.notFound();
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
    };
});
app.get('/api/auctions/:id/bids', async (req, reply) => {
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.listBids(req.params.id);
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.send({ items: [] });
    const { id } = req.params;
    const rows = await BidModel.findAll({ where: { auctionId: id }, order: [['createdAt', 'DESC']] });
    return { items: rows.map((b) => ({ id: b.id, bidderId: b.bidderId, amount: Number(b.amount), createdAt: new Date(b.createdAt).toISOString() })) };
});
// Notifications for current user
app.get('/api/notifications', async (req, reply) => {
    const userId = await getUserId(req);
    if (!userId)
        return reply.unauthorized('Missing user');
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.listNotifications(userId);
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.send({ items: [] });
    const rows = await NotificationModel.findAll({ where: { userId }, order: [['createdAt', 'DESC']], limit: 50 });
    return { items: rows.map((n) => ({ id: n.id, type: n.type, payload: n.payload, read: n.read, createdAt: new Date(n.createdAt).toISOString() })) };
});
// Who am I
app.get('/api/me', async (req, reply) => {
    const user = await getUserId(req);
    if (!user)
        return reply.unauthorized('Missing user');
    return { id: user, isAdmin: !!ADMIN_USER_ID && user === ADMIN_USER_ID };
});
// Admin endpoints
app.get('/admin/auctions', async (req, reply) => {
    const user = await getUserId(req);
    if (!user)
        return reply.unauthorized('Missing user');
    if (!ADMIN_USER_ID || user !== ADMIN_USER_ID)
        return reply.forbidden('Not admin');
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.listAuctions();
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.send({ items: [] });
    const rows = await AuctionModel.findAll({ order: [['createdAt', 'DESC']], limit: 200 });
    return { items: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, currentPrice: Number(r.currentPrice), bidIncrement: Number(r.bidIncrement), goLiveAt: new Date(r.goLiveAt).toISOString(), endsAt: new Date(r.endsAt).toISOString() })) };
});
// Host-owned auctions (seller view)
app.get('/host/auctions', async (req, reply) => {
    const user = await getUserId(req);
    if (!user)
        return reply.unauthorized('Missing user');
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.listAuctionsBySeller(user);
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.send({ items: [] });
    const rows = await AuctionModel.findAll({ where: { sellerId: user }, order: [['createdAt', 'DESC']], limit: 200 });
    return { items: rows.map((r) => ({ id: r.id, title: r.title, status: r.status, currentPrice: Number(r.currentPrice), bidIncrement: Number(r.bidIncrement), goLiveAt: new Date(r.goLiveAt).toISOString(), endsAt: new Date(r.endsAt).toISOString() })) };
});
const AdminAdjustSchema = z.object({ minutes: z.number().int().min(1).max(7 * 24 * 60).optional() });
app.post('/admin/auctions/:id/start', async (req, reply) => {
    const user = await getUserId(req);
    if (!user)
        return reply.unauthorized('Missing user');
    if (!ADMIN_USER_ID || user !== ADMIN_USER_ID)
        return reply.forbidden('Not admin');
    const { id } = req.params;
    const parsed = AdminAdjustSchema.safeParse(req.body || {});
    if (!parsed.success)
        return reply.badRequest(parsed.error.message);
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.startAuction(id, parsed.data.minutes ?? 10);
        // in Supabase mode, ensure current user is seller; otherwise forbid
        const a = await supaRepo.getAuction(id);
        if (a.status === 200 && (a.body?.sellerId !== user))
            return reply.forbidden('Not seller');
        if (out.status === 200) {
            const msg = JSON.stringify({ type: 'auction:started', auctionId: id });
            broadcast(msg);
            try {
                await redisForBids?.publish?.('ws:broadcast', msg);
            }
            catch { }
        }
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    const a = await AuctionModel.findByPk(id);
    if (!a)
        return reply.notFound('Not found');
    const now = new Date();
    const duration = (parsed.data.minutes ?? 10) * 60_000;
    a.goLiveAt = now;
    a.endsAt = new Date(now.getTime() + duration);
    a.status = 'live';
    await a.save();
    // seed redis
    if (redisForBids)
        await redisForBids.hset(`auction:${a.id}`, { current: Number(a.currentPrice), step: Number(a.bidIncrement), endsAt: a.endsAt.toISOString?.() || new Date(a.endsAt).toISOString() });
    broadcast(JSON.stringify({ type: 'auction:started', auctionId: a.id }));
    return { ok: true };
});
app.post('/admin/auctions/:id/reset', async (req, reply) => {
    const user = await getUserId(req);
    if (!user)
        return reply.unauthorized('Missing user');
    if (!ADMIN_USER_ID || user !== ADMIN_USER_ID)
        return reply.forbidden('Not admin');
    const { id } = req.params;
    const parsed = AdminAdjustSchema.safeParse(req.body || {});
    if (!parsed.success)
        return reply.badRequest(parsed.error.message);
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.resetAuction(id, parsed.data.minutes ?? 10);
        const a = await supaRepo.getAuction(id);
        if (a.status === 200 && (a.body?.sellerId !== user))
            return reply.forbidden('Not seller');
        if (out.status === 200) {
            const msg = JSON.stringify({ type: 'auction:reset', auctionId: id });
            broadcast(msg);
            try {
                await redisForBids?.publish?.('ws:broadcast', msg);
            }
            catch { }
        }
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    const a = await AuctionModel.findByPk(id);
    if (!a)
        return reply.notFound('Not found');
    const now = new Date();
    const duration = (parsed.data.minutes ?? 10) * 60_000;
    a.currentPrice = a.startingPrice;
    a.goLiveAt = now;
    a.endsAt = new Date(now.getTime() + duration);
    a.status = 'scheduled';
    await a.save();
    if (redisForBids)
        await redisForBids.hset(`auction:${a.id}`, { current: Number(a.currentPrice), step: Number(a.bidIncrement), endsAt: a.endsAt.toISOString?.() || new Date(a.endsAt).toISOString() });
    broadcast(JSON.stringify({ type: 'auction:reset', auctionId: a.id }));
    return { ok: true };
});
// Seller controls (start/reset own auction)
app.post('/host/auctions/:id/start', async (req, reply) => {
    const user = await getUserId(req);
    if (!user)
        return reply.unauthorized('Missing user');
    const { id } = req.params;
    const parsed = AdminAdjustSchema.safeParse(req.body || {});
    if (!parsed.success)
        return reply.badRequest(parsed.error.message);
    if (USE_SUPABASE_REST) {
        const a = await supaRepo.getAuction(id);
        if (a.status !== 200 || a.body?.sellerId !== user)
            return reply.forbidden('Not seller');
        const out = await supaRepo.startAuction(id, parsed.data.minutes ?? 10);
        if (out.status === 200) {
            const msg = JSON.stringify({ type: 'auction:started', auctionId: id });
            broadcast(msg);
            try {
                await redisForBids?.publish?.('ws:broadcast', msg);
            }
            catch { }
        }
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    const a = await AuctionModel.findByPk(id);
    if (!a || a.sellerId !== user)
        return reply.forbidden('Not seller');
    const now = new Date();
    const duration = (parsed.data.minutes ?? 10) * 60_000;
    a.goLiveAt = now;
    a.endsAt = new Date(now.getTime() + duration);
    a.status = 'live';
    await a.save();
    if (redisForBids)
        await redisForBids.hset(`auction:${a.id}`, { current: Number(a.currentPrice), step: Number(a.bidIncrement), endsAt: a.endsAt.toISOString?.() || new Date(a.endsAt).toISOString() });
    const msg = JSON.stringify({ type: 'auction:started', auctionId: a.id });
    broadcast(msg);
    try {
        await redisForBids?.publish?.('ws:broadcast', msg);
    }
    catch { }
    return { ok: true };
});
app.post('/host/auctions/:id/reset', async (req, reply) => {
    const user = await getUserId(req);
    if (!user)
        return reply.unauthorized('Missing user');
    const { id } = req.params;
    const parsed = AdminAdjustSchema.safeParse(req.body || {});
    if (!parsed.success)
        return reply.badRequest(parsed.error.message);
    if (USE_SUPABASE_REST) {
        const a = await supaRepo.getAuction(id);
        if (a.status !== 200 || a.body?.sellerId !== user)
            return reply.forbidden('Not seller');
        const out = await supaRepo.resetAuction(id, parsed.data.minutes ?? 10);
        if (out.status === 200) {
            const msg = JSON.stringify({ type: 'auction:reset', auctionId: id });
            broadcast(msg);
            try {
                await redisForBids?.publish?.('ws:broadcast', msg);
            }
            catch { }
        }
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    const a = await AuctionModel.findByPk(id);
    if (!a || a.sellerId !== user)
        return reply.forbidden('Not seller');
    const now = new Date();
    const duration = (parsed.data.minutes ?? 10) * 60_000;
    a.currentPrice = a.startingPrice;
    a.goLiveAt = now;
    a.endsAt = new Date(now.getTime() + duration);
    a.status = 'scheduled';
    await a.save();
    if (redisForBids)
        await redisForBids.hset(`auction:${a.id}`, { current: Number(a.currentPrice), step: Number(a.bidIncrement), endsAt: a.endsAt.toISOString?.() || new Date(a.endsAt).toISOString() });
    const msg = JSON.stringify({ type: 'auction:reset', auctionId: a.id });
    broadcast(msg);
    try {
        await redisForBids?.publish?.('ws:broadcast', msg);
    }
    catch { }
    return { ok: true };
});
// Bid schema
const BidSchema = z.object({ amount: z.number().positive() });
// HTTP place bid (also emits WS event)
app.post('/api/auctions/:id/bids', async (req, reply) => {
    const userId = await getUserId(req);
    if (!userId)
        return reply.unauthorized('Missing user');
    const { id } = req.params;
    const parsed = BidSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.badRequest(parsed.error.message);
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.placeBid(id, userId, parsed.data.amount);
        if (out.status === 201) {
            const msg = JSON.stringify({ type: 'bid:accepted', auctionId: id, amount: parsed.data.amount, userId, at: new Date().toISOString() });
            broadcast(msg);
            try {
                await redisForBids?.publish?.('ws:broadcast', msg);
            }
            catch { }
        }
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    // Load auction row first
    const row = await AuctionModel.findByPk(id);
    if (!row)
        return reply.notFound('Auction not found');
    let current = Number(row.currentPrice);
    let step = Number(row.bidIncrement);
    let endsAtIso = new Date(row.endsAt).toISOString();
    if (redisForBids) {
        const meta = await redisForBids.hgetall(`auction:${id}`);
        if (meta && meta.current)
            current = Number(meta.current);
        if (meta && meta.step)
            step = Number(meta.step);
        if (meta && meta.endsAt)
            endsAtIso = String(meta.endsAt);
        else {
            // seed if cold
            await redisForBids.hset(`auction:${id}`, { current, step, endsAt: endsAtIso });
        }
    }
    const nowIso = new Date().toISOString();
    if (nowIso > endsAtIso || new Date() > new Date(row.endsAt))
        return reply.conflict('Auction ended');
    if (parsed.data.amount < current + step)
        return reply.conflict('Bid too low');
    const prev = Number(row.currentPrice);
    row.currentPrice = parsed.data.amount;
    await row.save();
    await BidModel.create({ id: nanoid(12), auctionId: id, bidderId: userId, amount: parsed.data.amount });
    if (redisForBids)
        await redisForBids.hset(`auction:${id}`, { current: parsed.data.amount });
    // Notify: outbid previous highest bidder (optional: fetch from last bid)
    const lastBid = await BidModel.findOne({ where: { auctionId: id }, order: [['createdAt', 'DESC']] });
    if (lastBid && lastBid.bidderId !== userId) {
        await NotificationModel.create({ id: nanoid(12), userId: lastBid.bidderId, type: 'bid:outbid', payload: { auctionId: id, amount: parsed.data.amount }, read: false });
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
    try {
        await redisForBids?.publish?.('ws:broadcast', JSON.stringify(payload));
    }
    catch { }
    return reply.code(201).send({ ok: true });
});
// Auction end and seller decision
app.post('/api/auctions/:id/end', async (req, reply) => {
    const userId = await getUserId(req);
    if (!userId)
        return reply.unauthorized('Missing user');
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.endAuction(req.params.id, userId);
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    const { id } = req.params;
    const a = await AuctionModel.findByPk(id);
    if (!a)
        return reply.notFound('Not found');
    if (a.sellerId !== userId)
        return reply.forbidden('Not seller');
    a.status = 'ended';
    await a.save();
    broadcast(JSON.stringify({ type: 'auction:ended', auctionId: id, final: Number(a.currentPrice) }));
    try {
        await redisForBids?.publish?.('ws:broadcast', JSON.stringify({ type: 'auction:ended', auctionId: id, final: Number(a.currentPrice) }));
    }
    catch { }
    // Notify seller with summary
    await NotificationModel.create({ id: nanoid(12), userId, type: 'auction:ended', payload: { auctionId: id, final: Number(a.currentPrice) }, read: false });
    return { ok: true };
});
const DecisionSchema = z.object({ action: z.enum(['accept', 'reject', 'counter']), amount: z.number().positive().optional() });
app.post('/api/auctions/:id/decision', async (req, reply) => {
    const userId = await getUserId(req);
    if (!userId)
        return reply.unauthorized('Missing user');
    if (USE_SUPABASE_REST) {
        const { id } = req.params;
        const parsed = DecisionSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.badRequest(parsed.error.message);
        const out = await supaRepo.decision(id, userId, parsed.data.action, parsed.data.amount);
        if (out.status === 200) {
            if (parsed.data.action === 'accept' && out.body?.winnerId) {
                const buyerEmail = await getUserEmail(out.body.winnerId);
                const sellerEmail = await getUserEmail(out.body.sellerId || userId);
                const html = buildInvoiceHtml({ auctionTitle: out.body.auctionTitle || 'Auction', amount: Number(out.body.amount), buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: id });
                if (buyerEmail)
                    await sendEmail(buyerEmail, `You won: ${out.body.auctionTitle || 'Auction'}`, `You won auction ${out.body.auctionTitle || id} for $${Number(out.body.amount).toFixed(2)}`, { html });
                if (sellerEmail)
                    await sendEmail(sellerEmail, `Sold: ${out.body.auctionTitle || 'Auction'}`, `Your auction ${out.body.auctionTitle || id} sold for $${Number(out.body.amount).toFixed(2)}`, { html });
                const buyerPhone = await getUserPhone(out.body.winnerId);
                const sellerPhone = await getUserPhone(out.body.sellerId || userId);
                if (buyerPhone)
                    await sendSms(buyerPhone, `You won ${out.body.auctionTitle || 'item'} for $${Number(out.body.amount).toFixed(2)}`);
                if (sellerPhone)
                    await sendSms(sellerPhone, `Sold ${out.body.auctionTitle || 'item'} for $${Number(out.body.amount).toFixed(2)}`);
                const msg = JSON.stringify({ type: 'auction:accepted', auctionId: id, winnerId: out.body.winnerId, amount: Number(out.body.amount) });
                broadcast(msg);
                try {
                    await redisForBids?.publish?.('ws:broadcast', msg);
                }
                catch { }
            }
            else if (parsed.data.action === 'reject') {
                const msg = JSON.stringify({ type: 'auction:rejected', auctionId: id });
                broadcast(msg);
                try {
                    await redisForBids?.publish?.('ws:broadcast', msg);
                }
                catch { }
            }
            else if (parsed.data.action === 'counter') {
                const msg = JSON.stringify({ type: 'offer:counter', auctionId: id, amount: parsed.data.amount });
                broadcast(msg);
                try {
                    await redisForBids?.publish?.('ws:broadcast', msg);
                }
                catch { }
            }
        }
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    const { id } = req.params;
    const parsed = DecisionSchema.safeParse(req.body);
    if (!parsed.success)
        return reply.badRequest(parsed.error.message);
    const a = await AuctionModel.findByPk(id);
    if (!a)
        return reply.notFound('Not found');
    if (a.sellerId !== userId)
        return reply.forbidden('Not seller');
    const topBid = await BidModel.findOne({ where: { auctionId: id }, order: [['amount', 'DESC']] });
    if (!topBid)
        return reply.conflict('No bids');
    if (parsed.data.action === 'accept') {
        a.status = 'closed';
        await a.save();
        broadcast(JSON.stringify({ type: 'auction:accepted', auctionId: id, winnerId: topBid.bidderId, amount: Number(topBid.amount) }));
        await NotificationModel.create({ id: nanoid(12), userId: topBid.bidderId, type: 'offer:accepted', payload: { auctionId: id, amount: Number(topBid.amount) }, read: false });
        // Email buyer & seller (best-effort)
        const buyerEmail = await getUserEmail(topBid.bidderId);
        const sellerEmail = await getUserEmail(a.sellerId);
        const html = buildInvoiceHtml({ auctionTitle: a.title, amount: Number(topBid.amount), buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: a.id });
        if (buyerEmail)
            await sendEmail(buyerEmail, `You won: ${a.title}`, `You won auction ${a.title} for $${Number(topBid.amount).toFixed(2)}`, { html });
        if (sellerEmail)
            await sendEmail(sellerEmail, `Sold: ${a.title}`, `Your auction ${a.title} sold for $${Number(topBid.amount).toFixed(2)}`, { html });
        // SMS (best-effort)
        const buyerPhone = await getUserPhone(topBid.bidderId);
        const sellerPhone = await getUserPhone(a.sellerId);
        if (buyerPhone)
            await sendSms(buyerPhone, `You won ${a.title} for $${Number(topBid.amount).toFixed(2)}`);
        if (sellerPhone)
            await sendSms(sellerPhone, `Sold ${a.title} for $${Number(topBid.amount).toFixed(2)}`);
        return { ok: true };
    }
    if (parsed.data.action === 'reject') {
        a.status = 'closed';
        await a.save();
        broadcast(JSON.stringify({ type: 'auction:rejected', auctionId: id }));
        await NotificationModel.create({ id: nanoid(12), userId: topBid.bidderId, type: 'offer:rejected', payload: { auctionId: id }, read: false });
        return { ok: true };
    }
    // counter
    if (!parsed.data.amount)
        return reply.badRequest('Counter amount required');
    const c = await CounterOfferModel.create({ id: nanoid(12), auctionId: id, sellerId: userId, buyerId: topBid.bidderId, amount: parsed.data.amount });
    broadcast(JSON.stringify({ type: 'offer:counter', auctionId: id, amount: parsed.data.amount, buyerId: topBid.bidderId }));
    try {
        await redisForBids?.publish?.('ws:broadcast', JSON.stringify({ type: 'offer:counter', auctionId: id, amount: parsed.data.amount, buyerId: topBid.bidderId }));
    }
    catch { }
    await NotificationModel.create({ id: nanoid(12), userId: topBid.bidderId, type: 'offer:counter', payload: { auctionId: id, amount: parsed.data.amount }, read: false });
    return { ok: true };
});
const CounterReplySchema = z.object({ accept: z.boolean() });
app.post('/api/counter/:id/reply', async (req, reply) => {
    const userId = await getUserId(req);
    if (!userId)
        return reply.unauthorized('Missing user');
    if (USE_SUPABASE_REST) {
        const out = await supaRepo.counterReply(req.params.id, userId, !!req.body.accept);
        if (out.status === 200) {
            if (req.body.accept) {
                const aTitle = out.body?.auctionTitle || 'Auction';
                const amount = Number(out.body?.amount);
                const sellerEmail = await getUserEmail(out.body?.sellerId);
                const buyerEmail = await getUserEmail(userId);
                const html = buildInvoiceHtml({ auctionTitle: aTitle, amount, buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: out.body?.auctionId || '' });
                if (buyerEmail)
                    await sendEmail(buyerEmail, `Offer accepted: ${aTitle}`, `Seller accepted at $${amount.toFixed(2)}`, { html });
                if (sellerEmail)
                    await sendEmail(sellerEmail, `You accepted: ${aTitle}`, `You accepted the offer at $${amount.toFixed(2)}`, { html });
                const msg = JSON.stringify({ type: 'offer:accepted', auctionId: out.body?.auctionId, amount });
                broadcast(msg);
                try {
                    await redisForBids?.publish?.('ws:broadcast', msg);
                }
                catch { }
            }
            else {
                const msg = JSON.stringify({ type: 'offer:rejected', auctionId: out.body?.auctionId });
                broadcast(msg);
                try {
                    await redisForBids?.publish?.('ws:broadcast', msg);
                }
                catch { }
            }
        }
        return reply.code(out.status).send(out.body);
    }
    if (!sequelize)
        return reply.internalServerError('DB not configured');
    const { id } = req.params;
    const parsed = CounterReplySchema.safeParse(req.body);
    if (!parsed.success)
        return reply.badRequest(parsed.error.message);
    const offer = await CounterOfferModel.findByPk(id);
    if (!offer)
        return reply.notFound('Not found');
    if (offer.buyerId !== userId)
        return reply.forbidden('Not buyer');
    const a = await AuctionModel.findByPk(offer.auctionId);
    if (!a)
        return reply.notFound('Auction not found');
    if (parsed.data.accept) {
        offer.status = 'accepted';
        await offer.save();
        a.currentPrice = offer.amount;
        a.status = 'closed';
        await a.save();
        broadcast(JSON.stringify({ type: 'offer:accepted', auctionId: a.id, amount: Number(offer.amount) }));
        try {
            await redisForBids?.publish?.('ws:broadcast', JSON.stringify({ type: 'offer:accepted', auctionId: a.id, amount: Number(offer.amount) }));
        }
        catch { }
        // Email buyer & seller
        const buyerEmail = await getUserEmail(offer.buyerId);
        const sellerEmail = await getUserEmail(offer.sellerId);
        const html = buildInvoiceHtml({ auctionTitle: a.title, amount: Number(offer.amount), buyerEmail: buyerEmail || 'buyer', sellerEmail: sellerEmail || 'seller', auctionId: a.id });
        if (buyerEmail)
            await sendEmail(buyerEmail, `Offer accepted: ${a.title}`, `Seller accepted at $${Number(offer.amount).toFixed(2)}`, { html });
        if (sellerEmail)
            await sendEmail(sellerEmail, `You accepted: ${a.title}`, `You accepted the offer at $${Number(offer.amount).toFixed(2)}`, { html });
        const buyerPhone = await getUserPhone(offer.buyerId);
        const sellerPhone = await getUserPhone(offer.sellerId);
        if (buyerPhone)
            await sendSms(buyerPhone, `Seller accepted your offer for ${a.title} at $${Number(offer.amount).toFixed(2)}`);
        if (sellerPhone)
            await sendSms(sellerPhone, `You accepted buyer offer for ${a.title} at $${Number(offer.amount).toFixed(2)}`);
    }
    else {
        offer.status = 'rejected';
        await offer.save();
        a.status = 'closed';
        await a.save();
        broadcast(JSON.stringify({ type: 'offer:rejected', auctionId: a.id }));
        try {
            await redisForBids?.publish?.('ws:broadcast', JSON.stringify({ type: 'offer:rejected', auctionId: a.id }));
        }
        catch { }
    }
    return { ok: true };
});
// HTTP server + WS
let wss = null;
function broadcast(data) {
    if (!wss)
        return;
    wss.clients.forEach((client) => {
        if (client.readyState === 1 /* OPEN */)
            client.send(data);
    });
}
await app.listen({ port: PORT, host: '0.0.0.0' });
wss = new WebSocketServer({ server: app.server });
wss.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hello', at: new Date().toISOString() }));
});
// Subscribe to cross-instance WS broadcast if Redis supports it
try {
    await redisForBids?.subscribe?.('ws:broadcast', (message) => {
        broadcast(message);
    });
}
catch { }
// SPA fallback: serve index.html for unmatched GET routes (except API/health)
try {
    app.get('/*', async (req, reply) => {
        const url = req.url;
        if (url.startsWith('/api') || url.startsWith('/health') || url.startsWith('/ws'))
            return reply.notFound();
        // fastify-static decorates reply with sendFile
        if (typeof reply.sendFile === 'function') {
            return reply.sendFile('index.html');
        }
        return reply.notFound();
    });
}
catch { }
app.log.info(`Server listening on http://localhost:${PORT}`);
// Background: end auctions whose time passed
if (sequelize) {
    setInterval(async () => {
        const now = new Date();
        try {
            const rows = await AuctionModel.findAll({ where: { status: 'live' } });
            for (const r of rows) {
                if (new Date(r.endsAt) <= now) {
                    r.status = 'ended';
                    await r.save();
                    broadcast(JSON.stringify({ type: 'auction:ended', auctionId: r.id, final: Number(r.currentPrice) }));
                    await NotificationModel.create({ id: nanoid(12), userId: r.sellerId, type: 'auction:ended', payload: { auctionId: r.id, final: Number(r.currentPrice) }, read: false });
                }
            }
        }
        catch (e) {
            app.log.error(e);
        }
    }, 5000).unref();
}
