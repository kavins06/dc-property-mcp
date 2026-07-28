begin;

revoke all on function api_v1.get_complete_property_record(text, text)
  from public, mcp_runtime;

set local role api_owner;
drop function api_v1.get_complete_property_record(text, text);
reset role;

commit;
