# Generated Codex app-server protocol

**Do not edit by hand.** Everything here is produced by
`bun scripts/generate-codex-app-server-protocol.ts` from the Codex binary
pinned in `config/codex-version.json` (currently 0.153.3).

These bindings are only valid for the version that generated them, so they
are treated as a lockfile. The full test pipeline runs the generator with
`--check`: it always verifies the committed TypeScript digest, file count
and method surface, and regenerates from the pinned binary when available.

That fallback proves only *internal* consistency — the manifest is recomputed
from the same committed files, so bindings edited together with their manifest
would still pass. `bun run verify:codex:protocol` refuses the fallback and
requires the pinned binary; run it on a machine with the Codex toolchain
before releasing, and after any change under this directory.

`protocol-manifest.json` additionally records a digest of the JSON Schema
bundle. The schema is not committed (nothing reads it at runtime) but the
digest still fails the check if any schema shape moves.

Relative import specifiers are rewritten to explicit `.js` during
generation so the tree resolves under the bridge's NodeNext config.
