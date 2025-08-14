import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY

let sbAdmin: ReturnType<typeof createClient> | null = null
function getAdminClient() {
  if (sbAdmin) return sbAdmin
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null
  sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
  })
  return sbAdmin
}

export async function getUserEmail(userId: string): Promise<string | null> {
  const sb = getAdminClient()
  if (!sb) return null
  try {
    const res = await sb.auth.admin.getUserById(userId)
    return res.data.user?.email || null
  } catch {
    return null
  }
}

export async function getUserPhone(userId: string): Promise<string | null> {
  const sb = getAdminClient()
  if (!sb) return null
  try {
    const res = await sb.auth.admin.getUserById(userId)
    const u: any = res.data.user
    return u?.phone || u?.user_metadata?.phone || null
  } catch {
    return null
  }
}
