begin;
create function public.brand_get_conversation_label(p_token uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare title text;
begin
  select label into title from brand.connections where invite_token = p_token;
  if not found then raise exception 'Invalid invitation'; end if;
  return title;
end;
$$;
revoke all on function public.brand_get_conversation_label(uuid) from public, anon, authenticated;
grant execute on function public.brand_get_conversation_label(uuid) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
