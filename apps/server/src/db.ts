import { createClient } from '@supabase/supabase-js'

// Server-side Supabase client: prefer service role for admin ops; fall back to anon in dev
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || ''
export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
)
