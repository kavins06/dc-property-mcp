begin;

do $contract$
declare
  v_permit_constraint text;
  v_license_constraint text;
begin
  select pg_get_constraintdef(c.oid)
  into v_permit_constraint
  from pg_constraint c
  where c.conrelid = 'regulatory.building_permit'::regclass
    and c.conname = 'building_permit_record_kind_check';

  if v_permit_constraint is null
     or v_permit_constraint not like '%public_space_construction_permit%'
     or v_permit_constraint not like '%public_space_occupancy_permit%'
     or v_permit_constraint not like '%home_occupancy_permit%'
     or v_permit_constraint not like '%special_tree_permit%'
     or v_permit_constraint not like '%public_space_rental_permit%'
     or v_permit_constraint not like '%emergency_work_request%'
     or v_permit_constraint not like '%well_permit%' then
    raise exception
      'Typed permit discriminator does not cover every supported permit family: %',
      v_permit_constraint;
  end if;

  select pg_get_constraintdef(c.oid)
  into v_license_constraint
  from pg_constraint c
  where c.conrelid = 'regulatory.business_license'::regclass
    and c.conname = 'business_license_record_kind_check';

  if v_license_constraint is null
     or v_license_constraint not like '%business_license%'
     or v_license_constraint not like '%alcohol_license%'
     or v_license_constraint not like '%cannabis_license%' then
    raise exception
      'Typed license discriminator does not cover every supported license family: %',
      v_license_constraint;
  end if;
end;
$contract$;

rollback;
