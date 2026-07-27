begin;

-- The Free/nano database occasionally needs more than three seconds for the
-- first filtered page after an idle period. This remains a strict read-only
-- query ceiling and is reinforced by the Worker query timeout.
alter role mcp_runtime set statement_timeout = '8s';

commit;
