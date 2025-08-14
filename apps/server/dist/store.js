import { createClient } from '@supabase/supabase-js';
import { Redis } from '@upstash/redis';
import { nanoid } from 'nanoid';
class MemoryStore {
    map = new Map();
    async listAuctions() {
        return Array.from(this.map.values());
    }
    async createAuction(input) {
        const now = new Date();
        const ends = new Date(now.getTime() + input.durationMinutes * 60_000);
        const auction = {
            id: nanoid(12),
            title: input.title,
            description: input.description,
            startingPrice: input.startingPrice,
            currentPrice: input.startingPrice,
            endsAt: ends.toISOString(),
            createdAt: now.toISOString(),
        };
        this.map.set(auction.id, auction);
        return auction;
    }
    async getAuction(id) {
        return this.map.get(id) ?? null;
    }
    async tryPlaceBid(id, amount, _userId) {
        const a = this.map.get(id);
        if (!a)
            return { ok: false, reason: 'not_found' };
        if (new Date().toISOString() > a.endsAt)
            return { ok: false, reason: 'ended' };
        if (amount <= a.currentPrice)
            return { ok: false, reason: 'low' };
        a.currentPrice = amount;
        this.map.set(id, a);
        return { ok: true };
    }
}
class RedisStore {
    redis;
    constructor(redis) {
        this.redis = redis;
    }
    async listAuctions() {
        const ids = await this.redis.smembers('auctions:index') || [];
        const items = [];
        for (const id of ids) {
            const r = await this.redis.hgetall(`auction:${id}`);
            if (r) {
                items.push({
                    ...r,
                    startingPrice: Number(r.startingPrice),
                    currentPrice: Number(r.currentPrice),
                });
            }
        }
        return items;
    }
    async createAuction(input) {
        const now = new Date();
        const ends = new Date(now.getTime() + input.durationMinutes * 60_000);
        const auction = {
            id: nanoid(12),
            title: input.title,
            description: input.description,
            startingPrice: input.startingPrice,
            currentPrice: input.startingPrice,
            endsAt: ends.toISOString(),
            createdAt: now.toISOString(),
        };
        await this.redis.hset(`auction:${auction.id}`, auction);
        await this.redis.sadd('auctions:index', auction.id);
        return auction;
    }
    async getAuction(id) {
        const r = await this.redis.hgetall(`auction:${id}`);
        if (!r)
            return null;
        return {
            ...r,
            startingPrice: Number(r.startingPrice),
            currentPrice: Number(r.currentPrice),
        };
    }
    async tryPlaceBid(id, amount, userId) {
        const key = `auction:${id}`;
        const lockKey = `lock:${key}`;
        const lock = await this.redis.set(lockKey, userId, { nx: true, ex: 5 });
        if (!lock)
            return { ok: false, reason: 'locked' };
        try {
            const r = await this.redis.hgetall(key);
            if (!r)
                return { ok: false, reason: 'not_found' };
            const nowIso = new Date().toISOString();
            if (nowIso > r.endsAt)
                return { ok: false, reason: 'ended' };
            const current = Number(r.currentPrice);
            if (amount <= current)
                return { ok: false, reason: 'low' };
            await this.redis.hset(key, { currentPrice: amount });
            return { ok: true };
        }
        finally {
            await this.redis.del(lockKey);
        }
    }
}
class SupabaseStore {
    sb;
    constructor(sb) {
        this.sb = sb;
    }
    async listAuctions() {
        const { data, error } = await this.sb
            .from('auctions')
            .select('*')
            .order('created_at', { ascending: false });
        if (error)
            throw error;
        return (data || []).map((r) => ({
            id: r.id,
            title: r.title,
            description: r.description ?? undefined,
            startingPrice: Number(r.starting_price),
            currentPrice: Number(r.current_price),
            endsAt: new Date(r.ends_at).toISOString(),
            createdAt: new Date(r.created_at).toISOString(),
        }));
    }
    async createAuction(input) {
        const now = new Date();
        const ends = new Date(now.getTime() + input.durationMinutes * 60_000);
        const row = {
            id: nanoid(12),
            title: input.title,
            description: input.description ?? null,
            starting_price: input.startingPrice,
            current_price: input.startingPrice,
            ends_at: ends.toISOString(),
        };
        const { data, error } = await this.sb
            .from('auctions')
            .insert(row)
            .select('*')
            .single();
        if (error)
            throw error;
        return {
            id: data.id,
            title: data.title,
            description: data.description ?? undefined,
            startingPrice: Number(data.starting_price),
            currentPrice: Number(data.current_price),
            endsAt: new Date(data.ends_at).toISOString(),
            createdAt: new Date(data.created_at).toISOString(),
        };
    }
    async getAuction(id) {
        const { data, error } = await this.sb
            .from('auctions')
            .select('*')
            .eq('id', id)
            .maybeSingle();
        if (error)
            throw error;
        if (!data)
            return null;
        return {
            id: data.id,
            title: data.title,
            description: data.description ?? undefined,
            startingPrice: Number(data.starting_price),
            currentPrice: Number(data.current_price),
            endsAt: new Date(data.ends_at).toISOString(),
            createdAt: new Date(data.created_at).toISOString(),
        };
    }
    async tryPlaceBid(id, amount, userId) {
        const { data, error } = await this.sb
            .from('auctions')
            .update({ current_price: amount })
            .gt('ends_at', new Date().toISOString())
            .lt('current_price', amount)
            .eq('id', id)
            .select('id')
            .single();
        if (error && error.code !== 'PGRST116') {
            return { ok: false, reason: 'conflict' };
        }
        if (!data)
            return { ok: false, reason: 'low_or_ended' };
        await this.sb.from('bids').insert({ auction_id: id, user_id: userId, amount });
        return { ok: true };
    }
}
export function createStore() {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
        const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        return new SupabaseStore(sb);
    }
    const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (UPSTASH_URL && UPSTASH_TOKEN) {
        const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
        return new RedisStore(redis);
    }
    return new MemoryStore();
}
