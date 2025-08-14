import { Redis as UpstashRedis } from '@upstash/redis'

export type RedisLike = {
  hgetall(key: string): Promise<Record<string, string> | null>
  hset(key: string, value: Record<string, string | number>): Promise<void>
  get(key: string): Promise<string | null>
  set(key: string, value: string, opts?: { ex?: number }): Promise<void>
  publish?(channel: string, message: string): Promise<void>
  subscribe?(channel: string, handler: (message: string) => void): Promise<void>
  quit(): Promise<void>
}

let nodeClient: any | null = null
let nodeSubscriber: any | null = null
let restClient: UpstashRedis | null = null

export async function initRedis(): Promise<RedisLike | null> {
  const url = process.env.REDIS_URL
  const restUrl = process.env.UPSTASH_REDIS_REST_URL
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN

  if (url) {
    try {
  // @ts-ignore - optional dependency resolved at runtime in Docker
  const mod = await import('redis') as any
      const createClient: any = mod.createClient
      nodeClient = createClient({ url })
  nodeClient.on('error', (err: any) => {
        // eslint-disable-next-line no-console
        console.error('[redis] node client error', err)
      })
      await nodeClient.connect()
      return nodeWrapper
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[redis] node client connection failed, falling back to REST if available:', (e as any)?.message)
    }
  }

  if (restUrl && restToken) {
    restClient = new UpstashRedis({ url: restUrl, token: restToken })
    return restWrapper
  }
  return null
}

export function redisInfo() {
  if (nodeClient) return { type: 'node', url: process.env.REDIS_URL }
  if (restClient) {
    try { return { type: 'rest', urlHost: new URL(process.env.UPSTASH_REDIS_REST_URL || '').host } } catch {}
  }
  return { type: 'none' }
}

const nodeWrapper: RedisLike = {
  async hgetall(key) {
    if (!nodeClient) return null
    const flat = await nodeClient.hGetAll(key)
    return Object.keys(flat).length ? (flat as any) : null
  },
  async hset(key, value) {
    if (!nodeClient) return
    await nodeClient.hSet(key, value as any)
  },
  async get(key) {
    if (!nodeClient) return null
    return (await nodeClient.get(key)) as any
  },
  async set(key, value, opts) {
    if (!nodeClient) return
    if (opts?.ex) await nodeClient.set(key, value, { EX: opts.ex })
    else await nodeClient.set(key, value)
  },
  async publish(channel, message) {
    if (!nodeClient) return
    await nodeClient.publish(channel, message)
  },
  async subscribe(channel, handler) {
    if (!nodeClient) return
  if (!nodeSubscriber) nodeSubscriber = nodeClient.duplicate()
    if (!nodeSubscriber.isOpen) await nodeSubscriber.connect()
  await nodeSubscriber.subscribe(channel, (m: string) => handler(m))
  },
  async quit() {
    try { if (nodeSubscriber) await nodeSubscriber.quit() } catch {}
    try { if (nodeClient) await nodeClient.quit() } catch {}
  }
}

const restWrapper: RedisLike = {
  async hgetall(key) {
    if (!restClient) return null
    const res = await restClient.hgetall<Record<string, string>>(key)
    return res as any
  },
  async hset(key, value) {
    if (!restClient) return
    await restClient.hset(key, value as any)
  },
  async get(key) {
    if (!restClient) return null
    return (await restClient.get<string>(key)) as any
  },
  async set(key, value, opts) {
    if (!restClient) return
    if (opts?.ex) await restClient.set(key, value, { ex: opts.ex })
    else await restClient.set(key, value)
  },
  async quit() { /* no-op for REST */ },
}
