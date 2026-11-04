# Clear the remaining dependency advisories

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Clear `undici` and `postcss-selector-parser`**: both versions the report named are still locked. Status: open.
2. **Check for a later Electron 45.x**: the report's other item. Status: open.

### 1. Clear `undici` and `postcss-selector-parser`

**Problem.** `undici` 8.10.2 (one high, two moderate) reaches the Pi bridge, and `postcss-selector-parser` 6.0.10 (moderate, dev only) comes through `@tailwindcss/typography`.

**Context.** Tracked as [todo 0032](../../todo/cross-cutting/0032-dependency-upgrades.md) task 6. It records these as accepted until upstream moves, so `bun audit fix` is not the fix the report assumed: these are exact upstream pins.

**Investigation.** `bun.lock:2389` still has `undici@8.10.2`, through `@earendil-works/pi-coding-agent@1.4.0` (`bun.lock:441`), and `bun.lock:2117` still has `postcss-selector-parser@6.0.10`, through `@tailwindcss/typography@0.5.20` (`bun.lock:1015`).

**Decisions.** None here: todo 0032 task 6 holds the `overrides` option and its recommendation.

### 2. Check for a later Electron 45.x

**Problem.** The report asks whether a later 45.x security release exists.

**Context.** Todo 0032 task 1 tracks Electron and recorded 45.0.0 as `latest` when it was last checked.

**Investigation.** `bun.lock:1583` is still `electron@45.0.0`, with `^45.0.0` in `package.json:28` and `apps/desktop/package.json:32`.

**Decisions.** None: take any later 45.x, since the range already admits it.

## Needs verification

Nothing was run for this file; these need the registry.

- Current `bun audit` output.
- Whether Pi or `@tailwindcss/typography` has moved, and whether an Electron 45.x has been published since todo 0032's check.

## Related

- [Security report, §5 Low severity](../2-26-10-27-security.md#5-low-severity) (L18)
- [Todo 0032](../../todo/cross-cutting/0032-dependency-upgrades.md), tasks 1 and 6
