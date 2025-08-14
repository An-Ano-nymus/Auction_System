import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

const API_BASE = import.meta.env.VITE_API_BASE || '/'
const WS_URL = import.meta.env.VITE_WS_URL || (location.origin.replace('http', 'ws'))
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY

const sb = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null

function useCountdown(targetIso: string) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const ends = useMemo(() => new Date(targetIso).getTime(), [targetIso])
  const ms = Math.max(0, ends - now)
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 1000 / 60) % 60
  const h = Math.floor(ms / 1000 / 60 / 60)
  return { h, m, s, done: ms === 0 }
}

export function App() {
  const [items, setItems] = useState<any[]>([])
  const [title, setTitle] = useState('')
  const [startingPrice, setStartingPrice] = useState(0)
  const [durationMinutes, setDurationMinutes] = useState(10)
  const [bidIncrement, setBidIncrement] = useState(1)
  const [goLiveAt, setGoLiveAt] = useState<string>(() => new Date(Date.now() + 60_000).toISOString().slice(0,16))
  const [session, setSession] = useState<any>(null)
  const [email, setEmail] = useState('')

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (session?.access_token) headers['authorization'] = `Bearer ${session.access_token}`
    else headers['x-user-id'] = 'dev_' + (session?.user?.id || 'guest') // dev fallback
    return headers
  }, [session])

  async function load() {
    const res = await fetch(`${API_BASE}/api/auctions`)
    const data = await res.json()
    setItems(data.items)
  }

  useEffect(() => {
    load()
  }, [])

  // Supabase session
  useEffect(() => {
    if (!sb) return
    sb.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = sb.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  async function signIn(e: React.FormEvent) {
    e.preventDefault()
    if (!sb) return alert('Supabase not configured')
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin } })
    if (error) alert(error.message)
    else alert('Check your email for the login link')
  }
  async function signOut() {
    if (!sb) return
    await sb.auth.signOut()
  }

  // WebSocket live updates
  const wsRef = useRef<WebSocket | null>(null)
  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'bid:accepted') {
        setItems((prev) => prev.map((a) => a.id === msg.auctionId ? { ...a, currentPrice: msg.amount } : a))
      }
    }
    wsRef.current = ws
    return () => ws.close()
  }, [])

  async function createAuction(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch(`${API_BASE}/api/auctions`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title, startingPrice, durationMinutes, bidIncrement, goLiveAt: new Date(goLiveAt).toISOString() })
    })
    if (res.ok) {
      setTitle('')
      setStartingPrice(0)
      setBidIncrement(1)
      load()
    } else {
      const t = await res.text(); alert(t)
    }
  }

  async function placeBid(id: string, amount: number) {
    const res = await fetch(`${API_BASE}/api/auctions/${id}/bids`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ amount })
    })
    if (!res.ok) alert(await res.text())
  }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0 }}>Realtime Auctions</h1>
        <div>
          {sb ? (
            session ? (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ opacity: 0.7 }}>{session.user.email || session.user.id}</span>
                <button onClick={signOut}>Sign out</button>
              </div>
            ) : (
              <form onSubmit={signIn} style={{ display: 'flex', gap: 8 }}>
                <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <button>Sign in</button>
              </form>
            )
          ) : (
            <span style={{ opacity: 0.6 }}>Dev mode (no auth)</span>
          )}
        </div>
      </header>

      <section style={{ border: '1px solid #eee', padding: 16, borderRadius: 8, marginBottom: 24 }}>
        <h3 style={{ marginTop: 0 }}>Create auction</h3>
        <form onSubmit={createAuction} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 120px 220px 120px', gap: 8, alignItems: 'center' }}>
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <input type="number" placeholder="Starting" value={startingPrice} onChange={(e) => setStartingPrice(Number(e.target.value))} />
          <input type="number" placeholder="Increment" value={bidIncrement} onChange={(e) => setBidIncrement(Number(e.target.value))} />
          <input type="datetime-local" value={goLiveAt} onChange={(e) => setGoLiveAt(e.target.value)} />
          <input type="number" placeholder="Minutes" value={durationMinutes} onChange={(e) => setDurationMinutes(Number(e.target.value))} />
          <button>Create</button>
        </form>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
        {items.map((a) => {
          const { h, m, s, done } = useCountdown(a.endsAt)
          return (
            <article key={a.id} style={{ border: '1px solid #e5e5e5', borderRadius: 10, padding: 16, boxShadow: '0 1px 2px rgba(0,0,0,0.04)', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3 style={{ margin: 0 }}>{a.title}</h3>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{done ? 'Ended' : `Ends in ${h}h ${m}m ${s}s`}</span>
              </div>
              <div style={{ fontSize: 18 }}>
                Current: <strong>${Number(a.currentPrice).toFixed(2)}</strong>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={done} onClick={() => placeBid(a.id, Number(a.currentPrice) + 1)}>Bid +1</button>
                <button disabled={done} onClick={() => placeBid(a.id, Number(a.currentPrice) + 5)}>Bid +5</button>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}
