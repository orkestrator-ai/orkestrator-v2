# Toolchain periodic full check can see an unchanged stamp

- **ID:** 4042
- **Status:** open
- **Date observed:** 2026-11-04
- **Test:** `verified stamps across launches > a periodic full check hashes every file even when stamps match` (`packages/toolchain/src/manager-stamps.test.ts:232`)
- **Original command:** `mise run test`, the workspace group, on branch `build-delete-file-5d96944a6cd8-r1` based on `4e3caa079` (Linux, btrfs). The toolchain package ran 126 tests: 123 pass, 2 skip, 1 fail.
- **Failure:** `expect(after.files[executablePath]!.stampedAtNs).not.toBe(before...)` at line 242, with `Expected: not "1793753800409000000"`, after 2.15 ms.
- **Isolated rerun:** `mise run test:logged -- --name toolchain-stamps -- bun test --cwd packages/toolchain --preload ../../tests/setup-node.ts ./src/manager-stamps.test.ts --parallel=1 --only-failures` passed. Five more direct runs of the file alone gave 10 pass four times and 9 pass, 1 fail once, so it also fails alone, intermittently.
- **Relation to the change under test:** that branch does not touch `packages/toolchain`.
- **Seen again:** 2026-11-05, `mise run test`, workspace group, on a branch that does not touch `packages/toolchain`. Same assertion, with `Expected: not "1793871440468000000"`, after 2.12 ms; the package ran 123 pass, 1 fail. Three runs of the file alone all passed.

## Hypothesis

The stamp in the failure message ends in six zeros, so it appears to have
millisecond resolution, and the test took about 2 ms. Two launches inside one
millisecond would then record the same stamp, which is what the assertion
refuses. This fits the evidence but has not been proved; the code writing the
stamp was not examined.

## Next step

Confirm the stamp's resolution. If that is the cause, have the test wait past a
stamp tick or set the earlier stamp back, as the same file does at line 129,
rather than loosening the assertion.
