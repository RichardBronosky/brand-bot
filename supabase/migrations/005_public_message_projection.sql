begin;
-- Explicit allowlist: future private columns must never enter visitor responses.
create or replace function public.brand_get_messages(p_token uuid, p_after bigint default 0) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  select id into cid from brand.connections where invite_token = p_token;
  if cid is null then raise exception 'Invalid invitation'; end if;
  return coalesce((select jsonb_agg(to_jsonb(m) order by m.id) from
    (select id,created_at,body,url,sender from brand.messages where connection_id=cid and id>p_after order by id limit 100) m), '[]'::jsonb);
end;
$$;
notify pgrst, 'reload schema';
commit;
