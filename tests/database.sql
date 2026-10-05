\set ON_ERROR_STOP on
\o /dev/null
-- Disposable local database: emulate Supabase Auth identities and API roles.
create role anon;
create role authenticated;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql stable as
  $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
\ir ../supabase/schema.sql
insert into auth.users values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222'), ('33333333-3333-4333-8333-333333333333');
insert into brand.owners values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
create function public.expect_failure(query text, expected_state text) returns void language plpgsql as $$
begin
  begin
    execute query;
  exception when others then
    if sqlstate = expected_state then return; end if;
    raise;
  end;
  raise exception 'Unexpected permission granted: %', query;
end;
$$;

set role anon;
select expect_failure('select * from brand.connections', '42501');
select expect_failure('select * from brand.events', '42501');
select expect_failure('select public.brand_create_connection()', '42501');
select expect_failure('select public.brand_list_connections()', '42501');
select expect_failure('select public.brand_get_public_events()', '42501');
select expect_failure('select public.brand_list_bugs()', '42501');
select public.brand_record_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',null,'contact_click','{"label":"Email"}');
-- A retry must not duplicate the event.
select public.brand_record_event('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',null,'contact_click','{"label":"Email"}');
select expect_failure($q$select public.brand_record_event(gen_random_uuid(),gen_random_uuid(),null,'message_received','{}')$q$, 'P0001');
select expect_failure($q$select public.brand_record_event(gen_random_uuid(),gen_random_uuid(),null,'arbitrary_kind','{}')$q$, 'P0001');
select expect_failure($q$select public.brand_record_event(gen_random_uuid(),gen_random_uuid(),'cccccccc-cccc-4ccc-8ccc-cccccccccccc','page_open','{}')$q$, 'P0001');
select expect_failure($q$select public.brand_get_messages(null,0)$q$, 'P0001');
select expect_failure($q$select public.brand_get_messages('cccccccc-cccc-4ccc-8ccc-cccccccccccc',0)$q$, 'P0001');
reset role;
do $$begin if (select count(*) from brand.events) <> 1 then raise exception 'Event deduplication failed'; end if; end$$;

set role authenticated;
set request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
select expect_failure('select public.brand_create_connection()', '42501');
select expect_failure('select public.brand_list_connections()', '42501');
select expect_failure('select public.brand_get_public_events()', '42501');
set request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select public.brand_create_connection() as connection \gset
select (:'connection'::jsonb->>'id') as id, (:'connection'::jsonb->>'invite_token') as token \gset
select public.brand_update_connection(:'id','Person at meetup','Private note never exposed to guest');
select public.brand_set_location(:'id',29.96,-90.06,25);
select public.brand_send_message(:'id','Project we discussed','https://example.org/project');
select public.brand_report_bug('dddddddd-dddd-4ddd-8ddd-dddddddddddd',:'id','QR screen problem','{"screen":"qr"}');
select expect_failure(format('select public.brand_send_message(%L,%L,%L)', :'id','Unsafe URL','javascript:alert(1)'), '23514');
select expect_failure(format('select public.brand_set_location(%L,100,0,1)', :'id'), '23514');
select public.brand_get_connection(:'id');
select public.brand_get_public_events();
select public.brand_list_bugs();
set request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select expect_failure(format('select public.brand_get_connection(%L)', :'id'), 'P0001');
select expect_failure(format('select public.brand_update_connection(%L,%L,%L)', :'id','Wrong owner',''), 'P0001');
select expect_failure(format('select public.brand_send_message(%L,%L,null)', :'id','Wrong owner'), 'P0001');
do $$begin if public.brand_list_bugs() <> '[]'::jsonb then raise exception 'Other owner bugs leaked'; end if; end$$;
reset role;
set role anon;
select public.brand_record_event(gen_random_uuid(),gen_random_uuid(),:'token','page_open','{}');
select public.brand_get_messages(:'token',0) as messages \gset
select expect_failure(format('select public.brand_get_connection(%L)', :'id'), '42501');
select expect_failure(format('select public.brand_send_message(%L,%L,null)', :'id','Guest spoof'), '42501');
reset role;
select set_config('test.messages', :'messages', false);
do $$declare m jsonb := current_setting('test.messages')::jsonb; begin
  if jsonb_array_length(m) <> 1 or m::text like '%Private note%' or m::text like '%latitude%' or m::text like '%invite_token%' then
    raise exception 'Guest message scope failed';
  end if;
  if (select count(*) from brand.connections) <> 1 then raise exception 'Public event created a conversation'; end if;
  if (select count(*) from brand.events) <> 2 then raise exception 'Invited event not recorded'; end if;
end$$;
\o
\echo PASS: public event-only writes, token-scoped messages, owner isolation, constraints and retries
