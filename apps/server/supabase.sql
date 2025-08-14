-- Schema for Supabase Postgres
create table if not exists public.auctions (
  id text primary key,
  title text not null,
  description text,
  starting_price numeric not null,
  current_price numeric not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bids (
  id bigint generated always as identity primary key,
  auction_id text not null references public.auctions(id) on delete cascade,
  user_id text not null,
  amount numeric not null,
  created_at timestamptz not null default now()
);

-- RLS examples (enable and adapt to your auth model)
-- alter table public.auctions enable row level security;
-- alter table public.bids enable row level security;
