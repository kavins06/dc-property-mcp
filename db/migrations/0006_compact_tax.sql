begin;

set local role api_owner;
drop function if exists api_v1.get_tax_and_balance_history(text, text);
reset role;

create table if not exists history.tax_series_compact (
  account_id bigint primary key
    references core.property_account_current on delete cascade,
  source_row_number integer not null,
  record_extract_at date,
  tax_year_anchor smallint not null,
  values_cents integer[] not null
    check (cardinality(values_cents) = 96)
);

create table if not exists history.tax_value_overflow (
  account_id bigint not null
    references core.property_account_current on delete cascade,
  value_index smallint not null check (value_index between 1 and 96),
  value_cents bigint not null,
  primary key (account_id, value_index)
);

create table if not exists history.tax_sale_flag (
  account_id bigint not null
    references core.property_account_current on delete cascade,
  slot_ordinal smallint not null check (slot_ordinal between 1 and 12),
  flag text not null,
  primary key (account_id, slot_ordinal)
);

insert into history.tax_value_overflow (account_id, value_index, value_cents)
select t.account_id, u.ordinality::smallint, u.value_cents
from history.tax_series t
cross join lateral unnest(
  t.tax_cents
  || t.penalty_cents
  || t.interest_cents
  || t.fee_cents
  || t.total_due_cents
  || t.collected_cents
  || t.balance_cents
  || t.credit_cents
) with ordinality as u(value_cents, ordinality)
where u.value_cents > 2147483647
   or u.value_cents < -2147483648
on conflict (account_id, value_index) do update
set value_cents = excluded.value_cents;

insert into history.tax_sale_flag (account_id, slot_ordinal, flag)
select t.account_id, u.ordinality::smallint, u.flag
from history.tax_series t
cross join lateral unnest(t.tax_sale_flags)
  with ordinality as u(flag, ordinality)
where u.flag is not null
on conflict (account_id, slot_ordinal) do update
set flag = excluded.flag;

insert into history.tax_series_compact (
  account_id,
  source_row_number,
  record_extract_at,
  tax_year_anchor,
  values_cents
)
select
  t.account_id,
  t.source_row_number,
  t.record_extract_at,
  t.tax_years[1],
  array(
    select case
      when u.value_cents between -2147483648 and 2147483647
        then u.value_cents::integer
      else null
    end
    from unnest(
      t.tax_cents
      || t.penalty_cents
      || t.interest_cents
      || t.fee_cents
      || t.total_due_cents
      || t.collected_cents
      || t.balance_cents
      || t.credit_cents
    ) with ordinality as u(value_cents, ordinality)
    order by u.ordinality
  )
from history.tax_series t
on conflict (account_id) do update
set
  source_row_number = excluded.source_row_number,
  record_extract_at = excluded.record_extract_at,
  tax_year_anchor = excluded.tax_year_anchor,
  values_cents = excluded.values_cents;

drop table history.tax_series;
alter table history.tax_series_compact rename to tax_series;

grant select on history.tax_series to api_owner;
grant select on history.tax_value_overflow to api_owner;
grant select on history.tax_sale_flag to api_owner;

commit;
