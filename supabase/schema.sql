-- Run once in the Supabase SQL editor. Data stays in an unexposed schema;
-- browsers can only execute the explicitly granted functions below.
begin;
create schema if not exists brand;
revoke all on schema brand from public, anon, authenticated;

create table brand.owners (
  user_id uuid primary key references auth.users(id) on delete cascade
);
create table brand.connections (
  id uuid primary key default gen_random_uuid(),
  invite_token uuid not null unique default gen_random_uuid(),
  owner_id uuid not null references brand.owners(user_id),
  created_at timestamptz not null default now(),
  latitude double precision check (latitude between -90 and 90),
  longitude double precision check (longitude between -180 and 180),
  location_accuracy double precision check (location_accuracy >= 0),
  label text not null default '' check (length(label) <= 200),
  notes text not null default '' check (length(notes) <= 20000)
);
create table brand.events (
  id uuid primary key,
  connection_id uuid references brand.connections(id) on delete cascade,
  visitor_id uuid not null,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('page_open', 'contact_click', 'vcard_download', 'message_received', 'message_click')),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4096)
);
create index on brand.events(connection_id, created_at desc);
create index on brand.events(created_at desc) where connection_id is null;
create table brand.messages (
  id bigint generated always as identity primary key,
  connection_id uuid not null references brand.connections(id) on delete cascade,
  created_at timestamptz not null default now(),
  body text not null check (length(body) between 1 and 4000),
  url text check (length(url) <= 2000 and url ~* '^https?://')
);
create index on brand.messages(connection_id, id);
create table brand.bugs (
  id uuid primary key,
  owner_id uuid not null references brand.owners(user_id),
  connection_id uuid references brand.connections(id) on delete set null,
  created_at timestamptz not null default now(),
  description text not null check (length(description) between 1 and 4000),
  context jsonb not null check (jsonb_typeof(context) = 'object' and octet_length(context::text) <= 16000)
);
-- Defense in depth: no direct table access, even if later exposed accidentally.
alter table brand.owners enable row level security;
alter table brand.connections enable row level security;
alter table brand.events enable row level security;
alter table brand.messages enable row level security;
alter table brand.bugs enable row level security;
revoke all on all tables in schema brand from public, anon, authenticated;
revoke all on all sequences in schema brand from public, anon, authenticated;

create function brand.require_owner() returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not exists (select 1 from brand.owners where user_id = auth.uid()) then
    raise exception 'Owner sign-in required' using errcode = '42501';
  end if;
  return auth.uid();
end;
$$;
revoke all on function brand.require_owner() from public, anon, authenticated;

create function public.brand_create_connection() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c brand.connections;
begin
  insert into brand.connections(owner_id) values (brand.require_owner()) returning * into c;
  return to_jsonb(c);
end;
$$;

create function public.brand_update_connection(p_id uuid, p_label text, p_notes text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update brand.connections set label = p_label, notes = p_notes
    where id = p_id and owner_id = brand.require_owner();
  if not found then raise exception 'Connection unavailable'; end if;
end;
$$;

create function public.brand_set_location(p_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy double precision) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update brand.connections set latitude = p_latitude, longitude = p_longitude, location_accuracy = p_accuracy
    where id = p_id and owner_id = brand.require_owner();
  if not found then raise exception 'Connection unavailable'; end if;
end;
$$;

create function public.brand_record_event(p_id uuid, p_visitor_id uuid, p_token uuid, p_kind text, p_details jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  -- Null token: unsolicited UI telemetry only. Never creates a connection.
  if p_token is not null then
    select id into cid from brand.connections where invite_token = p_token;
    if cid is null then raise exception 'Invalid invitation'; end if;
  elsif p_kind not in ('page_open', 'contact_click', 'vcard_download') then
    raise exception 'Invitation required for message events';
  end if;
  insert into brand.events(id, connection_id, visitor_id, kind, details)
    values (p_id, cid, p_visitor_id, p_kind, p_details)
    on conflict (id) do nothing;
end;
$$;

create function public.brand_get_messages(p_token uuid, p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  select id into cid from brand.connections where invite_token = p_token;
  if cid is null then raise exception 'Invalid invitation'; end if;
  return coalesce((select jsonb_agg(to_jsonb(m) - 'connection_id' order by m.id) from
    (select * from brand.messages where connection_id = cid and id > p_after order by id limit 100) m), '[]'::jsonb);
end;
$$;

create function public.brand_list_connections() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := brand.require_owner();
begin
  return coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at desc) from
    (select c.id, c.label, c.created_at, (select count(*) from brand.events e where e.connection_id = c.id and e.kind = 'page_open') as opens
     from brand.connections c where owner_id = uid order by created_at desc limit 100) c), '[]'::jsonb);
end;
$$;

create function public.brand_get_connection(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c brand.connections;
begin
  select * into c from brand.connections where id = p_id and owner_id = brand.require_owner();
  if c.id is null then raise exception 'Connection unavailable'; end if;
  return jsonb_build_object('connection', to_jsonb(c),
    'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from
      (select * from brand.events where connection_id = p_id order by created_at desc limit 200) e), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from
      (select * from brand.messages where connection_id = p_id order by id desc limit 100) m), '[]'::jsonb));
end;
$$;

create function public.brand_send_message(p_id uuid, p_body text, p_url text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from brand.connections where id = p_id and owner_id = brand.require_owner()) then
    raise exception 'Connection unavailable';
  end if;
  insert into brand.messages(connection_id, body, url) values (p_id, p_body, nullif(p_url, ''));
end;
$$;

create function public.brand_get_public_events() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform brand.require_owner();
  return coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at desc) from
    (select * from brand.events where connection_id is null order by created_at desc limit 200) e), '[]'::jsonb);
end;
$$;

create function public.brand_report_bug(p_id uuid, p_connection_id uuid, p_description text, p_context jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := brand.require_owner();
begin
  if p_connection_id is not null and not exists (select 1 from brand.connections where id = p_connection_id and owner_id = uid) then
    raise exception 'Connection unavailable';
  end if;
  insert into brand.bugs(id, owner_id, connection_id, description, context)
    values (p_id, uid, p_connection_id, p_description, p_context) on conflict (id) do nothing;
end;
$$;

create function public.brand_list_bugs() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := brand.require_owner();
begin
  return coalesce((select jsonb_agg(to_jsonb(b) order by b.created_at desc) from
    (select * from brand.bugs where owner_id = uid order by created_at desc limit 100) b), '[]'::jsonb);
end;
$$;

-- Functions default to PUBLIC execute in PostgreSQL. Revoke each explicitly.
revoke all on function public.brand_create_connection() from public, anon, authenticated;
revoke all on function public.brand_update_connection(uuid,text,text) from public, anon, authenticated;
revoke all on function public.brand_set_location(uuid,double precision,double precision,double precision) from public, anon, authenticated;
revoke all on function public.brand_record_event(uuid,uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.brand_get_messages(uuid,bigint) from public, anon, authenticated;
revoke all on function public.brand_list_connections() from public, anon, authenticated;
revoke all on function public.brand_get_connection(uuid) from public, anon, authenticated;
revoke all on function public.brand_send_message(uuid,text,text) from public, anon, authenticated;
revoke all on function public.brand_get_public_events() from public, anon, authenticated;
revoke all on function public.brand_report_bug(uuid,uuid,text,jsonb) from public, anon, authenticated;
revoke all on function public.brand_list_bugs() from public, anon, authenticated;

grant execute on function public.brand_record_event(uuid,uuid,uuid,text,jsonb), public.brand_get_messages(uuid,bigint) to anon, authenticated;
grant execute on function public.brand_create_connection(), public.brand_update_connection(uuid,text,text),
  public.brand_set_location(uuid,double precision,double precision,double precision), public.brand_list_connections(),
  public.brand_get_connection(uuid), public.brand_send_message(uuid,text,text), public.brand_get_public_events(),
  public.brand_report_bug(uuid,uuid,text,jsonb), public.brand_list_bugs() to authenticated;
commit;
