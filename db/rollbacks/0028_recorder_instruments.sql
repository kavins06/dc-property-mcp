begin;

revoke all on function api_v1.get_recorder_instrument_history(
  text,
  text,
  jsonb
) from public, mcp_runtime;

set local role api_owner;
drop function api_v1.get_recorder_instrument_history(text, text, jsonb);
reset role;

drop schema recorder cascade;

commit;
