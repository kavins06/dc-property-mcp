begin;

revoke all on function api_v1.get_complete_property_record(text, text)
  from public, mcp_runtime;

set local role api_owner;
drop function api_v1.get_complete_property_record(text, text);
alter function api_v1._get_complete_property_record_v04(text, text)
  rename to get_complete_property_record;
grant execute on function api_v1.get_complete_property_record(text, text)
  to mcp_runtime;
reset role;

commit;
