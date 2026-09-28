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

## Source scale and visual import review

Add explicit review evidence to future import manifests: source grid size
(for example 16 or 32 pixels, or unknown), confirmed scale, nearest-neighbor
conversion, reviewer status, and the evidence supporting each decision.
Classify pieces explicitly as modular tile, object, example scene, credits, or
unreviewed. Successful PNG loading, a 256-pixel canvas width, gutter-based
extraction, and successful runtime rendering do not establish visual suitability.
Do not automatically accept or normalize an unknown grid or scale.

Provide contact sheets comparing original and proposed pieces against a 32-pixel
grid and a neutral 32-by-48-pixel human reference. Exact integer-upscale detection
may provide a clue, but must not assign semantic types or approve scale on its own.
Keep review evidence tied to the source and crop so derived pieces retain their
provenance. Changes to crop or scale should invalidate the affected review.

Synthetic acceptance fixtures should include a miniature complete room that must
remain unreviewed or be marked as an example scene, a confirmed 16-pixel modular
source enlarged 2x with nearest-neighbor, native 32-pixel art kept at 1x, and a
credit panel excluded from playable tile candidates. These are proposed curation
checks, not a reported defect in `compose_tileset_atlas` or an implemented gate.

Extend this review with coverage accounting for every source and identified
region: included, duplicate-of (with a resolvable target), excluded demo/credits
(with a reason), or pending. Report the full source inventory and region counts
by status; distinguish a curated selection from complete collection coverage.
Unreviewed sources and unclassified regions must remain visible as pending,
and style preferences must not silently drop otherwise valid material.

Provide a navigable source-to-tileset index linking each included region to its
destination rows and tile IDs, with reviewed labels for finding stairs, furniture,
and other objects in long palettes. Preserve duplicate links and exclusion reasons
in the index. Add a mixed synthetic sheet containing valid objects, an example
scene, credits, and duplicates; verify every region has an accounted-for status,
links resolve to the correct output rows, and partial review is never reported
as complete coverage. These extend the proposed provenance review; they do not
describe a defect in the current composition tool or an implemented audit.

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
  Distinguish standing on an event cell from reaching a valid approach that
  activates it. A player-touch event may activate after an attempted lateral move
  into a blocked cell; ordinary walkability BFS alone cannot reject that transfer.
  Keep collision/approach checks separate from actual event activation tests.
  Add a synthetic side-entry staircase fixture with an impassable trigger cell:
  verify both travel directions in the target runtime, transfer completion,
  restored player visibility, and released movement/direction locks. Preserve
  the intended side-entry artwork and route instead of assuming frontal access.

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

The MCP has no fixed 16,384-pixel atlas height ceiling. Its default image budget is
16 * 1024 * 1024 pixels, allowing 65,536 pixels of height at width 256 before
other budgets apply. It also checks signed tile IDs up to 32,767. These are MCP
validation limits, not guarantees about editor, runtime, GPU, or preview capacity.
The [XP material specification](https://www.rpg-maker.fr/dl/monos/aide/xp/source/rpgxp/material.html)
(a mirror of the XP help) describes eight 32-pixel columns and no fixed tileset
file-size limit; it does not establish a universal practical rendering limit.
A future merge plan must accept an explicit tested target-runtime height limit
and reject excess before writing, rather than infer compatibility from MCP budgets.

### Tall XP atlas support and remaining merge work

Bounded tall input/output is now available through the explicit
`RPGMAKER_ALLOW_TALL_XP_TILESETS=1` configuration; see
[security limits](SECURITY.md#opt-in-tall-xp-tilesets). A semantic merge and a hard
total-process-memory ceiling remain unimplemented. The constraints below describe
the broader merge design, not additional guarantees of the current pixel budget.

The signed positive tile-ID model permits up to 4,048 regular rows: height
129,536 at width 256, 33,161,216 pixels, and 126.5 MiB for one RGBA buffer.
That is not the operation's total memory: source buffers, PNG validation inflate,
decoder/encoder buffers, and staged output also consume memory. Raising the global
image cap alone would not provide a safe merge implementation.

Use an explicit, bounded tall-tileset budget scoped to compatible operations,
requiring width 256, height divisible by 32, and valid signed IDs. Keep general
image/preview defaults unchanged. Account for aggregate working memory and decode
sources sequentially; reject estimates above a fixed operation ceiling before
allocation. Preserve the 64 MiB encoded-file, 128 MiB staged-write/recovery, and
32 MiB Table limits. Preflight geometry and IDs before decoding; validate actual
compressed output and all staged data before commit. Large but poorly compressible
images can still be rejected even when geometry fits.

Tall input support must cover the shared PNG reader, applicable map previews and
paginated catalogs, and tileset cloning as well as merging; accepting a write that
all existing readers reject is incomplete. Full-atlas previews may need pagination
even when the source is accepted. Test both the tall path and unchanged default
rejections, including malformed PNGs and rollback, on synthetic fixtures.

For concatenation, preserve the chosen base prefix and map each appended bank's
regular IDs by its row offset. Only skip a repeated prefix after proving pixels,
properties, and autotile metadata compatible. Reconcile or reject differing
panorama/fog/battleback settings too: these affect maps sharing the merged record.
The opt-in profile does not add a merge tool or remove the default image limits.
