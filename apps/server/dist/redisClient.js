import { Redis as UpstashRedis } from '@upstash/redis';
let nodeClient = null;
let nodeSubscriber = null;
let restClient = null;
export async function initRedis() {
    const url = process.env.REDIS_URL;
    const restUrl = process.env.UPSTASH_REDIS_REST_URL;
    const restToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url) {
        try {
            // @ts-ignore - optional dependency resolved at runtime in Docker
            const mod = await import('redis');
            const createClient = mod.createClient;
            nodeClient = createClient({ url });
            nodeClient.on('error', (err) => {
                // eslint-disable-next-line no-console
                console.error('[redis] node client error', err);
            });
            await nodeClient.connect();
            return nodeWrapper;
        }
        catch (e) {
            // eslint-disable-next-line no-console
            console.warn('[redis] node client connection failed, falling back to REST if available:', e?.message);
        }
    }
    if (restUrl && restToken) {
        restClient = new UpstashRedis({ url: restUrl, token: restToken });
        return restWrapper;
    }
    return null;
}
export function redisInfo() {
    if (nodeClient)
        return { type: 'node', url: process.env.REDIS_URL };
    if (restClient) {
        try {
            return { type: 'rest', urlHost: new URL(process.env.UPSTASH_REDIS_REST_URL || '').host };
        }
        catch { }
    }
    return { type: 'none' };
}
const nodeWrapper = {
    async hgetall(key) {
        if (!nodeClient)
            return null;
        const flat = await nodeClient.hGetAll(key);
        return Object.keys(flat).length ? flat : null;
    },
    async hset(key, value) {
        if (!nodeClient)
            return;
        await nodeClient.hSet(key, value);
    },
    async get(key) {
        if (!nodeClient)
            return null;
        return (await nodeClient.get(key));
    },
    async set(key, value, opts) {
        if (!nodeClient)
            return;
        if (opts?.ex)
            await nodeClient.set(key, value, { EX: opts.ex });
        else
            await nodeClient.set(key, value);
    },
    async publish(channel, message) {
        if (!nodeClient)
            return;
        await nodeClient.publish(channel, message);
    },
    async subscribe(channel, handler) {
        if (!nodeClient)
            return;
        if (!nodeSubscriber)
            nodeSubscriber = nodeClient.duplicate();
        if (!nodeSubscriber.isOpen)
            await nodeSubscriber.connect();
        await nodeSubscriber.subscribe(channel, (m) => handler(m));
    },
    async quit() {
        try {
            if (nodeSubscriber)
                await nodeSubscriber.quit();
        }
        catch { }
        try {
            if (nodeClient)
                await nodeClient.quit();
        }
        catch { }
    }
};
const restWrapper = {
    async hgetall(key) {
        if (!restClient)
            return null;
        const res = await restClient.hgetall(key);
        return res;
    },
    async hset(key, value) {
        if (!restClient)
            return;
        await restClient.hset(key, value);
    },
    async get(key) {
        if (!restClient)
            return null;
        return (await restClient.get(key));
    },
    async set(key, value, opts) {
        if (!restClient)
            return;
        if (opts?.ex)
            await restClient.set(key, value, { ex: opts.ex });
        else
            await restClient.set(key, value);
    },
    async quit() { },
};
