begin;
alter table brand.messages add column sender text not null default 'owner' check (sender in ('owner','invitee'));
alter table brand.messages add column request_id uuid unique;
create function public.brand_send_invitee_message(p_token uuid, p_body text, p_request_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare cid uuid;
begin
  select id into cid from brand.connections where invite_token = p_token;
  if cid is null then raise exception 'Invalid invitation'; end if;
  if p_request_id is null then raise exception 'Message request ID required'; end if;
  if p_body is null or length(trim(p_body)) = 0 then raise exception 'Message required'; end if;
  insert into brand.messages(connection_id, body, sender, request_id)
    values (cid, p_body, 'invitee', p_request_id) on conflict (request_id) do nothing;
end;
$$;
revoke all on function public.brand_send_invitee_message(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.brand_send_invitee_message(uuid,text,uuid) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
