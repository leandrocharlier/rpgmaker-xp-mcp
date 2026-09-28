# Security review of the local fork

## Scope and conclusion

Reviewed the server dispatcher and stdio transport, all tool families, file and
transaction helpers, the vendored Marshal reader/writer, PNG decoding and HTML
generation, dependency audit results, and installation configuration. The
baseline was commit `51c9ea7`; this document describes the subsequent local
patch. This is a source review with targeted exploit regressions on Windows,
not an independent certification, exhaustive fuzzing campaign, or OS sandbox.

No direct remote-code-execution path was identified in the server source.
It starts a stdio transport, not a network listener. Its project tools do not
spawn subprocesses, evaluate JavaScript, invoke Ruby, or make HTTP requests.
Marshal user-defined payloads are decoded as data, not Ruby `_load` execution.
This conclusion does not cover the MCP client, a network bridge, game runtime,
or compromised dependencies and installation scripts.

## Findings and corrections

| Finding | Preconditions and impact | Correction |
| --- | --- | --- |
| INI injection through lossy encoding | A tool caller supplies Unicode such as U+010A. Node's Latin-1 encoding truncates it to LF, bypassing the original newline check and allowing extra INI keys. This is an integrity issue with potential execution implications when the game later loads configuration; no DLL was loaded during testing. | Require titles to round-trip through Latin-1 before staging any write. |
| Non-terminating path generation | A caller supplies endpoints such as `[0,0]` and `[0.5,0]`. Unit increments never reach the target; the synchronous loop blocks the server. | Validate integer coordinate pairs before iteration. |
| Excessive geometry work | Large radii or many long, wide segments pass individual number bounds but multiply into excessive iteration/allocation. | Bound total candidate work before entering generators. |
| PNG size-check bypass | The decoder accepted a second IHDR although only the first dimensions were checked. The interlaced pngjs branch also inflated without an output cap. | Validate chunk structure and a single first IHDR; preflight inflation against exact scanline size, including Adam7 passes. |
| Directory boundary bypass | Asset validation followed a project directory junction and used external filenames as an existence oracle. It did not disclose external file contents in the reproduced case. | Apply the same authorized-root/link checks before directory enumeration, including the library listing helper. |
| Expanded data amplification | Repeated Marshal string or Table references can expand into very large JSON despite a small source file and a node-count limit that did not count decoded Table cells. | Count expanded Table cells and aggregate decoded strings and keys, and validate tool results before serialization/commit. |
| Unbounded transport buffering | A connected local client can send an oversized or unterminated line before tool validation runs. This is a local-client availability risk, not an Internet endpoint. | Cap line bytes before SDK parsing, close an oversized stream, and limit pending tool calls. |
| Installation ambiguity | Inherited npm/npx instructions and registry metadata refer to upstream, which does not acquire local fork fixes. | Prominent fork notices and direct-checkout instructions. No upstream release is claimed. |

The title injection, fractional loop, duplicate header acceptance, and junction
lookup were reproduced on the baseline using harmless synthetic fixtures.
Interlaced overflow was tested with a small compressed fixture and confirmed to
reach downstream decoding after unrestricted inflation; no large memory bomb
was run. The geometry and transport amplification risks were also inspected in
source; tests exercise the new rejection boundaries without exhausting the host.

## Verification

- `npm audit --json`: zero reported advisories in the resolved dependency tree
  at review time. This is not proof that dependencies contain no vulnerabilities.
- `npm run build`: TypeScript compilation.
- `node test/security-review.mjs`: eight regression groups covering encoding,
  geometry, PNG structure/inflation, junctions, expanded text, and framed input.
- Existing `security-audit.mjs` and `security-files.mjs`: traversal, exports,
  backup failures, concurrent edits, HTML escaping, literal searches, staging,
  rollback, hardlinks, file/decompression limits, and lock handling.
- `node test/tools.mjs`: 30 ordinary tool checks on a scratch project.
- `node test/essentials-strings.mjs`: encoded strings and object references.
- `node test/authoring.mjs`: geometry, map authoring, and render compatibility.
  Its old preview destination was updated to the existing authorized directory.
- Essentials integration: 69 maps round-tripped in memory and MCP reads passed.
  No project content was added to this fork or used as published fixtures.

All security mutation tests use disposable generated projects. Existing engine
template-based tests use their own local scratch directories. The game project
was read only. The compiled files must be loaded by restarting the MCP process.

## Remaining boundaries

An authorized client can deliberately edit scripts and script-bearing events.
Running that game can execute arbitrary Ruby with the user's permissions; this
server is an editor, not a game-code sandbox. Prompt injection in project text
must also be handled by the AI client. Review untrusted projects and generated
code before running them.

Filesystem checks do not stop a hostile local process racing path changes.
Backups cannot make a multi-file update atomic across sudden process or power
loss. Limits reduce denial-of-service risks but do not provide a global CPU,
memory, disk, or request-rate quota. Backups accumulate. Transport bytes and
pending calls are bounded, but a repeatedly abusive authorized client can still
consume resources. Standalone library consumers must establish the documented
project operation context themselves.

The reviewed changes are local until committed and published. Users must verify
which checkout or installed package their client actually launches; rebuilding
this checkout does not patch a separate npm installation or an already running
server process.
