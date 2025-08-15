import { createClient } from '@supabase/supabase-js'
import { nanoid } from 'nanoid'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  // eslint-disable-next-line no-console
  console.warn('[supaRepo] SUPABASE_URL or SUPABASE_KEY missing—provider disabled')
}

export const supa = (SUPABASE_URL && SUPABASE_SERVICE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null

export type HttpResult = { status: number; body: any }

export async function createAuction(body: any, sellerId: string): Promise<HttpResult> {
  if (!supa) return { status: 500, body: 'Supabase not configured' }
  const now = new Date(body.goLiveAt)
  const ends = new Date(now.getTime() + body.durationMinutes * 60_000)
  const createdAt = new Date()
  const row = {
    id: nanoid(12),
    sellerId,
    title: body.title,
    description: body.description ?? null,
    startingPrice: body.startingPrice,
    bidIncrement: body.bidIncrement,
    goLiveAt: now.toISOString(),
    endsAt: ends.toISOString(),
    currentPrice: body.startingPrice,
    status: new Date() >= now ? 'live' : 'scheduled',
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
  }
  const { data, error } = await supa.from('auctions').insert(row).select().single()
  if (error) return { status: 500, body: error.message }
  return { status: 201, body: data }
}

export async function listAuctions(filters?: { status?: string | string[]; offset?: number; limit?: number }): Promise<HttpResult> {
  if (!supa) return { status: 200, body: { items: [] } }
  let q = supa.from('auctions').select('*')
  if (filters?.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : String(filters.status).split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length === 1) q = q.eq('status', statuses[0])
    else if (statuses.length > 1) q = (q as any).in('status', statuses)
  }
  q = q.order('createdAt', { ascending: false })
  if (typeof filters?.offset === 'number' && typeof filters?.limit === 'number' && filters.limit > 0) {
    const start = Math.max(0, filters.offset)
    const end = start + filters.limit - 1
    q = q.range(start, end)
  }
  const { data, error } = await q
  if (error) return { status: 500, body: error.message }
  return { status: 200, body: { items: data } }
}

export async function listAuctionsBySeller(sellerId: string): Promise<HttpResult> {
  if (!supa) return { status: 200, body: { items: [] } }
  const { data, error } = await supa.from('auctions').select('*').eq('sellerId', sellerId).order('createdAt', { ascending: false })
  if (error) return { status: 500, body: error.message }
  return { status: 200, body: { items: data } }
}

export async function getAuction(id: string): Promise<HttpResult> {
  if (!supa) return { status: 404, body: 'Not found' }
  const { data, error } = await supa.from('auctions').select('*').eq('id', id).single()
  if (error || !data) return { status: 404, body: 'Not found' }
  return { status: 200, body: data }
}

export async function listBids(id: string, filters?: { offset?: number; limit?: number }): Promise<HttpResult> {
  if (!supa) return { status: 200, body: { items: [] } }
  let q = supa.from('bids').select('*').eq('auctionId', id).order('createdAt', { ascending: false })
  if (typeof filters?.offset === 'number' && typeof filters?.limit === 'number' && filters.limit > 0) {
    const start = Math.max(0, filters.offset)
    const end = start + filters.limit - 1
    q = q.range(start, end)
  }
  const { data, error } = await q
  if (error) return { status: 500, body: error.message }
  return { status: 200, body: { items: data } }
}

export async function placeBid(auctionId: string, userId: string, amount: number): Promise<HttpResult> {
  if (!supa) return { status: 500, body: 'Supabase not configured' }
  const { data: a, error: e1 } = await supa.from('auctions').select('id,currentPrice,bidIncrement,endsAt,status,sellerId,title').eq('id', auctionId).single()
  if (e1 || !a) return { status: 404, body: 'Auction not found' }
  const nowIso = new Date().toISOString()
  if (a.status === 'closed' || nowIso > a.endsAt) return { status: 409, body: 'Auction ended' }
  const step = Number(a.bidIncrement)
  const { data: updated, error: e2 } = await supa
    .from('auctions')
    .update({ currentPrice: amount })
    .eq('id', auctionId)
    .lte('currentPrice', amount - step)
    .gt('endsAt', nowIso)
    .neq('status', 'closed')
    .select()
  if (e2) return { status: 500, body: e2.message }
  if (!updated || updated.length === 0) return { status: 409, body: 'Bid too low or auction ended' }
  const { error: e3 } = await supa.from('bids').insert({ id: nanoid(12), auctionId, bidderId: userId, amount, createdAt: new Date().toISOString() })
  if (e3) return { status: 500, body: e3.message }
  const notify: Array<{ userId: string; type: string; payload: any }> = []
  // Notify seller of new bid
  if (a.sellerId) {
    const n1 = { id: nanoid(12), userId: a.sellerId, type: 'bid:new', payload: { auctionId, amount, bidderId: userId, title: a.title }, read: false }
    await supa.from('notifications').insert(n1)
    notify.push({ userId: a.sellerId, type: n1.type, payload: n1.payload })
  }
  // Notify previous highest bidder of outbid
  const { data: top2 } = await supa.from('bids').select('bidderId,amount').eq('auctionId', auctionId).order('amount', { ascending: false }).limit(2)
  const prev = (top2 || []).find((b: any) => b.bidderId !== userId)
  if (prev && prev.bidderId) {
    const n2 = { id: nanoid(12), userId: prev.bidderId, type: 'bid:outbid', payload: { auctionId, amount, title: a.title }, read: false }
    await supa.from('notifications').insert(n2)
    notify.push({ userId: prev.bidderId, type: n2.type, payload: n2.payload })
  }
  // Notify all prior bidders of update (excluding current)
  const { data: allBidders } = await supa.from('bids').select('bidderId').eq('auctionId', auctionId).neq('bidderId', userId)
  if (allBidders && allBidders.length) {
    const unique = Array.from(new Set(allBidders.map((b: any) => b.bidderId))) as string[]
    const recips = unique.slice(0, 100)
    const rows = recips.map((uid) => ({ id: nanoid(12), userId: uid, type: 'bid:update', payload: { auctionId, amount, title: a.title }, read: false }))
    if (rows.length) await supa.from('notifications').insert(rows)
    for (const uid of recips) notify.push({ userId: uid, type: 'bid:update', payload: { auctionId, amount, title: a.title } })
  }
  return { status: 201, body: { ok: true, notify } }
}

export async function endAuction(auctionId: string, sellerId: string): Promise<HttpResult> {
  if (!supa) return { status: 500, body: 'Supabase not configured' }
  const { data: a } = await supa.from('auctions').select('sellerId,currentPrice').eq('id', auctionId).single()
  if (!a) return { status: 404, body: 'Not found' }
  if (a.sellerId !== sellerId) return { status: 403, body: 'Not seller' }
  const { error } = await supa.from('auctions').update({ status: 'ended' }).eq('id', auctionId)
  if (error) return { status: 500, body: error.message }
  await supa.from('notifications').insert({ id: nanoid(12), userId: sellerId, type: 'auction:ended', payload: { auctionId, final: Number(a.currentPrice) }, read: false })
  return { status: 200, body: { ok: true } }
}

export async function decision(auctionId: string, sellerId: string, action: 'accept'|'reject'|'counter', amount?: number): Promise<HttpResult> {
  if (!supa) return { status: 500, body: 'Supabase not configured' }
  const { data: a } = await supa.from('auctions').select('*').eq('id', auctionId).single()
  if (!a) return { status: 404, body: 'Not found' }
  if (a.sellerId !== sellerId) return { status: 403, body: 'Not seller' }
  const { data: topBid } = await supa.from('bids').select('*').eq('auctionId', auctionId).order('amount', { ascending: false }).limit(1)
  const tb = topBid && topBid[0]
  if (!tb) return { status: 409, body: 'No bids' }
  if (action === 'accept') {
    await supa.from('auctions').update({ status: 'closed' }).eq('id', auctionId)
    await supa.from('notifications').insert({ id: nanoid(12), userId: tb.bidderId, type: 'offer:accepted', payload: { auctionId, amount: Number(tb.amount) }, read: false })
    return { status: 200, body: { ok: true, winnerId: tb.bidderId, amount: Number(tb.amount), sellerId, auctionTitle: a.title } }
  }
  if (action === 'reject') {
    await supa.from('auctions').update({ status: 'closed' }).eq('id', auctionId)
    await supa.from('notifications').insert({ id: nanoid(12), userId: tb.bidderId, type: 'offer:rejected', payload: { auctionId }, read: false })
    return { status: 200, body: { ok: true } }
  }
  if (!amount) return { status: 400, body: 'Counter amount required' }
  const { data: counter, error: ce } = await supa.from('counter_offers').insert({ id: nanoid(12), auctionId, sellerId, buyerId: tb.bidderId, amount, status: 'pending' }).select().single()
  if (ce) return { status: 500, body: ce.message }
  await supa.from('notifications').insert({ id: nanoid(12), userId: tb.bidderId, type: 'offer:counter', payload: { auctionId, amount, counterId: counter.id }, read: false })
  return { status: 200, body: { ok: true, counterId: counter.id } }
}

export async function counterReply(counterId: string, userId: string, accept: boolean): Promise<HttpResult> {
  if (!supa) return { status: 500, body: 'Supabase not configured' }
  const { data: c } = await supa.from('counter_offers').select('*').eq('id', counterId).single()
  if (!c) return { status: 404, body: 'Not found' }
  if (c.buyerId !== userId) return { status: 403, body: 'Not buyer' }
  const { data: a } = await supa.from('auctions').select('*').eq('id', c.auctionId).single()
  if (!a) return { status: 404, body: 'Auction not found' }
  if (accept) {
    await supa.from('counter_offers').update({ status: 'accepted' }).eq('id', counterId)
    await supa.from('auctions').update({ currentPrice: c.amount, status: 'closed' }).eq('id', c.auctionId)
  // Notify buyer (current user) and seller of acceptance
  await supa.from('notifications').insert({ id: nanoid(12), userId: c.buyerId, type: 'offer:accepted', payload: { auctionId: c.auctionId, amount: Number(c.amount) }, read: false })
  await supa.from('notifications').insert({ id: nanoid(12), userId: a.sellerId, type: 'offer:accepted', payload: { auctionId: c.auctionId, amount: Number(c.amount) }, read: false })
    return { status: 200, body: { ok: true, amount: Number(c.amount), auctionId: c.auctionId, sellerId: a.sellerId, auctionTitle: a.title } }
  } else {
    await supa.from('counter_offers').update({ status: 'rejected' }).eq('id', counterId)
    await supa.from('auctions').update({ status: 'closed' }).eq('id', c.auctionId)
  // Notify buyer of rejection
  await supa.from('notifications').insert({ id: nanoid(12), userId: c.buyerId, type: 'offer:rejected', payload: { auctionId: c.auctionId }, read: false })
    return { status: 200, body: { ok: true, auctionId: c.auctionId, sellerId: a.sellerId } }
  }
}

export async function startAuction(auctionId: string, minutes: number): Promise<HttpResult> {
  if (!supa) return { status: 500, body: 'Supabase not configured' }
  const { data: a } = await supa.from('auctions').select('*').eq('id', auctionId).single()
  if (!a) return { status: 404, body: 'Not found' }
  const now = new Date()
  const ends = new Date(now.getTime() + minutes * 60_000)
  const { error } = await supa.from('auctions').update({ goLiveAt: now.toISOString(), endsAt: ends.toISOString(), status: 'live' }).eq('id', auctionId)
  if (error) return { status: 500, body: error.message }
  return { status: 200, body: { ok: true, endsAt: ends.toISOString() } }
}

export async function resetAuction(auctionId: string, minutes: number): Promise<HttpResult> {
  if (!supa) return { status: 500, body: 'Supabase not configured' }
  const { data: a } = await supa.from('auctions').select('*').eq('id', auctionId).single()
  if (!a) return { status: 404, body: 'Not found' }
  const now = new Date()
  const ends = new Date(now.getTime() + minutes * 60_000)
  const { error } = await supa.from('auctions').update({ currentPrice: a.startingPrice, goLiveAt: now.toISOString(), endsAt: ends.toISOString(), status: 'scheduled' }).eq('id', auctionId)
  if (error) return { status: 500, body: error.message }
  return { status: 200, body: { ok: true, endsAt: ends.toISOString() } }
}

export async function getTopBid(auctionId: string): Promise<{ bidderId: string; amount: number } | null> {
  if (!supa) return null
  const { data: rows } = await supa.from('bids').select('bidderId,amount').eq('auctionId', auctionId).order('amount', { ascending: false }).limit(1)
  const tb = rows && rows[0]
  return tb ? { bidderId: tb.bidderId, amount: Number(tb.amount) } : null
}

export async function listNotifications(userId: string): Promise<HttpResult> {
  if (!supa) return { status: 200, body: { items: [] } }
  const { data, error } = await supa.from('notifications').select('*').eq('userId', userId).order('createdAt', { ascending: false }).limit(50)
  if (error) return { status: 500, body: error.message }
  return { status: 200, body: { items: data } }
}
