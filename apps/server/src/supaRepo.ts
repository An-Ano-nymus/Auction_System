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
    status: new Date() >= now ? 'live' : 'scheduled'
  }
  const { data, error } = await supa.from('auctions').insert(row).select().single()
  if (error) return { status: 500, body: error.message }
  return { status: 201, body: data }
}

export async function listAuctions(): Promise<HttpResult> {
  if (!supa) return { status: 200, body: { items: [] } }
  const { data, error } = await supa.from('auctions').select('*').order('createdAt', { ascending: false })
  if (error) return { status: 500, body: error.message }
  return { status: 200, body: { items: data } }
}

export async function getAuction(id: string): Promise<HttpResult> {
  if (!supa) return { status: 404, body: 'Not found' }
  const { data, error } = await supa.from('auctions').select('*').eq('id', id).single()
  if (error || !data) return { status: 404, body: 'Not found' }
  return { status: 200, body: data }
}

export async function listBids(id: string): Promise<HttpResult> {
  if (!supa) return { status: 200, body: { items: [] } }
  const { data, error } = await supa.from('bids').select('*').eq('auctionId', id).order('createdAt', { ascending: false })
  if (error) return { status: 500, body: error.message }
  return { status: 200, body: { items: data } }
}

export async function placeBid(auctionId: string, userId: string, amount: number): Promise<HttpResult> {
  if (!supa) return { status: 500, body: 'Supabase not configured' }
  const { data: a, error: e1 } = await supa.from('auctions').select('id,currentPrice,bidIncrement,endsAt,status').eq('id', auctionId).single()
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
  await supa.from('bids').insert({ id: nanoid(12), auctionId, bidderId: userId, amount })
  const { data: last } = await supa.from('bids').select('bidderId').eq('auctionId', auctionId).order('createdAt', { ascending: false }).limit(1)
  if (last && last[0] && last[0].bidderId !== userId) {
    await supa.from('notifications').insert({ id: nanoid(12), userId: last[0].bidderId, type: 'bid:outbid', payload: { auctionId, amount }, read: false })
  }
  return { status: 201, body: { ok: true } }
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
    return { status: 200, body: { ok: true, winnerId: tb.bidderId, amount: Number(tb.amount) } }
  }
  if (action === 'reject') {
    await supa.from('auctions').update({ status: 'closed' }).eq('id', auctionId)
    await supa.from('notifications').insert({ id: nanoid(12), userId: tb.bidderId, type: 'offer:rejected', payload: { auctionId }, read: false })
    return { status: 200, body: { ok: true } }
  }
  if (!amount) return { status: 400, body: 'Counter amount required' }
  await supa.from('counter_offers').insert({ id: nanoid(12), auctionId, sellerId, buyerId: tb.bidderId, amount, status: 'pending' })
  await supa.from('notifications').insert({ id: nanoid(12), userId: tb.bidderId, type: 'offer:counter', payload: { auctionId, amount }, read: false })
  return { status: 200, body: { ok: true } }
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
    return { status: 200, body: { ok: true, amount: Number(c.amount) } }
  } else {
    await supa.from('counter_offers').update({ status: 'rejected' }).eq('id', counterId)
    await supa.from('auctions').update({ status: 'closed' }).eq('id', c.auctionId)
    return { status: 200, body: { ok: true } }
  }
}
