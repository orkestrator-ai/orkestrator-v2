/**
 * The `pull-requests` contract domain (docs/reports/unified-federation.md
 * §11.2). Version 2 since commands nothing called were removed on 2026-11-10,
 * version 3 since `merge_pr_local`, which only tests called, was removed on
 * 2026-11-13 (docs/architecture/version-compatibility.md, Retired); version 1
 * and 2 peers are still accepted (`min: 1`). The next change an older peer
 * cannot handle silently bumps it again; its commands (Phase 7) and events
 * (`./events.ts`) share it.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const pullRequestsDomain = defineDomain({ name: "pull-requests", version: 3, min: 1 });
