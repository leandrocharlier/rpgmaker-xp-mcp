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
Existing files receive unique backups in the adjacent `.mcp-backup` directory.
A backup failure stops the operation, including subsequent retries. Individual
files are replaced by a synced temporary file and rename. If replacement of a
later file fails, earlier replacements are rolled back; failed recovery reports
which files need restoring. Old backups are not deleted automatically.

Keep RPG Maker XP closed during edits. A lock file prevents overlapping writes
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
node test/essentials-strings.mjs
node test/tools.mjs
node test/essentials-mcp.mjs <essentials-project>
```

The last command only reads the Essentials project and round-trips maps in memory.
