# Explicit asset review and character sheets

These tools export general review artifacts. They never modify the tileset
database, collision flags, maps, events, Essentials PBS, or player metadata.
All file paths are relative to the configured project (or an authorized read
root). Run exported library functions inside `runProjectOperation`.

## Reviewed tileset import

Call `review_tileset_import({specPath:"Data/import-review.json"})`. It is
read-only by default and returns the expected `reviewBinding` for every region.
A binding is **not approval**: inspect the source, confirm the scale, bounds,
component membership and class, then record your evidence and the returned binding.
Source reports include exact RGBA replication factors 2/3/4 as a hint only.
Uniform art can satisfy several factors: this never assigns grid, scale, identity
or approval. Comparison work is bounded by three passes over the source budget.
Changing source bytes, crop, masks, scale, padding, classification, labels,
group, duplicate target, exclusion reason or modular-split decision invalidates it.

Example specification:

```json
{
  "inventoryDirectory": "Graphics/ImportSources",
  "sources": [{"id":"furniture", "path":"Graphics/ImportSources/furniture.png"}],
  "regions": [{
    "id":"desk", "sourceId":"furniture", "label":"Writing desk",
    "rect":{"x":0,"y":0,"width":32,"height":16},
    "mask":[{"x":0,"y":0,"width":32,"height":16}],
    "sourceGrid":16, "scale":2, "padding":0,
    "kind":"object", "status":"included", "group":"desk",
    "review":{
      "binding":"COPY_BINDING_FROM_DRY_RUN_AFTER_REVIEW",
      "boundsConfirmed":true,
      "evidence":"Reviewed 16px source grid; full desk crop, no adjacent objects."
    }
  }]
}
```

`sourceGrid` may be `null` for unknown sources, but included art requires
`sourceGrid * scale = 32`. Scale is an integer from 1 through 8 and uses exact
nearest-neighbor replication. No geometry or filename heuristic approves art.
Regions have `kind` object, modular, example_scene, credits, or unreviewed;
`status` is included, duplicate, excluded, or pending. Excluded regions retain
their reason; exclusions other than scenes/credits require a reason. Duplicates
must directly name an included `duplicateOf`, with identical normalized pixels
and masks. Cycles, missing targets and unequal pixels are rejected.

Masks are non-overlapping rectangles **local to the source crop**. Omit the
mask to select the entire crop. Different regions may have overlapping bounding
boxes, but selected source pixels may not overlap. Mask holes exclude neighbors;
destination padding is separate and is never interpreted as source ownership.
All source pixels, including transparent background, must be accounted for before
declared coverage is complete. Use pending or explicitly reasoned excluded regions
for background and unreviewed areas; do not quietly omit material.

An optional `inventoryDirectory` recursively inventories PNG files (depth 8,
4,096 entries, 1,024 PNGs maximum). Files absent from `sources` appear in
`pendingSources`. `coverageComplete` is true only for that directory, when all
its files are represented and all pixels have reviewed dispositions. Without a
directory, coverage scope is `declared_inventory_only` and complete collection
coverage is never claimed. `declaredCoverageComplete` is a separate measure.
An incomplete collection may still export a clearly labeled curated selection.

Objects wider than 256 output pixels, including padding, are rejected instead
of sliced. Explicit modular pieces require `modularSplitReviewed:true`; each
band can have its own rectangle and mask. Related pieces use the same `group`
and must be adjacent in the manifest. Packing reserves consecutive full-width
rows for each region, so related pieces remain together and no other region
interleaves their destination selection. This favors clear selection over density.
Opaque crop edges produce a suspected-cut warning, never an automatic judgment.

The report's `appearancePolicy` is `preserve-source-rgba`: selected pixels retain
their source color and alpha. A painted gray shadow at alpha 255 remains opaque;
it is not automatically treated as background. Painted checker patterns are not
proof of transparency either. Component masks select pixels, not alpha values.
For an intentional shadow adaptation, keep the original and create a separately
reviewed source. Record the original/adapted hashes, exact affected mask, old/new
RGBA and rationale in review evidence, then review the resulting composition.
The importer does not perform that recoloring or verify a free-text transformation
history. Successful pixel-identity checks alone do not prove visual integration.

After review, call:

```json
{"specPath":"Data/import-review.json","dryRun":false,"outputName":"reviewed-furniture"}
```

Exports under `Data/.mcp-preview/reviewed-furniture/`:

- `atlas.png`: 256px atlas; regular IDs start at 384. No flags are inferred.
- `contact.png`: original crops, proposed art, 32px grid and neutral 32x48
  human reference. The grid is an overlay; inspect raw atlas/reconstructions too.
- `reconstruction-N.png`: selected pixels in original source coordinates;
  excluded neighbors and mask holes remain transparent.
- `index.json`: hashes, evidence, source rectangles, masks, padding, groups,
  duplicate links, coverage, destination rows and tile ID ranges.
- `index.html`: escaped, script-free source/region index linking review artifacts.

Use the exports for visual review before registering or assigning graphics.
Fresh output names are required; source images and existing exports are not
replaced. Input hashes and source inventory are rechecked before commit. The
transaction layer stages files and rolls back failed writes.

Review limits: 32 decoded sources/8 megapixels aggregate, 512 regions, 1,024
rectangles per mask, 16 megapixels aggregate crop-mask allocations, 32 megapixels
normalized duplicate-comparison work, 8 megapixels each atlas/contact image,
signed tile IDs through 32767, existing file/transaction caps. Split larger
collections into reviewed batches. These bound operation workloads, not exact
Node process RSS. No game runtime compatibility is certified by export success.

## Character inspection and conversion

Call `inspect_character_sheet({specPath:"Data/character-review.json"})` with:

```json
{
  "sourcePath":"Graphics/Characters/example.png",
  "layout":{"engine":"xp","columns":4,"rows":4},
  "directions":["down","left","right","up"],
  "role":"walking",
  "anchors":[{"x":16,"y":48}],
  "conversion":{
    "engine":"xp","columns":4,"rows":4,
    "frameWidth":32,"frameHeight":48,"scale":1,
    "frames":[{"sourceFrame":0,"anchor":{"x":16,"y":48}}]
  }
}
```

The abbreviated arrays above must contain **one entry per frame** (16 entries
for a 4x4 sheet). Frame indices are row-major and zero-based. Every source frame
has an explicit local anchor; bottom-center commonly equals half frame width
and full frame height. Each output entry selects a source index and a target
anchor, allowing frame reordering, repeated frames and explicit extraction.
Use `engine:"explicit"` for other declared grids; XP requires 4x4. MV/MZ layout
is never guessed. Rows require unique explicit direction labels.

Results contain per-frame nontransparent bounds, transparency counts,
bottom-center offsets from the supplied anchors, alignment offsets by direction,
and opaque-background/empty-frame warnings. These are observations, not automatic
animation approval. Full source frame rectangles must fit after alignment and
integer scaling; clipping is rejected, including transparent source pixels.

Optional conversion is previewed in the dry-run report. To export, set
`review:{"binding":"RETURNED_REVIEW_BINDING","evidence":"Your inspection"}`
in the specification. Binding covers source bytes, layout, directions, anchors,
role and conversion. Then pass `dryRun:false,outputName:"character-reviewed"`.
The tool exports `character.png`, `before-after.png`, and `frames.json` into a
fresh preview directory. Review these before assigning the character graphic.
Source files are not overwritten. Source/target/preview work uses bounded image
budgets; individual frame dimensions are at most 1024 and grids at most 32x32.

`validate_character_set({specPaths:["Data/walk.json","Data/run.json"]})`
compares up to 16 explicitly labeled sheets. Walking, running, cycling,
surfing and fishing are ordinary caller role labels. It reports full per-sheet
frames and geometry agreement; it does not invent a standard XP role mapping,
change Essentials metadata, or prove role transitions in a specific runtime.
Test animation timing, page selection, direction and role changes in the target
game separately.

Synthetic regression commands:

```sh
npm run build
node test/reviewed-import.mjs
node test/character-sheets.mjs
```
