-- Schema for Supabase Postgres (aligned with app code expected column names)

-- Enable UUID generation if not present
create extension if not exists pgcrypto;

-- Auctions table (camelCase columns)
create table if not exists public.auctions (
  id text primary key,
  "sellerId" text not null,
  title text not null,
  description text,
  "startingPrice" numeric not null,
  "bidIncrement" numeric not null default 1,
  "goLiveAt" timestamptz not null,
  "endsAt" timestamptz not null,
  "currentPrice" numeric not null,
  status text not null default 'scheduled',
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- Backfill/rename from an older snake_case schema if present
do $$ begin
  -- rename starting_price -> "startingPrice"
  if exists (
    select 1 from information_schema.columns 
    where table_schema='public' and table_name='auctions' and column_name='starting_price'
  ) then
    alter table public.auctions rename column starting_price to "startingPrice";
  end if;
  -- rename current_price -> "currentPrice"
  if exists (
    select 1 from information_schema.columns 
    where table_schema='public' and table_name='auctions' and column_name='current_price'
  ) then
    alter table public.auctions rename column current_price to "currentPrice";
  end if;
  -- rename ends_at -> "endsAt"
  if exists (
    select 1 from information_schema.columns 
    where table_schema='public' and table_name='auctions' and column_name='ends_at'
  ) then
    alter table public.auctions rename column ends_at to "endsAt";
  end if;
  -- rename created_at -> "createdAt"
  if exists (
    select 1 from information_schema.columns 
    where table_schema='public' and table_name='auctions' and column_name='created_at'
  ) then
    alter table public.auctions rename column created_at to "createdAt";
  end if;
  -- add missing columns if they don't exist
  alter table public.auctions 
    add column if not exists "sellerId" text,
    add column if not exists "bidIncrement" numeric not null default 1,
    add column if not exists "goLiveAt" timestamptz,
    add column if not exists status text not null default 'scheduled',
    add column if not exists "updatedAt" timestamptz not null default now();
  -- ensure not nulls where expected (skip if data missing)
  begin
    alter table public.auctions alter column "sellerId" set not null;
  exception when others then null; end;
  begin
    alter table public.auctions alter column "goLiveAt" set not null;
  exception when others then null; end;
  begin
    alter table public.auctions alter column "endsAt" set not null;
  exception when others then null; end;
  begin
    alter table public.auctions alter column "startingPrice" set not null;
  exception when others then null; end;
  begin
    alter table public.auctions alter column "currentPrice" set not null;
  exception when others then null; end;
end $$;

-- Updated-at trigger
create or replace function public.touch_updated_at()
returns trigger as $$
begin
  new."updatedAt" = now();
  return new;
end; $$ language plpgsql;

do $$ begin
  if not exists (
    select 1 from pg_trigger where tgname = 'trg_auctions_touch_updated_at'
  ) then
    create trigger trg_auctions_touch_updated_at
    before update on public.auctions
    for each row execute function public.touch_updated_at();
  end if;
end $$;

-- Bids table (recreate if old empty table with bigint id exists)
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema='public' and table_name='bids') then
    -- only drop if table is empty and incompatible
    perform 1 from public.bids limit 1;
    if not found then
      drop table public.bids;
    end if;
  end if;
end $$;

create table if not exists public.bids (
  id text primary key default gen_random_uuid()::text,
  "auctionId" text not null references public.auctions(id) on delete cascade,
  "bidderId" text not null,
  amount numeric not null,
  "createdAt" timestamptz not null default now()
);

-- If an older snake_case bids table survived (non-empty), attempt a light-weight rename of columns
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='bids' and column_name='auction_id') then
    begin alter table public.bids rename column auction_id to "auctionId"; exception when others then null; end;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='bids' and column_name='user_id') then
    begin alter table public.bids rename column user_id to "bidderId"; exception when others then null; end;
  end if;
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='bids' and column_name='created_at') then
    begin alter table public.bids rename column created_at to "createdAt"; exception when others then null; end;
  end if;
end $$;

create index if not exists idx_bids_auctionId_createdAt on public.bids ("auctionId", "createdAt" desc);

-- Notifications table
create table if not exists public.notifications (
  id text primary key,
  "userId" text not null,
  type text not null,
  payload jsonb,
  read boolean not null default false,
  "createdAt" timestamptz not null default now()
);
create index if not exists idx_notifications_userId_createdAt on public.notifications ("userId", "createdAt" desc);

-- Counter offers table
create table if not exists public.counter_offers (
  id text primary key,
  "auctionId" text not null references public.auctions(id) on delete cascade,
  "sellerId" text not null,
  "buyerId" text not null,
  amount numeric not null,
  status text not null default 'pending',
  "createdAt" timestamptz not null default now()
);
create index if not exists idx_counter_offers_auctionId_createdAt on public.counter_offers ("auctionId", "createdAt" desc);

-- RLS (optional): keep disabled if all access goes through server with service key
alter table public.auctions disable row level security;
alter table public.bids disable row level security;
alter table public.notifications disable row level security;
alter table public.counter_offers disable row level security;
