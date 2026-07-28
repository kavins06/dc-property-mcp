begin;

-- The generic regulatory record intentionally distinguishes each official
-- permit and licence family.  The typed child tables are shared projections,
-- so their discriminator checks must accept every compatible generic kind.
alter table regulatory.building_permit
  drop constraint if exists building_permit_record_kind_check;

alter table regulatory.building_permit
  add constraint building_permit_record_kind_check
  check (
    record_kind in (
      'building_permit',
      'public_space_construction_permit',
      'public_space_occupancy_permit',
      'home_occupancy_permit',
      'special_tree_permit',
      'public_space_rental_permit',
      'emergency_work_request',
      'well_permit'
    )
  );

alter table regulatory.business_license
  drop constraint if exists business_license_record_kind_check;

alter table regulatory.business_license
  add constraint business_license_record_kind_check
  check (
    record_kind in (
      'business_license',
      'alcohol_license',
      'cannabis_license'
    )
  );

comment on table regulatory.building_permit is
  'Typed projection shared by DOB building permits and compatible official DDOT, DOB home-occupancy, tree, emergency-work, and DOEE well permit records; record_kind preserves the publishing family.';

comment on table regulatory.business_license is
  'Typed projection shared by DLCP basic-business and ABCA alcohol/cannabis licensed-location records; record_kind preserves the publishing family.';

commit;
