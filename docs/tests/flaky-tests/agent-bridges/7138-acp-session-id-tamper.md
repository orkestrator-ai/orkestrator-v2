# ACP resumable session ID tamper assertion

- **ID:** 7138
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Test:** `ACP bridge > lists and resumes provider-owned grok sessions`
- **File:** `bridges/acp-bridge/src/acp-context.test.ts:193`
- **Original command:** `mise run test:logged -- --name fix-full-rerun -- mise run test:full` on `79dbd1ff6`; concurrent all-tier workspace, root and bridge groups, bridge group allocated two worker slots.
- **Failure:** Expected resume HTTP 404 after changing the final encoded session-ID character, received 201 (461.64 ms). ACP package: 814 pass, 17 skip, 1 fail, 832 tests across 60 files.
- **Isolated rerun:** `NODE_ENV=test mise run test:logged -- --name fix-triage-acp-context -- bun test --cwd bridges/acp-bridge ./src/acp-context.test.ts --parallel=1 --only-failures` passed in 19.0 seconds.
- **Evidence:** Aggregate bridge log `/tmp/orkestrator-test-run.c7DYyd/bridges.log` (compressed on aggregate finalization).

## Current assessment

The owning file passes alone; no ACP source or test changed in this branch.
The test changes only the last character of a signed encoded ID. One hypothesis
is that the replacement occasionally changes unused encoding bits without
changing decoded bytes; this has not been reproduced or confirmed.
Do not weaken the assertion or change session admission without a reproduction.

### Resolution — 2026-11-06

**Root cause (product).** The hypothesis above is correct. The signature is a
32-byte HMAC, so its base64url form is 43 characters and the last character
carries four data bits and two unused ones. `Buffer.from(…, "base64url")`
ignores the unused bits, so four characters (`A`–`D`, `E`–`H`, …) decode to the
same bytes. `parseExternalSessionToken` compared only the decoded bytes. The
test replaces the last character with `A` (or `B` when it is `A`), so whenever
the random per-process signing key produced a signature ending in `A`–`D`
(one run in sixteen per provider variant) the edited token still verified and
the resume answered 201. Any token therefore had four accepted spellings.

**Fix.** `bridges/acp-bridge/src/acp-context.ts`: after the constant-time
comparison, `parseExternalSessionToken` also requires the signature to be the
canonical encoding of the digest (`supplied.toString("base64url") === signature`),
matching the canonical check the encoded session id already had. New
deterministic unit test `bridges/acp-bridge/src/acp-external-session-token.test.ts`
checks a round trip and asserts all other 63 spellings of the last signature
character are refused. Main CI also observed the original failure for the
`acp-fixture` variant (run 42222311479, job 127907099873, 221.55 ms).

**Verification.**

- Reproduced before the fix: with the canonical check removed, the new unit
  test failed (`mise run test:logged -- --name br-7138-prefix -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-external-session-token.test.ts`, exit 1).
- With the fix: the same command with `--rerun-each=50` passed (exit 0).
- Owner: `mise run test:logged -- --name br-7138-context -- bun test --cwd bridges/acp-bridge --preload ../../tests/setup-node.ts ./src/acp-context.test.ts --rerun-each=3` passed (exit 0).
