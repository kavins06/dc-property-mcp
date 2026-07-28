begin;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'data_owner') then
    create role data_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'api_owner') then
    create role api_owner nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'mcp_runtime') then
    create role mcp_runtime login password null;
  end if;
end
$$;

do $$
begin
  execute format(
    'grant api_owner to %I with set true, inherit false',
    current_user
  );
  execute format(
    'grant data_owner to %I with set true, inherit false',
    current_user
  );
  execute format(
    'grant mcp_runtime to %I with set true, inherit false',
    current_user
  );
end
$$;

alter role mcp_runtime set default_transaction_read_only = on;
alter role mcp_runtime set statement_timeout = '3s';
alter role mcp_runtime set idle_in_transaction_session_timeout = '5s';
alter role mcp_runtime set search_path = pg_catalog, api_v1;

revoke all on schema meta, core, history, semantic from mcp_runtime;
revoke all on all tables in schema meta, core, history, semantic from mcp_runtime;
revoke all on all sequences in schema meta, core, history, semantic from mcp_runtime;
grant usage on schema core, history, semantic, meta, extensions to api_owner;
grant usage, create on schema api_v1 to api_owner;
grant select on all tables in schema core, history, semantic, meta to api_owner;
grant usage on schema api_v1 to mcp_runtime;
grant execute on function api_v1.resolve_property(text, text, boolean, integer)
  to mcp_runtime;

alter function api_v1.resolve_property(text, text, boolean, integer)
  owner to api_owner;

revoke create on schema public from public;

commit;
