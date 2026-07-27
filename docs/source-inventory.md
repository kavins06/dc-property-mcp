# Canonical source inventory

| Source | Rows | Columns | Extract-date range | SHA-256 |
| --- | ---: | ---: | --- | --- |
| `itspe_2017_archive` | 218,027 | 208 | 2017-02-04 to 2017-02-04 | `ee9915a77d8bab591b8bb12c99bf148142a1c19a7e74eb21df02aeec8a4bb845` |
| `itspe_2021_archive` | 212,841 | 218 | 2021-10-08 to 2021-11-23 | `244868a74ca3f82ba8abcca24c987d8e0c5c4635b94d3c4a171a4f920355d1f6` |
| `itspe_current` | 221,263 | 218 | 2024-03-01 to 2026-06-22 | `7c9c083bdabf28b2b1c161c1b80d02841f7862f1ff0b90b28d8576b663351719` |
| `cama_sales_current` | 421,445 | 9 | 1900-01-01 to 2026-07-14 | `102dd0c19d7d1f99ea7650b2209a6e2f35a56145c1cc88c30a8f4dedd57a224a` |

Focused exports and `assessment_history_available.csv` are derived artifacts,
not independent canonical inputs. Assessment history is rebuilt from the raw
snapshots because the old normalized file overloaded snapshot timing.
