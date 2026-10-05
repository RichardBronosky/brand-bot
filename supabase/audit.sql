\set ON_ERROR_STOP on
-- Read-only assertions against the actual hosted schema, not a mock.
begin read only;
do $$
declare r record; role_name text; allowed boolean;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if has_schema_privilege(role_name,'brand','USAGE') then raise exception 'Browser role has private schema access: %',role_name; end if;
    for r in select c.oid,c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='brand' and c.relkind='r' loop
      if not r.relrowsecurity then raise exception 'RLS disabled on %',r.relname; end if;
      if has_table_privilege(role_name,r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') then raise exception 'Browser table grant on % for %',r.relname,role_name; end if;
    end loop;
  end loop;
  for r in select p.oid,p.proname,p.prosecdef,p.proconfig,p.proacl,p.proowner from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'brand_%' loop
    if not r.prosecdef or not ('search_path=""'=any(r.proconfig)) then raise exception 'Unsafe definer/search_path: %',r.proname; end if;
    if exists(select 1 from aclexplode(coalesce(r.proacl,acldefault('f',r.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') then raise exception 'PUBLIC execute on %',r.proname; end if;
    allowed := r.proname in ('brand_record_event','brand_get_messages','brand_get_conversation_label','brand_send_invitee_message');
    if has_function_privilege('anon',r.oid,'EXECUTE') <> allowed then raise exception 'Unexpected anonymous grant: %',r.proname; end if;
    if not has_function_privilege('authenticated',r.oid,'EXECUTE') then raise exception 'Missing authenticated grant: %',r.proname; end if;
  end loop;
  if has_function_privilege('anon','brand.require_owner()','EXECUTE') or has_function_privilege('authenticated','brand.require_owner()','EXECUTE') then raise exception 'Private owner helper exposed'; end if;
end $$;
select 'PASS live table/RLS/schema/function grants and fixed search paths' as result;
rollback;
