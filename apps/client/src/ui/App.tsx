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

function LiveAuctions({ authHeaders, items, placeBid }: { authHeaders: any; items: any[]; placeBid: (id: string, amount: number) => Promise<void> }) {
  function useCountdown(targetIso: string) {
    const [now, setNow] = useState(Date.now())
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
    const ends = useMemo(() => new Date(targetIso).getTime(), [targetIso])
    const ms = Math.max(0, ends - now); const s = Math.floor(ms/1000)%60; const m = Math.floor(ms/1000/60)%60; const h = Math.floor(ms/1000/60/60)
    return { h,m,s,done: ms===0 }
  }
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 20 }}>
        {items.map((a) => {
          const { h, m, s, done } = useCountdown(a.endsAt)
          return (
            <article key={a.id} style={{ border: '1px solid #e6eaf0', borderRadius: 14, padding: 16, boxShadow: '0 12px 28px rgba(0,0,0,0.05)', display: 'flex', flexDirection: 'column', gap: 12, background: '#fff' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <h3 style={{ margin: 0 }}>{a.title}</h3>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{done ? 'Ended' : `Ends in ${h}h ${m}m ${s}s`}</span>
              </div>
              <div style={{ fontSize: 18 }}>Current: <strong>${Number(a.currentPrice).toFixed(2)}</strong></div>
              {a.bidIncrement ? (<div style={{ fontSize: 12, opacity: 0.7 }}>Min increment: ${Number(a.bidIncrement).toFixed(2)}</div>) : null}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button disabled={done} onClick={() => placeBid(a.id, Number(a.currentPrice) + 1)}>+1</button>
                <button disabled={done} onClick={() => placeBid(a.id, Number(a.currentPrice) + 5)}>+5</button>
                <form onSubmit={(e) => { e.preventDefault(); const amt = Number((e.currentTarget as any).amount.value); if (!isNaN(amt)) placeBid(a.id, amt) }} style={{ display: 'flex', gap: 6 }}>
                  <input name="amount" type="number" min={0} step={1} placeholder={String(Number(a.currentPrice) + Number(a.bidIncrement || 1))} style={{ width: 100 }} />
                  <button disabled={done} type="submit">Bid</button>
                </form>
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

function AdminPage(props: { authHeaders: any; load: () => Promise<void>; loadAdminAuctions: () => Promise<void>; adminAuctions: any[]; notifications: any[]; createAuction: (e: React.FormEvent) => Promise<void>; title: string; setTitle: any; startingPrice: number; setStartingPrice: any; bidIncrement: number; setBidIncrement: any; goLiveAt: string; setGoLiveAt: any; durationMinutes: number; setDurationMinutes: any; adminStart: (id: string) => Promise<void>; adminReset: (id: string) => Promise<void>; adminEnd: (id: string) => Promise<void>; adminAccept: (id: string) => Promise<void>; adminReject: (id: string) => Promise<void>; adminCounter: (id: string) => Promise<void>; }) {
  const { adminAuctions, notifications } = props
  return (
    <div>
      <section style={{ border: '1px solid #e6eaf0', padding: 16, borderRadius: 12, marginBottom: 24, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>Host auction</h3>
        <form onSubmit={props.createAuction} style={{ display: 'grid', gridTemplateColumns: '1fr 160px 160px 240px 140px 120px', gap: 12, alignItems: 'end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>Title<input placeholder="Vintage camera" value={props.title} onChange={(e) => props.setTitle(e.target.value)} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>Starting Price<input type="number" min={0} step={1} value={props.startingPrice} onChange={(e) => props.setStartingPrice(Number(e.target.value))} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>Bid Increment<input type="number" min={1} step={1} value={props.bidIncrement} onChange={(e) => props.setBidIncrement(Number(e.target.value))} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>Go-live<input type="datetime-local" value={props.goLiveAt} onChange={(e) => props.setGoLiveAt(e.target.value)} /></label>
          <label style={{ display: 'flex', flexDirection: 'column', fontSize: 12 }}>Duration (mins)<input type="number" min={1} step={1} value={props.durationMinutes} onChange={(e) => props.setDurationMinutes(Number(e.target.value))} /></label>
          <button>Create</button>
        </form>
      </section>
      <section style={{ border: '1px solid #e6eaf0', padding: 16, borderRadius: 12, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>Admin operations</h3>
        {adminAuctions.length === 0 ? (<div style={{ opacity: 0.7 }}>No auctions.</div>) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {adminAuctions.map((a) => (
              <div key={a.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto auto', alignItems: 'center', gap: 8 }}>
                <div>
                  <strong>{a.title}</strong>
                  <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 8 }}>status: {a.status}</span>
                </div>
                <button onClick={() => props.adminStart(a.id)}>Start</button>
                <button onClick={() => props.adminReset(a.id)}>Reset</button>
                <button onClick={() => props.adminEnd(a.id)}>End</button>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => props.adminAccept(a.id)}>Accept</button>
                  <button onClick={() => props.adminReject(a.id)}>Reject</button>
                  <button onClick={() => props.adminCounter(a.id)}>Counter</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section style={{ marginTop: 24, border: '1px solid #e6eaf0', padding: 16, borderRadius: 12, background: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>Notifications</h3>
        {notifications.length === 0 ? (<div style={{ opacity: 0.7 }}>No notifications.</div>) : (
          <ul>{notifications.map((n) => (<li key={n.id}><code style={{ fontSize: 12 }}>{n.type}</code> — {n.payload?.auctionId} {n.payload?.amount ? `($${Number(n.payload.amount).toFixed(2)})` : ''}</li>))}</ul>
        )}
      </section>
    </div>
  )
}

export function App() {
  const [page, setPage] = useState<'live'|'admin'>('live')
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
      // Prefer host-owned list if authenticated; fallback to global admin list
      const hostRes = await fetch(api('/host/auctions'), { headers: authHeaders })
      if (hostRes.ok) {
        const data = await hostRes.json(); setAdminAuctions(data.items || []); return
      }
      const res = await fetch(api('/admin/auctions'), { headers: authHeaders })
      if (res.ok) {
        const data = await res.json()
        setAdminAuctions(data.items || [])
      }
    } catch {}
  }

  async function runDiagnostics() {
    try {
      if (!session?.access_token) { alert('Please sign in as admin to run diagnostics.'); return }
      const res = await fetch(api('/health/check'), {
        headers: { 'Authorization': `Bearer ${session.access_token}` }
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
    const pw = (document.getElementById('auth-pw') as HTMLInputElement)?.value || ''
    const { error } = await sb.auth.signInWithPassword({ email, password: pw })
    if (error) alert(error.message)
  }
  async function signOut() {
    if (!sb) return
    await sb.auth.signOut()
  }
  async function signUp(e: React.FormEvent | React.MouseEvent) {
    e.preventDefault()
    if (!sb) return alert('Supabase not configured')
    const pw = (document.getElementById('auth-pw') as HTMLInputElement)?.value || ''
    const { error } = await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: location.origin } })
    if (error) alert(error.message)
    else alert('Verification email sent. Please verify your email, then log in.')
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
  if (!session) { alert('Please sign in to host auctions.'); return }
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
    if (!session) { alert('Please sign in to place bids.'); return }
    const res = await fetch(api(`/api/auctions/${id}/bids`), {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ amount })
    })
    if (!res.ok) alert(await res.text())
  }

  async function adminStart(id: string) {
    const res = await fetch(api(`/host/auctions/${id}/start`), { method: 'POST', headers: authHeaders })
    if (res.ok) { loadAdminAuctions(); load(); return }
    const r2 = await fetch(api(`/admin/auctions/${id}/start`), { method: 'POST', headers: authHeaders })
    if (r2.ok) { loadAdminAuctions(); load() } else { alert(await r2.text()) }
  }
  async function adminReset(id: string) {
    const res = await fetch(api(`/host/auctions/${id}/reset`), { method: 'POST', headers: authHeaders })
    if (res.ok) { loadAdminAuctions(); load(); return }
    const r2 = await fetch(api(`/admin/auctions/${id}/reset`), { method: 'POST', headers: authHeaders })
    if (r2.ok) { loadAdminAuctions(); load() } else { alert(await r2.text()) }
  }
  async function adminEnd(id: string) {
    const res = await fetch(api(`/api/auctions/${id}/end`), { method: 'POST', headers: authHeaders })
    if (res.ok) { loadAdminAuctions(); loadNotifications(); load() } else { alert(await res.text()) }
  }
  async function adminAccept(id: string) {
    const res = await fetch(api(`/api/auctions/${id}/decision`), { method: 'POST', headers: authHeaders, body: JSON.stringify({ action: 'accept' }) })
    if (res.ok) { loadNotifications(); loadAdminAuctions(); } else { alert(await res.text()) }
  }
  async function adminReject(id: string) {
    const res = await fetch(api(`/api/auctions/${id}/decision`), { method: 'POST', headers: authHeaders, body: JSON.stringify({ action: 'reject' }) })
    if (res.ok) { loadNotifications(); loadAdminAuctions(); } else { alert(await res.text()) }
  }
  async function adminCounter(id: string) {
    const amt = Number(prompt('Enter counter-offer amount') || '')
    if (!amt || isNaN(amt)) return
    const res = await fetch(api(`/api/auctions/${id}/decision`), { method: 'POST', headers: authHeaders, body: JSON.stringify({ action: 'counter', amount: amt }) })
    if (res.ok) { loadNotifications(); } else { alert(await res.text()) }
  }

  return (
    <div className="max-w-6xl mx-auto p-6">
      <header className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Realtime Auctions</h1>
          <nav className="flex gap-2">
            <button className={`btn-secondary ${page==='live' ? 'opacity-50' : ''}`} onClick={() => setPage('live')} disabled={page==='live'}>Live</button>
            <button className={`btn-secondary ${page==='admin' ? 'opacity-50' : ''}`} onClick={() => setPage('admin')} disabled={page==='admin'}>Admin</button>
          </nav>
        </div>
        <div>
          {sb ? (
            session ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-slate-600">{session.user.email || session.user.id}</span>
                <button className="btn" onClick={signOut}>Sign out</button>
              </div>
            ) : (
              <div className="max-w-md">
                <div className="bg-white rounded-lg shadow p-4 border border-slate-200">
                  <h2 className="text-lg font-medium mb-3">Login / Sign up</h2>
                  <form onSubmit={signIn} className="grid grid-cols-2 gap-3 items-end">
                    <label className="label col-span-1">
                      <span className="label">Email</span>
                      <input className="input" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                    </label>
                    <label className="label col-span-1">
                      <span className="label">Password</span>
                      <input id="auth-pw" className="input" type="password" required minLength={6} />
                    </label>
                    <div className="col-span-2 flex gap-2">
                      <button type="submit" className="btn">Login</button>
                      <button type="button" className="btn-secondary" onClick={signUp}>Sign up</button>
                    </div>
                  </form>
                </div>
              </div>
            )
          ) : (
            <span className="text-slate-500">Dev mode (no auth)</span>
          )}
        </div>
      </header>

      {page === 'live' ? (
        <LiveAuctions authHeaders={authHeaders} items={items} placeBid={placeBid} />
      ) : (
        <AdminPage
          authHeaders={authHeaders}
          load={load}
          loadAdminAuctions={loadAdminAuctions}
          adminAuctions={adminAuctions}
          notifications={notifications}
          createAuction={createAuction}
          title={title}
          setTitle={setTitle}
          startingPrice={startingPrice}
          setStartingPrice={setStartingPrice}
          bidIncrement={bidIncrement}
          setBidIncrement={setBidIncrement}
          goLiveAt={goLiveAt}
          setGoLiveAt={setGoLiveAt}
          durationMinutes={durationMinutes}
          setDurationMinutes={setDurationMinutes}
          adminStart={adminStart}
          adminReset={adminReset}
          adminEnd={adminEnd}
          adminAccept={adminAccept}
          adminReject={adminReject}
          adminCounter={adminCounter}
        />
      )}

      <section className="mt-6 bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">Diagnostics</h3>
          <button className="btn" onClick={runDiagnostics}>Run checks</button>
        </div>
        <div className="text-xs text-slate-500 mt-2">Checks DB, Redis, Supabase, SendGrid, and PUBLIC_ORIGIN (admin only).</div>
        {diag && (
          <pre className="mt-3 rounded bg-slate-900 text-slate-100 p-3 overflow-auto">{JSON.stringify(diag, null, 2)}</pre>
        )}
      </section>

      {me?.isAdmin && page === 'admin' && (
        <div className="flex justify-end mt-2">
          <button className="btn-secondary" onClick={loadAdminAuctions}>Refresh admin lists</button>
        </div>
      )}
    </div>
  )
}
