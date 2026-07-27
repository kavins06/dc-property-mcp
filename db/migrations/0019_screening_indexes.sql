begin;

create index if not exists property_account_screen_type_tax_idx
  on core.property_account_current (property_type, tax_class)
  where not is_deleted;

create index if not exists property_account_screen_ward_tax_idx
  on core.property_account_current (ward, tax_class)
  where not is_deleted;

comment on index core.property_account_screen_type_tax_idx is
  'Compact partial index for validated property-type and tax-class lender screening.';

comment on index core.property_account_screen_ward_tax_idx is
  'Compact partial index for validated ward and tax-class lender screening.';

analyze core.property_account_current;

do $$
begin
  assert pg_database_size(current_database()) <= 480000000,
    'screening indexes exceed the 480 MB free-tier safety gate';
end
$$;

commit;
