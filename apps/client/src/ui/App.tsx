import { useEffect, useMemo, useRef, useState, createContext, useContext } from 'react'
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
let sb: ReturnType<typeof createClient> | null = null as any
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
if (SUPABASE_URL && SUPABASE_KEY) {
  sb = createClient(SUPABASE_URL, SUPABASE_KEY)
}

const NowCtx = createContext<number>(Date.now())
function useCountdown(targetIso: string) {
  const now = useContext(NowCtx)
  const ends = useMemo(() => new Date(targetIso).getTime(), [targetIso])
  const ms = Math.max(0, ends - now)
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 1000 / 60) % 60
  const h = Math.floor(ms / 1000 / 60 / 60)
  return { h, m, s, done: ms === 0 }
}

function AuctionCard({ a, placeBid }: { a: any; placeBid: (id: string, amount: number) => Promise<void> }) {
  const { h, m, s, done } = useCountdown(a.endsAt)
  const [custom, setCustom] = useState<string>('')
  const status = String(a.status || '').toLowerCase()
  const isClosed = status === 'closed'
  const isEnded = status === 'ended' || done
  const badge = isClosed ? { text: 'Sold', cls: 'bg-purple-100 text-purple-700' }
    : isEnded ? { text: 'Ended', cls: 'bg-red-100 text-red-700' }
    : { text: 'Live', cls: 'bg-green-100 text-green-700' }
  const [winnerAmt, setWinnerAmt] = useState<number | null>(null)
  useEffect(() => {
    let ignore = false
    async function fetchWinner() {
      try {
        if (isClosed || isEnded) {
          const res = await fetch(api(`/api/auctions/${a.id}/winner`))
          if (res.ok) {
            const w = await res.json()
            if (!ignore) setWinnerAmt(Number(w.amount))
          }
        } else {
          setWinnerAmt(null)
        }
      } catch {}
    }
    fetchWinner()
    return () => { ignore = true }
  }, [a.id, isClosed, isEnded])
  return (
    <div className="bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden hover:shadow-xl transition-shadow">
      <div className="p-6">
        <div className="flex justify-between items-start mb-4">
          <h3 className="text-lg font-semibold text-slate-900 line-clamp-2">{a.title}</h3>
          <div className={`px-3 py-1 rounded-full text-xs font-medium ${badge.cls}`}>{badge.text}</div>
        </div>
        {a.description && (
          <p className="text-slate-600 text-sm mb-4 line-clamp-2">{a.description}</p>
        )}
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <span className="text-sm text-slate-600">{isClosed ? 'Final Price' : 'Current Bid'}</span>
            <span className="text-2xl font-bold text-slate-900">
              ${Number(a.currentPrice).toFixed(2)}
            </span>
          </div>
          {(!isEnded && !isClosed) && (
            <div className="text-center">
              <div className="text-sm text-slate-600 mb-2">
                Ends in {h}h {m}m {s}s
              </div>
              <div className="flex gap-2 items-center">
                <button
                  onClick={() => placeBid(a.id, Number(a.currentPrice) + 1)}
                  className="flex-1 bg-indigo-600 text-white py-2 px-3 rounded-lg font-medium hover:bg-indigo-700 transition-colors text-sm"
                >
                  +$1
                </button>
                <button
                  onClick={() => placeBid(a.id, Number(a.currentPrice) + 5)}
                  className="flex-1 bg-indigo-600 text-white py-2 px-3 rounded-lg font-medium hover:bg-indigo-700 transition-colors text-sm"
                >
                  +$5
                </button>
                <input
                  type="number"
                  min={Number(a.currentPrice) + Number(a.bidIncrement || 1)}
                  step={1}
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder={`$${(Number(a.currentPrice) + Number(a.bidIncrement || 1)).toFixed(2)}`}
                  className="w-28 px-3 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
                />
                <button
                  onClick={() => {
                    const v = Number(custom)
                    if (!isNaN(v) && v > 0) placeBid(a.id, v)
                  }}
                  className="px-3 py-2 border border-indigo-600 text-indigo-600 rounded-lg font-medium hover:bg-indigo-50 transition-colors text-sm"
                >
                  Bid
                </button>
              </div>
            </div>
          )}
          {isEnded && !isClosed && (
            <div className="text-center text-sm text-slate-600">
              Auction ended. Awaiting seller decision.
            </div>
          )}
      {isClosed && (
            <div className="text-center text-sm text-purple-700 font-medium">
        Sold! {winnerAmt ? `Winner paid $${winnerAmt.toFixed(2)}` : 'Finalized.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Navbar({ session, me, page, setPage, signOut, notifications, onOpen }: { 
  session: any; 
  me: { id: string; isAdmin: boolean } | null; 
  page: string; 
  setPage: (page: 'live' | 'admin' | 'auth') => void; 
  signOut: () => void,
  notifications: any[],
  onOpen: () => void
}) {
  return (
    <nav className="bg-white border-b border-slate-200 shadow-sm">
      <div className="max-w-6xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-8">
            <h1 className="text-2xl font-bold text-slate-900">
              🏛️ AuctionHub
            </h1>
            {session && (
              <div className="flex gap-1">
                <button 
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    page === 'live' 
                      ? 'bg-indigo-100 text-indigo-700' 
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                  onClick={() => setPage('live')}
                >
                  Live Auctions
                </button>
                <button 
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    page === 'admin' 
                      ? 'bg-indigo-100 text-indigo-700' 
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                  }`}
                  onClick={() => setPage('admin')}
                >
                  Host Dashboard
                </button>
              </div>
            )}
          </div>
          
          <div className="flex items-center gap-4">
            {session ? (
              <>
                <button
                  onClick={onOpen}
                  className="relative p-2 rounded-full hover:bg-slate-100"
                  aria-label="Notifications"
                  title="Notifications"
                >
                  <span className="text-xl">🔔</span>
                  {notifications.length > 0 && (
                    <span className="absolute -top-1 -right-1 bg-red-600 text-white text-xs rounded-full px-1">
                      {notifications.length}
                    </span>
                  )}
                </button>
                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <div className="text-sm font-medium text-slate-900">
                      {session.user.email}
                    </div>
                    {me?.isAdmin && (
                      <div className="text-xs text-indigo-600 font-medium">Admin</div>
                    )}
                  </div>
                  <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center">
                    <span className="text-indigo-600 font-medium text-sm">
                      {session.user.email?.[0]?.toUpperCase() || 'U'}
                    </span>
                  </div>
                </div>
                <button 
                  onClick={signOut}
                  className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-900 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
                >
                  Sign Out
                </button>
              </>
            ) : (
              <button 
                onClick={() => setPage('auth')}
                className="px-6 py-2 bg-indigo-600 text-white font-medium rounded-lg hover:bg-indigo-700 transition-colors"
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </div>
    </nav>
  )
}

function AuthPage({ email, setEmail, signIn, signUp, supabaseConfigured }: {
  email: string;
  setEmail: (email: string) => void;
  signIn: (e: React.FormEvent) => Promise<void>;
  signUp: (e: React.FormEvent) => Promise<void>;
  supabaseConfigured: boolean;
}) {
  const [isSignUp, setIsSignUp] = useState(false)
  const [password, setPassword] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Set password in the DOM element for compatibility with existing code
    const pwInput = document.getElementById('auth-pw') as HTMLInputElement
    if (pwInput) pwInput.value = password
    
    if (isSignUp) {
      await signUp(e)
    } else {
      await signIn(e)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-cyan-50 flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
          <div className="text-center mb-8">
            <div className="text-4xl mb-4">🏛️</div>
            <h2 className="text-2xl font-bold text-slate-900 mb-2">
              {isSignUp ? 'Create Account' : 'Welcome Back'}
            </h2>
            <p className="text-slate-600">
              {isSignUp 
                ? 'Join AuctionHub to start bidding and hosting auctions' 
                : 'Sign in to your AuctionHub account'
              }
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Email Address
              </label>
              <input
                type="email"
                required
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Password
              </label>
              <input
                id="auth-pw"
                type="password"
                required
                minLength={6}
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 transition-colors"
                placeholder={isSignUp ? 'Create a password (min 6 characters)' : 'Enter your password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <button
              type="submit"
              className="w-full bg-indigo-600 text-white py-3 px-4 rounded-lg font-medium hover:bg-indigo-700 focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 transition-colors"
            >
              {isSignUp ? 'Create Account' : 'Sign In'}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-indigo-600 hover:text-indigo-700 font-medium"
            >
              {isSignUp 
                ? 'Already have an account? Sign in' 
                : "Don't have an account? Sign up"
              }
            </button>
          </div>

          {!supabaseConfigured && (
            <div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
              <p className="text-sm text-amber-800">
                <strong>Dev Mode:</strong> Supabase not configured. Authentication is disabled.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function LiveAuctions({ authHeaders, items, placeBid }: { authHeaders: any; items: any[]; placeBid: (id: string, amount: number) => Promise<void> }) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12">
        <div className="text-6xl mb-4">🏛️</div>
        <h3 className="text-xl font-semibold text-slate-900 mb-2">No Live Auctions</h3>
        <p className="text-slate-600">Check back later or create your own auction!</p>
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {items.map((a) => (
        <AuctionCard key={a.id} a={a} placeBid={placeBid} />
      ))}
    </div>
  )
}

function AdminPage(props: { 
  authHeaders: any; 
  load: () => Promise<void>; 
  loadAdminAuctions: () => Promise<void>; 
  adminAuctions: any[]; 
  notifications: any[]; 
  createAuction: (e: React.FormEvent) => Promise<void>; 
  title: string; 
  setTitle: any; 
  startingPrice: number; 
  setStartingPrice: any; 
  bidIncrement: number; 
  setBidIncrement: any; 
  goLiveAt: string; 
  setGoLiveAt: any; 
  durationMinutes: number; 
  setDurationMinutes: any; 
  adminStart: (id: string) => Promise<void>; 
  adminReset: (id: string) => Promise<void>; 
  adminEnd: (id: string) => Promise<void>; 
  adminAccept: (id: string) => Promise<void>; 
  adminReject: (id: string) => Promise<void>; 
  adminCounter: (id: string, amount: number) => Promise<void>; 
}) {
  const [counterAmt, setCounterAmt] = useState<Record<string, string>>({})
  const [openBids, setOpenBids] = useState<Record<string, boolean>>({})
  const [bidPages, setBidPages] = useState<Record<string, { items: any[]; offset: number; limit: number; done: boolean }>>({})
  const { adminAuctions, notifications } = props
  const stats = useMemo(() => {
    const s = { total: adminAuctions.length, live: 0, scheduled: 0, ended: 0, closed: 0 }
    for (const a of adminAuctions) {
      const st = String(a.status || '').toLowerCase()
      if (st in s) (s as any)[st]++
    }
    return s
  }, [adminAuctions])

  return (
    <div className="space-y-8">
      {/* Create Auction Form */}
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6">
        <h2 className="text-xl font-semibold text-slate-900 mb-6">Create New Auction</h2>
        <form onSubmit={props.createAuction} className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Auction Title
              </label>
              <input 
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                placeholder="Vintage camera, rare collectible, etc."
                value={props.title} 
                onChange={(e) => props.setTitle(e.target.value)} 
                required
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Starting Price ($)
              </label>
              <input 
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                type="number" 
                min={0} 
                step={1} 
                value={props.startingPrice} 
                onChange={(e) => props.setStartingPrice(Number(e.target.value))} 
                required
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Bid Increment ($)
              </label>
              <input 
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                type="number" 
                min={1} 
                step={1} 
                value={props.bidIncrement} 
                onChange={(e) => props.setBidIncrement(Number(e.target.value))} 
                required
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Go Live At
              </label>
              <input 
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                type="datetime-local" 
                value={props.goLiveAt} 
                onChange={(e) => props.setGoLiveAt(e.target.value)} 
                required
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">
                Duration (minutes)
              </label>
              <input 
                className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                type="number" 
                min={1} 
                step={1} 
                value={props.durationMinutes} 
                onChange={(e) => props.setDurationMinutes(Number(e.target.value))} 
                required
              />
            </div>
          </div>
          
          <button 
            type="submit"
            className="w-full bg-indigo-600 text-white py-3 px-4 rounded-lg font-medium hover:bg-indigo-700 transition-colors"
          >
            Create Auction
          </button>
        </form>
      </div>

      {/* Stats Dashboard */}
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6">
        <h2 className="text-xl font-semibold text-slate-900 mb-6">Dashboard Overview</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-slate-900">{stats.total}</div>
            <div className="text-sm text-slate-600">Total Auctions</div>
          </div>
          <div className="bg-green-50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-green-700">{stats.live}</div>
            <div className="text-sm text-green-600">Live Now</div>
          </div>
          <div className="bg-blue-50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-blue-700">{stats.scheduled}</div>
            <div className="text-sm text-blue-600">Scheduled</div>
          </div>
          <div className="bg-gray-50 rounded-lg p-4 text-center">
            <div className="text-2xl font-bold text-gray-700">{stats.ended + stats.closed}</div>
            <div className="text-sm text-gray-600">Completed</div>
          </div>
        </div>
      </div>

      {/* Auction Management */}
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6">
        <h2 className="text-xl font-semibold text-slate-900 mb-6">Manage Your Auctions</h2>
        {adminAuctions.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-4xl mb-4">📋</div>
            <p className="text-slate-600">No auctions created yet. Create your first auction above!</p>
          </div>
        ) : (
          <div className="space-y-4">
            {adminAuctions.map((a) => (
              <div key={a.id} className="border border-slate-200 rounded-lg p-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="flex-1">
                    <h3 className="font-semibold text-slate-900">{a.title}</h3>
                    <div className="flex items-center gap-4 mt-1 text-sm text-slate-600">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                        a.status === 'live' ? 'bg-green-100 text-green-700' :
                        a.status === 'scheduled' ? 'bg-blue-100 text-blue-700' :
                        'bg-gray-100 text-gray-700'
                      }`}>
                        {a.status}
                      </span>
                      <span>Current: ${Number(a.currentPrice).toFixed(2)}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button 
                      onClick={() => props.adminStart(a.id)}
                      className="px-3 py-1 bg-green-600 text-white rounded-md text-sm hover:bg-green-700 transition-colors"
                    >
                      Start
                    </button>
                    <button 
                      onClick={() => props.adminReset(a.id)}
                      className="px-3 py-1 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700 transition-colors"
                    >
                      Reset
                    </button>
                    <button 
                      onClick={() => props.adminEnd(a.id)}
                      className="px-3 py-1 bg-orange-600 text-white rounded-md text-sm hover:bg-orange-700 transition-colors"
                    >
                      End
                    </button>
                    <button 
                      onClick={() => props.adminAccept(a.id)}
                      className="px-3 py-1 bg-emerald-600 text-white rounded-md text-sm hover:bg-emerald-700 transition-colors"
                    >
                      Accept
                    </button>
                    <button 
                      onClick={() => props.adminReject(a.id)}
                      className="px-3 py-1 bg-red-600 text-white rounded-md text-sm hover:bg-red-700 transition-colors"
                    >
                      Reject
                    </button>
                    <button 
                      onClick={async () => {
                        const amt = Number(counterAmt[a.id])
                        if (!amt || isNaN(amt)) return
                        await props.adminCounter(a.id, amt)
                      }}
                      className="px-3 py-1 bg-purple-600 text-white rounded-md text-sm hover:bg-purple-700 transition-colors"
                    >
                      Counter
                    </button>
                    <div className="flex items-center gap-2 ml-2">
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={counterAmt[a.id] ?? ''}
                        onChange={(e) => setCounterAmt((m) => ({ ...m, [a.id]: e.target.value }))}
                        placeholder="Counter $"
                        className="w-28 px-2 py-1 border border-slate-300 rounded-md text-sm"
                      />
                      <button
                        onClick={async () => {
                          const amt = Number(counterAmt[a.id])
                          if (!amt || isNaN(amt)) return
                          await props.adminCounter(a.id, amt)
                        }}
                        className="px-3 py-1 border border-purple-600 text-purple-600 rounded-md text-sm hover:bg-purple-50"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </div>
                {/* Bid history drawer */}
                <div className="mt-3">
                  <button
                    onClick={async () => {
                      setOpenBids((m) => ({ ...m, [a.id]: !m[a.id] }))
                      if (!bidPages[a.id]) {
                        // initial load
                        try {
                          const res = await fetch(api(`/api/auctions/${a.id}/bids?offset=0&limit=10`), { headers: props.authHeaders })
                          const data = await res.json()
                          setBidPages((m) => ({ ...m, [a.id]: { items: data.items || [], offset: 0, limit: 10, done: !data.items || data.items.length < 10 } }))
                        } catch {}
                      }
                    }}
                    className="text-sm text-slate-600 hover:text-slate-900"
                  >
                    {openBids[a.id] ? 'Hide bids ▲' : 'Show bids ▼'}
                  </button>
                  {openBids[a.id] && (
                    <div className="mt-2 bg-slate-50 rounded-md p-3">
                      {(bidPages[a.id]?.items || []).length === 0 ? (
                        <div className="text-sm text-slate-500">No bids yet.</div>
                      ) : (
                        <ul className="divide-y divide-slate-200">
                          {(bidPages[a.id]?.items || []).map((b) => (
                            <li key={b.id} className="py-2 text-sm flex justify-between">
                              <span className="text-slate-600">{new Date(b.createdAt || b.created_at || Date.now()).toLocaleString()}</span>
                              <span className="font-medium text-slate-900">${Number(b.amount).toFixed(2)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {!bidPages[a.id]?.done && (
                        <div className="mt-2 text-right">
                          <button
                            onClick={async () => {
                              const page = bidPages[a.id] || { items: [], offset: 0, limit: 10, done: false }
                              const nextOffset = page.offset + page.limit
                              try {
                                const res = await fetch(api(`/api/auctions/${a.id}/bids?offset=${nextOffset}&limit=${page.limit}`), { headers: props.authHeaders })
                                const data = await res.json()
                                const more = data.items || []
                                setBidPages((m) => ({
                                  ...m,
                                  [a.id]: {
                                    items: [...(m[a.id]?.items || []), ...more],
                                    offset: nextOffset,
                                    limit: page.limit,
                                    done: more.length < page.limit
                                  }
                                }))
                              } catch {}
                            }}
                            className="text-sm px-3 py-1 border border-slate-300 rounded-md hover:bg-slate-100"
                          >
                            Load more
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Notifications */}
      <div className="bg-white rounded-xl shadow-lg border border-slate-200 p-6">
        <h2 className="text-xl font-semibold text-slate-900 mb-6">Recent Notifications</h2>
        {notifications.length === 0 ? (
          <div className="text-center py-8">
            <div className="text-4xl mb-4">🔔</div>
            <p className="text-slate-600">No notifications yet.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {notifications.slice(0, 10).map((n) => (
              <div key={n.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                <div className="w-2 h-2 bg-indigo-500 rounded-full"></div>
                <div className="flex-1">
                  <span className="font-medium text-slate-900">{n.type}</span>
                  {n.payload?.auctionId && (
                    <span className="text-slate-600 ml-2">
                      Auction: {n.payload.auctionId}
                      {n.payload?.amount && ` ($${Number(n.payload.amount).toFixed(2)})`}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function App() {
  const [page, setPage] = useState<'live'|'admin'|'auth'>('live')
  const [items, setItems] = useState<any[]>([])
  const [showListings, setShowListings] = useState(false)
  const [listPage, setListPage] = useState(0)
  const PAGE_SIZE = 12
  const [now, setNow] = useState(Date.now())
  const [title, setTitle] = useState('')
  const [startingPrice, setStartingPrice] = useState(0)
  const [durationMinutes, setDurationMinutes] = useState(10)
  const [bidIncrement, setBidIncrement] = useState(1)
  const [goLiveAt, setGoLiveAt] = useState<string>(() => new Date(Date.now() + 60_000).toISOString().slice(0,16))
  const [session, setSession] = useState<any>(null)
  const [email, setEmail] = useState('')
  const [supaConfigured, setSupaConfigured] = useState(!!(SUPABASE_URL && SUPABASE_KEY))
  const [diag, setDiag] = useState<any | null>(null)
  const [me, setMe] = useState<{ id: string; isAdmin: boolean } | null>(null)
  const [notifications, setNotifications] = useState<any[]>([])
  const [notifyOpen, setNotifyOpen] = useState(false)
  const [adminAuctions, setAdminAuctions] = useState<any[]>([])

  const authHeaders = useMemo(() => {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (session?.access_token) headers['authorization'] = `Bearer ${session.access_token}`
    return headers
  }, [session])

  async function load() {
    try {
      const qs = showListings
        ? `?status=ended,closed&offset=${listPage * PAGE_SIZE}&limit=${PAGE_SIZE}`
        : `?status=live&offset=0&limit=${PAGE_SIZE}`
      const res = await fetch(api(`/api/auctions${qs}`))
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
    if (!session) return
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
    if (session) {
      loadMe()
      loadNotifications()
    }
  }, [session])

  // Load admin/host auctions when switching to Admin page or after login/logout
  useEffect(() => {
    if (page === 'admin' && session) {
      loadAdminAuctions()
      loadNotifications()
    }
  }, [page, session])

  // Reload auctions when listings toggle or page changes
  useEffect(() => {
    load()
  }, [showListings, listPage])

  // Supabase session
  useEffect(() => {
    let unsub: (() => void) | undefined
    async function ensureClient() {
      if (!sb) {
        try {
          const res = await fetch(api('/config'))
          const cfg = await res.json()
          if (cfg?.supabaseUrl && cfg?.supabaseAnonKey) {
            sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey)
            setSupaConfigured(true)
          } else {
            setSupaConfigured(false)
          }
        } catch {}
      }
      if (!sb) return
      if (!sb) return
      sb.auth.getSession().then(({ data }) => setSession(data.session))
      const { data: sub } = sb.auth.onAuthStateChange((_e, s) => {
        setSession(s)
        if (s) setPage('live')
      })
      unsub = () => sub.subscription.unsubscribe()
    }
    ensureClient()
    return () => { if (unsub) unsub() }
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
    setPage('live')
  }
  
  async function signUp(e: React.FormEvent | React.MouseEvent) {
    e.preventDefault()
    if (!sb) return alert('Supabase not configured')
    const pw = (document.getElementById('auth-pw') as HTMLInputElement)?.value || ''
    let redirect = location.origin
    try {
      const res = await fetch(api('/config'))
      const cfg = await res.json()
      if (cfg?.publicOrigin) redirect = cfg.publicOrigin
    } catch {}
    const { error } = await sb.auth.signUp({ email, password: pw, options: { emailRedirectTo: redirect } })
    if (error) alert(error.message)
    else alert('Verification email sent. Please verify your email, then log in.')
  }

  // WebSocket live updates
  const wsRef = useRef<WebSocket | null>(null)
  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'bid:accepted') {
        setItems((prev) => prev.map((a) => a.id === msg.auctionId ? { ...a, currentPrice: msg.amount } : a))
      } else if (msg.type === 'auction:ended') {
        setItems((prev) => prev.map((a) => a.id === msg.auctionId ? { ...a, status: 'ended' } : a))
      } else if (msg.type === 'auction:accepted') {
        setItems((prev) => prev.map((a) => a.id === msg.auctionId ? { ...a, status: 'closed', winnerId: msg.winnerId, currentPrice: msg.amount } : a))
      } else if (msg.type === 'auction:rejected') {
        setItems((prev) => prev.map((a) => a.id === msg.auctionId ? { ...a, status: 'closed' } : a))
      } else if (msg.type === 'offer:accepted') {
        setItems((prev) => prev.map((a) => a.id === msg.auctionId ? { ...a, status: 'closed', currentPrice: msg.amount } : a))
      } else if (msg.type === 'notify') {
        // In-app notifications; only keep recent 20
        setNotifications((list) => {
          if (!session) return list
          if (msg.userId && session.user?.id && msg.userId !== session.user.id) return list
          const next = [{ id: Math.random().toString(36).slice(2), ...msg.payload, at: msg.at }, ...list]
          return next.slice(0, 20)
        })
      }
    }
    wsRef.current = ws
    return () => ws.close()
  }, [])

  // single countdown ticker
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
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
    const res = await fetch(api(`/host/auctions/${id}/start`), { method: 'POST', headers: authHeaders, body: JSON.stringify({}) })
    if (res.ok) { loadAdminAuctions(); load(); return }
    const r2 = await fetch(api(`/admin/auctions/${id}/start`), { method: 'POST', headers: authHeaders, body: JSON.stringify({}) })
    if (r2.ok) { loadAdminAuctions(); load() } else { alert(await r2.text()) }
  }
  async function adminReset(id: string) {
    const res = await fetch(api(`/host/auctions/${id}/reset`), { method: 'POST', headers: authHeaders, body: JSON.stringify({}) })
    if (res.ok) { loadAdminAuctions(); load(); return }
    const r2 = await fetch(api(`/admin/auctions/${id}/reset`), { method: 'POST', headers: authHeaders, body: JSON.stringify({}) })
    if (r2.ok) { loadAdminAuctions(); load() } else { alert(await r2.text()) }
  }
  async function adminEnd(id: string) {
    const res = await fetch(api(`/api/auctions/${id}/end`), { method: 'POST', headers: authHeaders, body: JSON.stringify({}) })
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
  async function adminCounter(id: string, amount: number) {
    const res = await fetch(api(`/api/auctions/${id}/decision`), { method: 'POST', headers: authHeaders, body: JSON.stringify({ action: 'counter', amount }) })
    if (res.ok) { loadNotifications(); } else { alert(await res.text()) }
  }

  // Show auth page if not authenticated and trying to access protected content
  if (!session && (page === 'admin' || page === 'auth')) {
    return (
      <>
    <Navbar session={session} me={me} page={page} setPage={setPage} signOut={signOut} notifications={notifications} onOpen={() => setNotifyOpen((v) => !v)} />
  <AuthPage email={email} setEmail={setEmail} signIn={signIn} signUp={signUp} supabaseConfigured={supaConfigured} />
      </>
    )
  }

  return (
    <NowCtx.Provider value={now}>
    <div className="min-h-screen bg-slate-50">
      <Navbar session={session} me={me} page={page} setPage={setPage} signOut={signOut} notifications={notifications} onOpen={() => setNotifyOpen((v) => !v)} />
      
      <main className="max-w-6xl mx-auto px-6 py-8">
        {page === 'live' ? (
          <div>
            <div className="mb-8">
              <h2 className="text-3xl font-bold text-slate-900 mb-2">Live Auctions</h2>
              <p className="text-slate-600">Bid on exciting items from around the world</p>
              <div className="mt-4">
                <button
                  onClick={() => setShowListings((s) => !s)}
                  className="px-4 py-2 text-sm border border-slate-300 rounded-lg hover:bg-slate-50"
                >
                  {showListings ? 'Show Live Only' : 'Show Listings (Ended/Sold)'}
                </button>
              </div>
            </div>
            <LiveAuctions
              authHeaders={authHeaders}
              items={items.filter((a) => {
                const st = String(a.status || '').toLowerCase()
                return showListings ? (st !== 'live') : (st === 'live')
              })}
              placeBid={placeBid}
            />
            {showListings && (
              <div className="mt-6 flex justify-between items-center">
                <button
                  onClick={() => setListPage((p) => Math.max(0, p - 1))}
                  disabled={listPage === 0}
                  className="px-3 py-1 border border-slate-300 rounded-md disabled:opacity-50"
                >Prev</button>
                <div className="text-sm text-slate-600">Page {listPage + 1}</div>
                <button
                  onClick={() => setListPage((p) => p + 1)}
                  className="px-3 py-1 border border-slate-300 rounded-md"
                >Next</button>
              </div>
            )}
          </div>
        ) : page === 'admin' ? (
          <div>
            <div className="mb-8">
              <h2 className="text-3xl font-bold text-slate-900 mb-2">Host Dashboard</h2>
              <p className="text-slate-600">Create and manage your auctions</p>
            </div>
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
          </div>
        ) : null}

        {/* Notifications dropdown */}
        {notifyOpen && session && (
          <div className="fixed right-6 top-20 w-80 bg-white border border-slate-200 rounded-xl shadow-lg z-50">
            <div className="p-3 border-b border-slate-200 font-semibold">Notifications</div>
            <div className="max-h-96 overflow-auto">
              {notifications.length === 0 ? (
                <div className="p-4 text-sm text-slate-600">No notifications yet</div>
              ) : notifications.map((n) => (
                <div key={n.id} className="p-3 border-b border-slate-100 text-sm">
                  <div className="font-medium text-slate-900">{n.type}</div>
                  <div className="text-slate-600">
                    {n.title ? `${n.title} — ` : ''}
                    {n.amount ? `$${Number(n.amount).toFixed(2)}` : ''}
                  </div>
                  <div className="text-xs text-slate-400">{new Date(n.at || Date.now()).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Diagnostics Section - Only show on live page for admins */}
        {page === 'live' && me?.isAdmin && (
          <div className="mt-12 bg-white rounded-xl shadow-lg border border-slate-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-slate-900">System Diagnostics</h3>
              <button 
                onClick={runDiagnostics}
                className="px-4 py-2 bg-slate-600 text-white rounded-lg hover:bg-slate-700 transition-colors"
              >
                Run Checks
              </button>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Checks database, Redis, Supabase, SendGrid, and system configuration.
            </p>
            {diag && (
              <pre className="bg-slate-900 text-slate-100 p-4 rounded-lg overflow-auto text-sm">
                {JSON.stringify(diag, null, 2)}
              </pre>
            )}
          </div>
        )}
      </main>
  </div>
  </NowCtx.Provider>
  )
}