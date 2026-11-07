# Signed update manifests for the Linux AppImage

Carried from security report batch S5, part `0140` task 1 (finding L6).

## Task analysis

Analysed 2026-11-04 against `main` at `e198fd4a7`.

### Tasks

1. **Signed update manifests for the Linux AppImage**: it trusts the release's SHA-512 alone. Status: open (blocked on electron-builder 27 stable; the work is tracked in [0032](0032-dependency-upgrades.md) task 2).

### 1. Signed update manifests for the Linux AppImage

**Problem.** A compromised GitHub release could push code to Linux users, because AppImage updates are trusted on the feed's SHA-512 alone.

**Context.** The migration itself is [0032](0032-dependency-upgrades.md) task 2, blocked on electron-builder 27 stable. This file keeps the security finding visible until that task lands. The key decision is already made there: Ed25519, current and next key, release machines hold the current key. A signed release is a one-way door. `scripts/mac-update-feed.ts` edits the macOS feed after it is written, which would invalidate a signature.

**Investigation.** `electron-builder.release.linux.config.ts:11-16` still says Linux releases are unsigned. The pins are `electron-builder ^26.18.0` (`package.json`) and `electron-updater 6.8.11` (`apps/desktop/package.json`), and `scripts/mac-update-feed.ts` still writes `minimumSystemVersion` after the build. The report held no options of its own and pointed at 0032 task 2; the one below is copied from there.

**Decisions.**

- **How to make the macOS feed's `minimumSystemVersion` survive signing?**
  - **Set it through electron-builder config before signing, if 27 stable exposes it; otherwise re-sign with `createUpdateManifestSignatures` (recommended).**
    - Pros: one signature, produced by the tool that publishes; no second signing step to keep in step.
    - Cons: depends on what 27 stable exposes, which alpha.12 did not.
  - **Always re-sign the edited feed in `scripts/mac-update-feed.ts`.**
    - Pros: works today with alpha behaviour.
    - Cons: a second place that needs the private key; `release:publish` must verify both.

## Constraints and rationale

Do the work once, under 0032 task 2, and mark this file finished when it lands. Rated Low because the remaining work is blocked upstream; re-rate it when electron-builder 27 is stable.

## Related

- [0032](0032-dependency-upgrades.md) task 2
- [Releasing the desktop app](../../development/releasing.md)
- Security report, §5 Low severity (`git show 413bd6219:docs/reports/2-26-10-27-security.md`) (L6)
