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
