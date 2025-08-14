import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { Redis } from '@upstash/redis'
import { nanoid } from 'nanoid'

export type Auction = {
  id: string
  title: string
  description?: string
  startingPrice: number
  currentPrice: number
  endsAt: string
  createdAt: string
}

export type CreateAuctionInput = {
  title: string
  description?: string
  startingPrice: number
  durationMinutes: number
}

export interface IStore {
  listAuctions(): Promise<Auction[]>
  createAuction(input: CreateAuctionInput): Promise<Auction>
  getAuction(id: string): Promise<Auction | null>
  tryPlaceBid(id: string, amount: number, userId: string): Promise<{ ok: true } | { ok: false; reason: string }>
}

class MemoryStore implements IStore {
  private map = new Map<string, Auction>()
  async listAuctions(): Promise<Auction[]> {
    return Array.from(this.map.values())
  }
  async createAuction(input: CreateAuctionInput): Promise<Auction> {
    const now = new Date()
    const ends = new Date(now.getTime() + input.durationMinutes * 60_000)
    const auction: Auction = {
      id: nanoid(12),
      title: input.title,
      description: input.description,
      startingPrice: input.startingPrice,
      currentPrice: input.startingPrice,
      endsAt: ends.toISOString(),
      createdAt: now.toISOString(),
    }
    this.map.set(auction.id, auction)
    return auction
  }
  async getAuction(id: string): Promise<Auction | null> {
    return this.map.get(id) ?? null
  }
  async tryPlaceBid(id: string, amount: number, _userId: string) {
    const a = this.map.get(id)
    if (!a) return { ok: false as const, reason: 'not_found' }
    if (new Date().toISOString() > a.endsAt) return { ok: false as const, reason: 'ended' }
    if (amount <= a.currentPrice) return { ok: false as const, reason: 'low' }
    a.currentPrice = amount
    this.map.set(id, a)
    return { ok: true as const }
  }
}

class RedisStore implements IStore {
  constructor(private redis: Redis) {}
  async listAuctions(): Promise<Auction[]> {
  const ids: string[] = (await this.redis.smembers('auctions:index') as any) || []
    const items: Auction[] = []
    for (const id of ids) {
  const r = await this.redis.hgetall(`auction:${id}`) as Record<string, string> | null
      if (r) {
        items.push({
          ...r as any,
          startingPrice: Number((r as any).startingPrice),
          currentPrice: Number((r as any).currentPrice),
        } as any)
      }
    }
    return items
  }
  async createAuction(input: CreateAuctionInput): Promise<Auction> {
    const now = new Date()
    const ends = new Date(now.getTime() + input.durationMinutes * 60_000)
    const auction: Auction = {
      id: nanoid(12),
      title: input.title,
      description: input.description,
      startingPrice: input.startingPrice,
      currentPrice: input.startingPrice,
      endsAt: ends.toISOString(),
      createdAt: now.toISOString(),
    }
    await this.redis.hset(`auction:${auction.id}`, auction as any)
    await this.redis.sadd('auctions:index', auction.id)
    return auction
  }
  async getAuction(id: string): Promise<Auction | null> {
    const r = await this.redis.hgetall<Record<string, string>>(`auction:${id}`)
    if (!r) return null
    return {
      ...(r as any),
      startingPrice: Number((r as any).startingPrice),
      currentPrice: Number((r as any).currentPrice),
    } as any
  }
  async tryPlaceBid(id: string, amount: number, userId: string) {
    const key = `auction:${id}`
    const lockKey = `lock:${key}`
    const lock = await this.redis.set(lockKey, userId, { nx: true, ex: 5 })
    if (!lock) return { ok: false as const, reason: 'locked' }
    try {
      const r = await this.redis.hgetall<Record<string, string>>(key)
      if (!r) return { ok: false as const, reason: 'not_found' }
      const nowIso = new Date().toISOString()
      if (nowIso > (r as any).endsAt) return { ok: false as const, reason: 'ended' }
      const current = Number((r as any).currentPrice)
      if (amount <= current) return { ok: false as const, reason: 'low' }
      await this.redis.hset(key, { currentPrice: amount })
      return { ok: true as const }
    } finally {
      await this.redis.del(lockKey)
    }
  }
}

class SupabaseStore implements IStore {
  constructor(private sb: SupabaseClient) {}
  async listAuctions(): Promise<Auction[]> {
    const { data, error } = await this.sb
      .from('auctions')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return (data || []).map((r: any) => ({
      id: r.id,
      title: r.title,
      description: r.description ?? undefined,
      startingPrice: Number(r.starting_price),
      currentPrice: Number(r.current_price),
      endsAt: new Date(r.ends_at).toISOString(),
      createdAt: new Date(r.created_at).toISOString(),
    }))
  }
  async createAuction(input: CreateAuctionInput): Promise<Auction> {
    const now = new Date()
    const ends = new Date(now.getTime() + input.durationMinutes * 60_000)
    const row = {
      id: nanoid(12),
      title: input.title,
      description: input.description ?? null,
      starting_price: input.startingPrice,
      current_price: input.startingPrice,
      ends_at: ends.toISOString(),
    }
    const { data, error } = await this.sb
      .from('auctions')
      .insert(row)
      .select('*')
      .single()
    if (error) throw error
    return {
      id: data.id,
      title: data.title,
      description: data.description ?? undefined,
      startingPrice: Number(data.starting_price),
      currentPrice: Number(data.current_price),
      endsAt: new Date(data.ends_at).toISOString(),
      createdAt: new Date(data.created_at).toISOString(),
    }
  }
  async getAuction(id: string): Promise<Auction | null> {
    const { data, error } = await this.sb
      .from('auctions')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw error
    if (!data) return null
    return {
      id: data.id,
      title: data.title,
      description: data.description ?? undefined,
      startingPrice: Number(data.starting_price),
      currentPrice: Number(data.current_price),
      endsAt: new Date(data.ends_at).toISOString(),
      createdAt: new Date(data.created_at).toISOString(),
    }
  }
  async tryPlaceBid(id: string, amount: number, userId: string) {
    const { data, error } = await this.sb
      .from('auctions')
      .update({ current_price: amount })
      .gt('ends_at', new Date().toISOString())
      .lt('current_price', amount)
      .eq('id', id)
      .select('id')
      .single()
    if (error && (error as any).code !== 'PGRST116') {
      return { ok: false as const, reason: 'conflict' }
    }
    if (!data) return { ok: false as const, reason: 'low_or_ended' }
    await this.sb.from('bids').insert({ auction_id: id, user_id: userId, amount })
    return { ok: true as const }
  }
}

export function createStore(): IStore {
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    return new SupabaseStore(sb)
  }

  const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL
  const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })
    return new RedisStore(redis)
  }

  return new MemoryStore()
}
