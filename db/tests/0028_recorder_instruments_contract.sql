begin;

do $contract$
begin
  if not exists (
    select 1
    from information_schema.tables
    where table_schema = 'recorder'
      and table_name = 'instrument'
  ) then
    raise exception 'Recorder instrument table is missing';
  end if;

  if has_schema_privilege('mcp_runtime', 'recorder', 'usage')
     or has_table_privilege(
       'mcp_runtime',
       'recorder.instrument',
       'select'
     )
     or has_table_privilege(
       'public',
       'recorder.instrument',
       'select'
     ) then
    raise exception 'Recorder serving tables are directly readable';
  end if;

  if not has_function_privilege(
    'mcp_runtime',
    'api_v1.get_recorder_instrument_history(text,text,jsonb)',
    'execute'
  ) or has_function_privilege(
    'public',
    'api_v1.get_recorder_instrument_history(text,text,jsonb)',
    'execute'
  ) then
    raise exception 'Recorder API function privileges are incorrect';
  end if;

  if col_description(
    'recorder.instrument'::regclass,
    (
      select ordinal_position
      from information_schema.columns
      where table_schema = 'recorder'
        and table_name = 'instrument'
        and column_name = 'indexed_consideration_cents'
    )
  ) not ilike '%not automatically a loan amount%' then
    raise exception 'Recorder consideration caveat is missing';
  end if;
end;
$contract$;

rollback;
