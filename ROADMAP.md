# Proposed asset tools

These proposals are not implemented or advertised as available tools.

- Read-only collection analysis: report unused image regions, exact duplicates,
  compatible tile-property groups, and possible packing improvements. Keep
  recommendations separate from mutations and report uncertain usage from scripts.
- `compact_used_tileset`: collect tiles used by maps and tile-based event graphics,
  preserve autotiles and passage/priority/terrain properties, and propose a compact
  atlas. Deduplicate only when pixels and relevant properties are compatible.
  Preview the full remapping first; applying must back up and atomically stage
  the image, database, maps, and event references with conflict detection and
  rollback. Verify on synthetic projects that unrelated data stays unchanged.

Neither proposal should change the conservative suffix-only behavior of
`truncate_unused_tilesets`.

## Character sheets

- Read-only inspection of explicit XP 4-by-4 character sheets: per-frame and
  per-direction bounds, bottom-center anchors, alignment drift, transparency,
  and opaque backgrounds. Do not infer XP compatibility from filename or canvas
  dimensions alone, or confuse XP layouts with MV/MZ layouts.
- Validate explicitly labeled walking, running, cycling, surfing, and fishing
  animation sets without assuming that the standard XP database defines those
  game-specific roles. Keep Essentials PBS and player metadata separate.
- Extract or convert frames using explicit source layout, frame order, target
  dimensions, and anchors. Preserve alignment, preview before/after, reject
  ambiguous layouts, and test on synthetic sheets with backups for replacements.

Current tools provide partial support only: `create_npc` and `update_map_event`
assign character graphics; `validate_assets` checks referenced filenames;
`render_map` with `drawEvents:true` previews the first event page's selected
frame using a 4-by-4 layout and bottom-center anchor. It does not validate
animation sequences or choose active pages at runtime. `classify_asset` offers
asset heuristics, not a character-sheet compatibility certificate. No dedicated
frame extraction, animation validation, or character-sheet conversion tool is
implemented yet.

## Movement boundaries and transfers

- Read-only movement auditing with explicit start cells, allowed/forbidden zones,
  required destinations, and witness paths for escapes or unexpected access.
  Positive reachability alone must not establish containment. Include a synthetic
  room surrounded by empty tile 0: reaching the room's goal can pass while the
  forbidden exterior remains reachable and must fail the boundary audit.
- Check event movement routes and transfer source/destination coordinates against
  explicitly supplied stair footprints and permitted entry/exit directions.
  Report runtime-dependent event pages, scripts, and movement rules as unknown;
  keep engine-specific passability adapters separate from standard XP semantics.

`validate_connectivity` currently checks the inter-map transfer graph and bounds,
not walkable cell containment or stair geometry. The `render_map` passability
overlay is approximate and is not a movement validator.

## Tileset merging and capacity planning

Extend the compact/remap proposal above with a read-only merge plan that reports
output height, tile IDs, source-to-target mappings, autotile-slot conflicts,
property conflicts, and image/Table/transaction budgets before any writes.
Preserve existing target IDs where possible; conflicting IDs from other banks
require explicit remapping of all affected map layers and tile-based event pages.
Preserve passage, priority, and terrain properties and reject unresolved conflicts.
Test over-budget rejection without writes, exact boundary acceptance, conflicting
autotile slots, event remapping, unchanged unrelated files, and rollback on fixtures.

Current `compose_tileset_atlas` preserves one base prefix and its existing flags;
appended pieces receive zero flags and maps are not remapped. `plan_tileset_import`
plans packing and budgets, not a property-preserving merge. Neither tool certifies
that a merged atlas will work in a particular game runtime.

The MCP has no fixed 16,384-pixel atlas height ceiling. Its image budget is
16 * 1024 * 1024 pixels, allowing 65,536 pixels of height at width 256 before
other budgets apply. It also checks signed tile IDs up to 32,767. These are MCP
validation limits, not guarantees about editor, runtime, GPU, or preview capacity.
The [XP material specification](https://www.rpg-maker.fr/dl/monos/aide/xp/source/rpgxp/material.html)
(a mirror of the XP help) describes eight 32-pixel columns and no fixed tileset
file-size limit; it does not establish a universal practical rendering limit.
A future merge plan must accept an explicit tested target-runtime height limit
and reject excess before writing, rather than infer compatibility from MCP budgets.
