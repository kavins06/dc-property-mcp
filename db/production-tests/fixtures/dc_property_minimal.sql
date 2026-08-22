\set ON_ERROR_STOP on

grant data_owner, api_owner to dc_property_admin;
grant create on database dc_property to dc_property_admin;

create schema extensions authorization dc_property_admin;
create schema meta authorization dc_property_admin;
create schema core authorization data_owner;
create schema api_v1 authorization api_owner;
grant usage on schema api_v1 to mcp_runtime;

grant usage on schema core to dc_property_admin;
grant usage, create on schema meta to dc_property_admin;
grant usage on schema meta to data_owner;
grant usage on schema meta to api_owner;
grant usage on schema api_v1 to dc_property_admin;

create table meta.source_release (
  release_id bigint primary key,
  source_id text not null
);
alter table meta.source_release owner to data_owner;
grant select, references on meta.source_release to dc_property_admin;

create table meta.source_release_pointer (
  source_id text not null,
  pointer_name text not null,
  release_id bigint not null references meta.source_release(release_id),
  primary key (source_id, pointer_name)
);
alter table meta.source_release_pointer owner to data_owner;
grant select on meta.source_release_pointer to dc_property_admin;

create table core.property_account_current (
  account_id bigint primary key,
  ssl_normalized text not null unique,
  ssl_display text not null,
  is_deleted boolean not null default false
);
alter table core.property_account_current owner to data_owner;
grant select, references on core.property_account_current to dc_property_admin;

insert into meta.source_release (release_id, source_id)
values (1, 'fixture');
insert into meta.source_release_pointer (source_id, pointer_name, release_id)
values ('fixture', 'current', 1);
insert into core.property_account_current (
  account_id, ssl_normalized, ssl_display, is_deleted
) values (1, '01070075', '0107 0075', false);
