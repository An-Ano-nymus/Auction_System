import { createClient } from '@supabase/supabase-js';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY;
const sb = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
export async function getAuthUser(req) {
    const allowDevHeader = process.env.ALLOW_DEV_HEADER === 'true' || process.env.NODE_ENV !== 'production';
    // Prefer Supabase Auth via Authorization: Bearer <access_token>
    if (sb) {
        const auth = req.headers['authorization'];
        if (auth) {
            const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
            if (!token)
                return null;
            const { data, error } = await sb.auth.getUser(token);
            if (error || !data?.user)
                return null;
            return { id: data.user.id };
        }
        // Fallback: honor x-user-id header if present (useful for non-auth test clients)
        const xid = req.headers['x-user-id'];
        if (typeof xid === 'string' && xid)
            return { id: xid };
        return null;
    }
    // No Supabase configured -> dev fallback
    const id = req.headers['x-user-id'];
    if (typeof id === 'string' && id)
        return { id };
    return null;
}
