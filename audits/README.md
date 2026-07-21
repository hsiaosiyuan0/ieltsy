# Development audits

## English Grammar Profile coverage

`pnpm audit:egp` is a development-only crosswalk audit. It reads an English Grammar Profile XLSX export supplied outside this repository, verifies the normalized data revision, and checks that every normalized A2–C1 row has one of two explicit outcomes:

- `mapped`: its EGP category and subcategory resolve to one or more existing local grammar point IDs;
- `excluded`: the source row is one of the structurally incomplete placeholders with no can-do statement.

The tracked rule file contains only our category crosswalk, local numeric IDs, aggregate counts, and the expected normalized-content hash. It does not contain EGP can-do statements, examples, guidewords, or row IDs. Optional generated manifests likewise contain hashes and decisions only and are ignored by Git. The audit deliberately does not pin the XLSX container hash: the official export can encode different workbook metadata while containing identical rows. The raw file hash is still printed for provenance.

Run with the default temporary path:

```bash
curl --fail --location \
  'https://web.archive.org/web/20230331223746id_/http://www.englishprofile.org/english-grammar-profile/egp-online?task=downloadXLS' \
  --output /tmp/english-grammar-profile.xlsx
pnpm audit:egp
```

Or provide the external workbook explicitly:

```bash
pnpm audit:egp -- --xlsx /path/to/english-grammar-profile.xlsx
EGP_XLSX_PATH=/path/to/english-grammar-profile.xlsx pnpm audit:egp
```

For a machine-readable summary or a private row-hash manifest:

```bash
pnpm audit:egp -- --json
pnpm audit:egp -- --manifest audits/generated/egp-coverage.json
```

This is a high-recall inventory crosswalk, not a claim that an EGP row and a local lesson are semantically identical. A passing result proves that the pinned export has no unclassified A2–C1 rows and that all mapped local IDs exist; qualitative review is still required when either source changes.

The pinned workbook is the Internet Archive capture of the original English Profile download endpoint from 2023-03-31. Keep the workbook outside Git. The parser accepts the original `#` / `guideword` headers and ignores fully blank trailing worksheet rows before computing the canonical content hash.
