# Movement and semantic placement

All tools here are read-only. They use project-scoped reads and do not execute
Ruby, move events, replace artwork, change flags, or certify target-runtime behavior.

## `audit_movement`

Supply `mapId`, `start:{x,y}`, and explicit `runtimeProfile` (`xp-standard` or
`unknown`, including modified Essentials runtimes). Optional `allowed` and
`forbidden` rectangles use tile coordinates and `width,height`; `goals` are cells.
The audit applies stock XP tile-stack priorities and directional passage bits
at both ends of each cardinal step. Empty tile 0 is processed using its flags,
so an open room surrounded by empty cells can pass a goal while failing containment.
The result gives reachable count, goals, and a witness for the first escape.
Witnesses have explicit length/truncation metadata and a bounded destination-end
segment. Without zones, `containmentChecked` is false.

`approaches:[{eventId,cell,direction,footprint?}]` distinguishes reachable approach,
facing the event, stepping onto it, and event membership in a stair footprint.
Each page reports hypothetical cardinal move-route geometry and footprint/bounds
violations. Random, relative, diagonal, jump and script movement remains unknown.
Route geometry does not claim that a route executes, and event pages are not selected.

This is a tile-model diagnostic. Event tile/character collision, page conditions,
forced routes, script rules, looping maps, and Essentials adapters are not simulated.
An impassable lateral stair can have a valid reachable approach; this tool neither
rejects nor certifies its activation. In the target runtime separately test travel
both ways, event completion, player visibility, and released movement/direction locks.
Initialize/update the real scene before initiating an event in a runtime harness.

## Catalog and placement

`inspect_building_catalog({objects})` validates an explicit in-memory catalog:
each object has `id,width,height,anchors`; each anchor has `name,kind,x,y` and
optional cardinal `direction`. Kinds are `door`, `approach`, `shadow`, `padding`.
Coordinates are tile offsets; approach/shadow/padding may extend beyond image
bounds. Names and object IDs must be unique. This does not infer object identity.

`plan_building_placement({mapId,eventId,object,doorAnchor,replaceableCells?})`
aligns a named door to the existing event coordinate. Replacing a 5x5 building
with a 7x7 building therefore uses the new door offset rather than an old bounding
box. Reports world anchors, current directional tile collision, other events,
occupied tiles and bounds conflicts. Explicitly reviewed `replaceableCells`
suppresses occupied-tile warnings only; it never suppresses other-event conflicts.
The plan returns the original event unchanged. Optional
`proposedTiles:{layer,tileIds}` supplies one row-major grid matching the object
footprint, using the current map tileset; null means untouched. It reports proposed
anchor collisions separately from current collisions without changing the map.
It cannot predict collision of unsupplied replacement graphics or flags and
explicitly reports that uncertainty.

## Incoming transfer relocation

`plan_transfer_relocation({oldDestination,newDestination,oldApproach?,selected?})`
scans all on-disk Map*.rxdata files, including maps absent from MapInfos. Missing
indexed maps and duplicate numeric map IDs fail closed. Destinations
have `mapId,x,y`. `selected` entries identify `mapId,eventId,pageIndex,commandIndex`
(zero-based page/command indices). Direct Transfer Player command 201 references
are listed individually with old and proposed parameter arrays. Only explicit
selections change the preview; direction/fade and unselected links remain intact.
Approach links retain their offset from the doorway. Multiple matching references
are marked ambiguous. Missing selections or out-of-bounds proposed cells fail.
Variable transfers and event scripts are unresolved. The preview does not scan
game scripts or establish a complete dynamic transfer graph.

No relocation is applied automatically. Review the proposed parameters and use
the existing event-page editing tool while preserving all other page properties.
This intentional separation prevents ambiguous matching coordinates from moving
unrelated links. Verify approach, activation, arrival and return independently.

Synthetic checks: `node test/movement-audit.mjs` and
`node test/building-anchors.mjs`. They cover positive-goal/negative-containment,
blocked stair approach, walkable door anchors, differing building footprint,
three interiors with ambiguous references, selection, and unchanged source files.
