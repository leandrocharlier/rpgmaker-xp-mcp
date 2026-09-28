# Tileset transforms

`analyze_tileset_usage` and `compact_used_tileset` take `tilesetId`, a new safe
`outputName`, and an explicit tested `runtimeMaxHeight` (a multiple of 32).
`deduplicate` defaults to true: used regular tiles are deduplicated only if all
RGBA bytes, passage, priority and terrain match. Reserved IDs 0..383 and all seven
autotile slots stay unchanged. Unused regular tiles are listed explicitly.

`plan_tileset_merge` and `merge_tilesets` instead take `targetTilesetId` and
`sourceTilesetIds`. The target prefix keeps its IDs; source banks are appended in
the requested order. Their full settings, autotile names and reserved properties
must match. Conflicts are rejected, never silently resolved. Records and source
images remain in place; no prefix is skipped on assumption of similarity.

All tools default to a read-only plan with full mappings and a `planHash`.
To apply, repeat the same arguments with `dryRun:false`,
`reviewedPlanHash` equal to the returned hash, and
`acknowledgeDynamicReferences:true`. Dependency changes invalidate the plan.
The hash is a stale-plan check, not a certificate of human review.

Every on-disk map is scanned, including maps absent from MapInfos; missing indexed
maps or malformed dependencies fail closed. All layers and every tile-graphic
event page on affected banks are remapped. Event commands, page conditions and
other properties remain unchanged. Unchanged maps retain their original bytes.
Map inventory and unchanged dependency hashes are checked during commit. Changed
destinations use the transaction's original-hash checks and backups/rollback.

No scripts run or get analyzed. Runtime-generated references, scripting changes
to tilesets and external catalogs are unresolved; callers must review these before
applying. Matching autotile names does not prove asset compatibility across future
asset replacements. Test the result in the intended runtime. Compact packing is
tile-oriented and does not retain visually convenient multi-tile object grouping.

Operations bound aggregate dependency bytes to 64 MiB, affected map cells to two
million, source decode work to 32 megapixels, selected banks to 32, and use a fixed
768 MiB conservative working-set estimate before image allocation. This estimate
is not a hard process RSS ceiling. Shared file, staged-write/recovery and Table
limits still apply. Tall output requires the existing opt-in configuration.
Output must fit signed tile IDs and the explicitly provided runtime height.
PNG dimensions and exact table/image correspondence are checked before decode.

Verification: `npm run build` then `node test/tileset-transform.mjs`.
