/**
 * The `pull-requests` contract domain (docs/reports/unified-federation.md
 * §11.2). Version 2 since commands nothing called were removed on 2026-11-10,
 * version 3 since `merge_pr_local`, which only tests called, was removed on
 * 2026-11-13 (docs/architecture/version-compatibility.md, Retired); version 1
 * and 2 peers are still accepted (`min: 1`). Version 4 adds must-understand
 * destination guards to merge and auto-merge.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const pullRequestsDomain = defineDomain({ name: "pull-requests", version: 4, min: 1 });
