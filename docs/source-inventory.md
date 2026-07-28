# Canonical source inventory

## Property-account and sale inputs

| Source | Rows | Columns | Extract-date range | SHA-256 |
| --- | ---: | ---: | --- | --- |
| `itspe_current` | 221,263 | 218 | 2024-03-01 to 2026-06-22 | `7c9c083bdabf28b2b1c161c1b80d02841f7862f1ff0b90b28d8576b663351719` |
| `cama_sales_current` | 421,445 | 9 | 1900-01-01 to 2026-07-14 | `102dd0c19d7d1f99ea7650b2209a6e2f35a56145c1cc88c30a8f4dedd57a224a` |

Focused exports and `assessment_history_available.csv` are derived artifacts,
not independent canonical inputs and are not part of the active build.
Assessment values come from the current ITSPE account record: TY2025 prior,
TY2026 current, and TY2027 proposed.

## Official regulatory release

The approved normalized run is
`data/regulatory/generated/dc_official_regulatory_20260728_s3`. It contains 38
official source releases:

| Source family | Sources | Coverage |
| --- | ---: | --- |
| DOB annual building permits | 18 | calendar years 2009–2026 |
| DOB certificate of occupancy | 1 | current official extract |
| DLCP basic business licenses | 1 | licensed activity at reported premises |
| CAMA building profiles | 3 | commercial, condominium, and residential |
| DOEE energy and BEPS | 2 | benchmarking and performance standards |
| DOB vacant/blighted addresses | 1 | classifications and reported exemptions |
| DDOT/TOPS public-space activity | 7 | construction, occupancy, inspections, trees, rentals, and emergency work |
| DOB home-occupancy permits | 1 | official permit records |
| DOEE well permits | 1 | official permit records |
| ABCA alcohol/cannabis licenses | 3 | alcohol, cannabis retailer, and cannabis non-retailer |
| **Total** | **38** | |

The immutable raw acquisitions total 318,669,845 compressed bytes. Their
3,623,995 source rows normalize to 2,600,666 served records and 5,862,456
property-account links. The linker reports 945,074 exact records, 1,655,592
contextual records, 27,145 capped ambiguous records, and 996,184 unlinked
records. Ambiguous and unlinked records are excluded from serving but remain
preserved in the canonical raw acquisitions.

The canonical manifest SHA-256 is:

```text
60496f01cbd5dcd15eb8c5755ef603711ff929e6638fcc0b2095d620ba514666
```

It binds `property_account_current.csv.gz` at 221,263 rows and SHA-256
`89e1544edf01a0a32ef97a8394174ae85d7e04462dfc93ba40dca6f83c70e253`.

## Normalized artifact contract

The normalized artifacts total 501,651,625 compressed bytes:

| Artifact | Rows | Bytes | File SHA-256 | Canonical-row SHA-256 |
| --- | ---: | ---: | --- | --- |
| `source_assets.csv.gz` | 38 | 6,364 | `77523132da0a078ba2db84fe636e85934e0265bfaee1e7c0a0b1e441c55eca9e` | `862eec5762966b8df22b041c25c22b204cd75e3e70241b8a48e19c9a4d3ff890` |
| `source_releases.csv.gz` | 38 | 7,619 | `8f7e12ccc070cd01c376109ab15b32921147b22c2a7748a3c60ffe32a4663b48` | `156ec234eea49bfc29a43203cc269d5c9f6d51add20994cfdd5d11007b30862d` |
| `regulatory_records.csv.gz` | 2,378,628 | 415,470,273 | `6850ab45dfe911d878c7677b86b1123c02b5838ac58a66875545500dcd506b76` | `048ab028aaaf39a8223b9130ed3c58ab0c58b2ba9899ebe64ffc2c6d64110535` |
| `property_context_records.csv.gz` | 222,038 | 22,260,403 | `487a90101489e20d82838bd0550f9e212b2e4f3bcca76a7f33a366f7efb991a6` | `eb1878c8825d881c333d4725544d9ed037916f1e56cc8e291a783142fda4b152` |
| `source_record_links.csv.gz` | 5,862,456 | 63,907,287 | `09043c20f0d72c87821177397dfbccb663a26fafc8254cd7ae18f24b39fb3da8` | `a497e143d85db0fd855d29096fc03871a9b2348f3ac498f0e695114ecfde7d51` |

Every source release key is content-addressed as `arcgis-<sha256>`. The manifest
binds each source/release hash and every artifact’s bytes, row count, file hash,
and canonical-row hash. The loader independently rechecks these values and the
live core-account mapping before it may create a hidden batch.

Raw acquisitions, the acquisition manifest, this normalized run, verification
reports, and application backups are archived in the private `quoindata`
Hetzner S3-compatible bucket. PostgreSQL release metadata is not the sole
archive.
