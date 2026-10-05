begin;
alter table brand.events drop constraint events_kind_check;
alter table brand.events add constraint events_kind_check check (kind in
 ('page_open','contact_click','vcard_download','message_received','message_click','location_update'));
create or replace function public.brand_set_location(p_id uuid, p_latitude double precision, p_longitude double precision, p_accuracy double precision) returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := brand.require_owner(); previous brand.connections;
begin
  select * into previous from brand.connections where id = p_id and owner_id = uid for update;
  if not found then raise exception 'Connection unavailable'; end if;
  update brand.connections set latitude = p_latitude, longitude = p_longitude, location_accuracy = p_accuracy where id = p_id;
  insert into brand.events(id, connection_id, visitor_id, kind, details)
  values (gen_random_uuid(),p_id,uid,'location_update',jsonb_build_object(
    'from',jsonb_build_object('latitude',previous.latitude,'longitude',previous.longitude,'accuracy',previous.location_accuracy),
    'to',jsonb_build_object('latitude',p_latitude,'longitude',p_longitude,'accuracy',p_accuracy)));
end;
$$;
create or replace function public.brand_record_event(p_id uuid, p_visitor_id uuid, p_token uuid, p_kind text, p_details jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  if p_kind not in ('page_open','contact_click','vcard_download','message_received','message_click') then
    raise exception 'Unsupported visitor event';
  end if;
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

notify pgrst, 'reload schema';
commit;
