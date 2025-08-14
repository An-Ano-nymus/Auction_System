import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'

// Robust URL helpers: avoid protocol-relative //api and trailing slashes
const RAW_API_BASE = (import.meta.env.VITE_API_BASE ?? '/') as string
const API_BASE = String(RAW_API_BASE).replace(/\/+$/, '') || '/'
const api = (p: string) => `${API_BASE === '/' ? '' : API_BASE}${p}`

function deriveWsUrl() {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined
  if (fromEnv) return fromEnv
  // If API_BASE is absolute (http[s]://), use that host; else decide by environment
  try {
    if (API_BASE && /^(http|https):\/\//.test(API_BASE)) {
      const u = new URL(API_BASE)
      return (u.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + u.host
    }
  } catch {}
  // Dev: Vite on :5173 with proxy → connect WS to backend :8080
  if (location.port === '5173') return 'ws://localhost:8080'
  // Prod same-origin
  return location.origin.replace('http', 'ws')
}
const WS_URL = deriveWsUrl()
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
  const [diag, setDiag] = useState<any | null>(null)
  const [me, setMe] = useState<{ id: string; isAdmin: boolean } | null>(null)
  const [notifications, setNotifications] = useState<any[]>([])
  const [adminAuctions, setAdminAuctions] = useState<any[]>([])

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (session?.access_token) headers['authorization'] = `Bearer ${session.access_token}`
    // Always include x-user-id as a fallback for non-auth flows
    headers['x-user-id'] = 'dev_' + (session?.user?.id || 'guest')
    return headers
  }, [session])

  async function load() {
    try {
      const res = await fetch(api('/api/auctions'))
      const data = await res.json()
      setItems(Array.isArray(data.items) ? data.items : [])
    } catch (e) {
      // backend may still be starting; degrade gracefully
      setItems([])
    }
  }

  async function loadMe() {
    try {
      const res = await fetch(api('/api/me'), { headers: authHeaders })
      if (res.ok) setMe(await res.json())
    } catch {}
  }

  async function loadNotifications() {
    try {
      const res = await fetch(api('/api/notifications'), { headers: authHeaders })
      if (res.ok) {
        const data = await res.json()
        setNotifications(data.items || [])
      }
    } catch {}
  }

  async function loadAdminAuctions() {
    try {
      const res = await fetch(api('/admin/auctions'), { headers: authHeaders })
      if (res.ok) {
        const data = await res.json()
        setAdminAuctions(data.items || [])
      }
    } catch {}
  }

  async function runDiagnostics() {
    try {
      const res = await fetch(api('/health/check'), {
        headers: session?.access_token
          ? { 'Authorization': `Bearer ${session.access_token}` }
          : { 'x-user-id': 'dev_admin' }
      })
      setDiag(await res.json())
    } catch (e) {
      setDiag({ ok: false, error: String(e) })
    }
  }

  useEffect(() => {
    load()
  loadMe()
  loadNotifications()
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
  const res = await fetch(api('/api/auctions'), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ title, startingPrice, durationMinutes, bidIncrement, goLiveAt: new Date(goLiveAt).toISOString() })
    })
    if (res.ok) {
      setTitle('')
      setStartingPrice(0)
      setBidIncrement(1)
      load()
  loadNotifications()
    } else {
      const t = await res.text(); alert(t)
    }
  }

  async function placeBid(id: string, amount: number) {
    const res = await fetch(api(`/api/auctions/${id}/bids`), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ amount })
    })
    if (!res.ok) alert(await res.text())
  }

  async function adminStart(id: string) {
    const res = await fetch(api(`/admin/auctions/${id}/start`), { method: 'POST', headers: authHeaders })
    if (res.ok) { loadAdminAuctions(); load() } else { alert(await res.text()) }
  }
  async function adminReset(id: string) {
    const res = await fetch(api(`/admin/auctions/${id}/reset`), { method: 'POST', headers: authHeaders })
    if (res.ok) { loadAdminAuctions(); load() } else { alert(await res.text()) }
  }

  return (
    <div style={{ fontFamily: 'Inter, system-ui, sans-serif', padding: 24, maxWidth: 1100, margin: '0 auto', background: 'linear-gradient(180deg,#f8fafc,#ffffff)' }}>
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
                <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
                  Email
                  <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                </label>
                <button>Sign in</button>
              </form>
            )
          ) : (
            <span style={{ opacity: 0.6 }}>Dev mode (no auth)</span>
          )}
        </div>
      </header>

      <section style={{ border: '1px solid #e6eaf0', padding: 16, borderRadius: 12, marginBottom: 24, background: '#fff', boxShadow: '0 8px 24px rgba(0,0,0,0.06)' }}>
        <h3 style={{ marginTop: 0 }}>Create auction</h3>
        <form onSubmit={createAuction} style={{ display: 'grid', gridTemplateColumns: '1fr 160px 160px 240px 140px 120px', gap: 12, alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
            Title
            <input placeholder="Vintage camera" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
            Starting Price
            <input type="number" min={0} step={1} placeholder="100" value={startingPrice} onChange={(e) => setStartingPrice(Number(e.target.value))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
            Bid Increment
            <input type="number" min={1} step={1} placeholder="5" value={bidIncrement} onChange={(e) => setBidIncrement(Number(e.target.value))} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
            Go-live (local)
            <input type="datetime-local" value={goLiveAt} onChange={(e) => setGoLiveAt(e.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>
            Duration (mins)
            <input type="number" min={1} step={1} placeholder="10" value={durationMinutes} onChange={(e) => setDurationMinutes(Number(e.target.value))} />
          </label>
          <button style={{ transition: 'transform .1s ease' }} onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.98)')} onMouseUp={(e) => (e.currentTarget.style.transform = 'scale(1)')}>Create</button>
        </form>
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
        {items.map((a) => {
          const { h, m, s, done } = useCountdown(a.endsAt)
          return (
            <article key={a.id} style={{ border: '1px solid #e6eaf0', borderRadius: 14, padding: 16, boxShadow: '0 12px 28px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: 12, background: '#fff', transition: 'transform .15s ease, box-shadow .2s ease' }} onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 16px 32px rgba(0,0,0,0.08)'}} onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 12px 28px rgba(0,0,0,0.05)'}}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3 style={{ margin: 0 }}>{a.title}</h3>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{done ? 'Ended' : `Ends in ${h}h ${m}m ${s}s`}</span>
              </div>
              <div style={{ fontSize: 18 }}>
                Current: <strong>${Number(a.currentPrice).toFixed(2)}</strong>
              </div>
              {a.bidIncrement ? (
                <div style={{ fontSize: 12, opacity: 0.7 }}>Min increment: ${Number(a.bidIncrement).toFixed(2)}</div>
              ) : null}
              <div style={{ display: 'flex', gap: 8 }}>
                <button disabled={done} onClick={() => placeBid(a.id, Number(a.currentPrice) + 1)}>Bid +1</button>
                <button disabled={done} onClick={() => placeBid(a.id, Number(a.currentPrice) + 5)}>Bid +5</button>
              </div>
            </article>
          )
        })}
      </div>

      <section style={{ marginTop: 24, border: '1px solid #e6eaf0', padding: 16, borderRadius: 12, background: '#fff' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>Diagnostics</h3>
          <button onClick={runDiagnostics}>Run checks</button>
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 8 }}>
          Checks DB, Redis, Supabase, SendGrid, and PUBLIC_ORIGIN (admin only).
        </div>
        {diag && (
          <pre style={{ background: '#0f172a', color: '#e2e8f0', padding: 12, borderRadius: 8, marginTop: 12, overflow: 'auto' }}>{JSON.stringify(diag, null, 2)}</pre>
        )}
      </section>

      <section style={{ marginTop: 24, border: '1px solid #e6eaf0', padding: 16, borderRadius: 12, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>Notifications</h3>
        {notifications.length === 0 ? (
          <div style={{ opacity: 0.7, fontSize: 14 }}>No notifications yet.</div>
        ) : (
          <ul>
            {notifications.map((n) => (
              <li key={n.id}>
                <code style={{ fontSize: 12 }}>{n.type}</code> — {n.payload?.auctionId} {n.payload?.amount ? `($${Number(n.payload.amount).toFixed(2)})` : ''}
              </li>
            ))}
          </ul>
        )}
      </section>

      {me?.isAdmin && (
        <section style={{ marginTop: 24, border: '1px solid #e6eaf0', padding: 16, borderRadius: 12, background: '#fff' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>Admin</h3>
            <button onClick={loadAdminAuctions}>Refresh</button>
          </div>
          {adminAuctions.length === 0 ? (
            <div style={{ opacity: 0.7, fontSize: 14 }}>No auctions.</div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {adminAuctions.map((a) => (
                <div key={a.id} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <strong>{a.title}</strong>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>status: {a.status}</span>
                  <button onClick={() => adminStart(a.id)}>Start</button>
                  <button onClick={() => adminReset(a.id)}>Reset</button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}
