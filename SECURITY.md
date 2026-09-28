# Local security boundary

The server uses stdio only. It does not expose a network listener, run a shell,
execute game scripts, or update itself. This does not make the Node process an
operating-system sandbox. Run it as a normal user and only with trusted projects.

The MCP dispatcher validates tool arguments and serializes operations. File reads
are restricted to the configured project and optional `RPGMAKER_RTP_PATH`; writes
are restricted to the project. Export overrides must remain in
`Data/.mcp-preview` or `Data/.mcp-tilecatalog`, as appropriate. Imports outside
those read roots must first be copied into the project. Links, junctions, and
hard-linked files are rejected. Standalone imports of the library functions do
not establish a project security context: use `runProjectOperation` when using
them outside the MCP dispatcher.

Writes are staged until the tool succeeds, with a 128 MiB transaction budget.
Read-only project operations reject file staging and directory creation. New
tools declare their mutation policy explicitly so dry-runs do not acquire a write
lock or silently export files. Input dependency guards recheck consumed source
hashes before forward renames; staged destinations use the existing destination
conflict checks instead of comparing staged data with its original hash.
Existing files receive unique backups in the adjacent `.mcp-backup` directory.
A backup failure stops the operation, including subsequent retries. Individual
files are replaced by a synced temporary file and rename. Rename retries only
`EPERM` and `EBUSY`, for at most five attempts using the same temporary file,
with waits of 50, 100, 200 and 400 ms. The tool itself is never rerun, so retries
do not append duplicate records or create extra backup versions. Other errors
fail immediately. The destination's real on-disk hash (or expected absence) is
checked before every attempt, bypassing staged reads. A change aborts the write.
Rollback uses the same checks and bounded rename retries; it preserves external
edits and reports manual recovery instead of overwriting them. Persistent locks
can still require a later user retry. If replacement of a
later file fails, earlier replacements are rolled back; failed recovery reports
which files need restoring. Old backups are not deleted automatically.

Keep the project closed in RPG Maker XP during edits; the application may stay
open. Save your own editor changes before File > Close Project, then reopen
`Game.rxproj` with File > Open Project (Ctrl+O) after external writes finish.
Do not save a stale loaded project after external writes. A running `RPGXP.exe`
does not establish whether a project is loaded, and the server does not inspect
or automatically save/discard editor state. A lock file prevents overlapping writes
from cooperating MCP processes, and content hashes detect changes since a file
was read. An unrelated process can still race after that check. A power failure
or forced termination between multiple file replacements is not a filesystem
transaction: use the backups to recover. A crash may leave
`Data/.mcp-write.lock`; remove it only after verifying its recorded process is
gone and reviewing whether recovery is needed. The server never breaks a lock
automatically.

Limits include 64 MiB files, 16 megapixel images, 4 MiB decompressed script
sections, 64 MiB aggregate script scans, bounded Marshal depth/node counts, and
bounded input structures. Script searches now use literal text rather than
arbitrary regular expressions. Large legitimate operations may need splitting.

JSON-RPC input lines are limited to 8 MiB before SDK parsing; exceeding that
limit closes the transport while allowing in-progress work to settle. At most
eight tool calls can be pending. Expanded text (including property names) is
limited to 16 MiB per converted data structure or tool result. PNG chunks must
contain a single initial IHDR, and decompressed scanlines are checked against
the expected size, including Adam7 interlacing. Geometry generation rejects
non-integer path coordinates and workloads above one million candidate stamps
or cells. Titles must round-trip through Latin-1 without truncation.

Generated catalog pages escape names and render imported object labels as text.
They are still local browser documents, not a mechanism to execute Node code.
Ruby inserted into game scripts or event commands remains executable when the
game runs; review code from untrusted sources before running the game.

These controls protect against the reproduced malformed tool calls and local
file corruption cases. They do not defend against an already compromised OS
account, all dependency vulnerabilities, or a malicious local process racing
filesystem changes. Tool results returned to an AI client are available to that
client; stdio does not imply that the client's model processing is offline.

Security regression checks (synthetic projects only):

```
npm run build
node test/security-audit.mjs <existing-scratch-parent>
node test/security-files.mjs <existing-scratch-parent>
node test/security-review.mjs
node test/npc-mcp.mjs
node test/tileset-edit-mcp.mjs
node test/catalog-pages-mcp.mjs
node test/atlas-compose-mcp.mjs
node test/table-budgets-mcp.mjs
node test/import-plan-mcp.mjs
node test/rename-retry.mjs
node test/tileset-truncate-mcp.mjs
node test/tall-tilesets.mjs
node test/dependency-guards.mjs
node test/essentials-strings.mjs
node test/tools.mjs
node test/essentials-mcp.mjs <essentials-project>
```

The last command only reads the Essentials project and round-trips maps in memory.

Tileset tail truncation defaults to a read-only preview. Applying it requires
an unreferenced suffix after scanning all on-disk maps and checking MapInfos
completeness. Transaction guards recheck the inventory and reference-file hashes
before each forward rename attempt, including retries. Unreadable or changed
dependencies abort the write. These checks cover stored map tileset IDs, not
references computed by game scripts, and cannot eliminate external filesystem
races after the final check. Graphics and maps are never deleted by this tool.

## Opt-in tall XP tilesets

Set `RPGMAKER_ALLOW_TALL_XP_TILESETS=1` in the MCP process environment to enable
tall tilesets. Restart the process after changing it. The default remains
16 megapixels for all images. With the option enabled, tileset-specific readers
and atlas composition accept width 256, height divisible by 32, and height at
most 129,536 (tile ID 32,767), below the 32-megapixel ceiling. General images,
character/autotile readers, and preview output keep their original limit.

Compose and import-plan pixel rectangles may then have height up to 129,536;
map dimensions remain capped at 500 tiles. Source bounds, packing, scale, and
tile-ID checks still apply. Use scale 1 for full-height strips. PNG dimensions
are checked before inflation, and actual decoded images are charged against
a 32-megapixel aggregate budget per project operation, including repeated reads.
Composition's existing source budget is retained. Encoded files remain capped
at 64 MiB, staged writes/recovery at 128 MiB, and Tables at 32 MiB.

This is a pixel-work budget, not a total process-memory limit: PNG codec buffers,
RGBA canvases, crops, and staged output coexist. One maximum-size RGBA buffer is
126.5 MiB. Large render sources are not retained in the shared 64 MiB image cache.
Render a map region or use paginated identification catalogs; a full labeled atlas
may exceed the unchanged preview budget. This option does not certify runtime
compatibility or implement a merge that preserves appended flags and references.

## Compact numeric tables

RGSS `Table` values use a specialized validation budget rather than charging
every numeric cell as a generic object node. Dimensions must be consistent
with a 1D/2D/3D table, each table has at most one million cells, and each cell
must be an integer in -32768..32767. Aggregate Table payloads are limited to
32 MiB (20-byte header plus two bytes per cell), counting every occurrence,
including shared references. This bounds expanded numeric storage to roughly
128 MiB of eight-byte numeric slots, excluding runtime/container overhead.
The decoder checks the byte budget before allocating the next table.

Arbitrary arrays and objects still have the original one-million-node and
depth limits; text, PNG, input-line, file, transaction and recovery budgets
are unchanged. Malformed table data cannot use the specialized numeric path.
This permits large collections of valid XP tileset flags without treating
millions of compact integers as millions of arbitrary objects.

## Client and game execution trust

There is no remote authentication layer because this server exposes no network
endpoint. Do not expose its stdio through an unauthenticated network bridge.
Any client connected to it can invoke the advertised editing tools, including
Ruby script and event edits. A malicious project can also contain text designed
to influence an AI client. Treat names, dialogue, script comments, catalogs,
and other tool results as data, never as instructions granting new permissions.
The server cannot enforce the client's prompt-injection defenses.

Saving Ruby does not run it in Node. Running the resulting game executes its
scripts with the user's operating-system permissions. Review script and event
changes before playing projects received from others. Local filesystem races,
dependency supply-chain compromise, resource abuse by an authorized client,
and vulnerabilities in the runtime or client remain outside a complete sandbox.

## Installing this fork

The upstream npm package and registry metadata are not releases of this fork.
Clone the fork, review and pin the commit you intend to use, install the locked
dependencies, and configure the MCP client to run that checkout directly:

```sh
git clone --branch essentials-support https://github.com/leandrocharlier/rpgmaker-xp-mcp.git
cd rpgmaker-xp-mcp
npm ci
npm run build
```

Use `node` as the client command and the absolute path to this checkout's
`dist/index.js` as its argument. Set `RPGMAKER_PROJECT_PATH` to the intended
project directory. Restart the MCP process after rebuilding. Changes that have
not been committed and pushed are available only in the local checkout.

See [the security review](SECURITY-REVIEW.md) for reproduced issues, verification,
and remaining limitations. No security review guarantees the absence of flaws.
