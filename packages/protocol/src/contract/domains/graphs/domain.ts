/**
 * The `graphs` contract domain (docs/reports/unified-federation.md §11.2,
 * plan item 7007): graph templates, sharing, describe jobs, launches, runs and
 * mock runs. Version 2 since `graph_capability_ceiling_set`, which no client
 * called, was removed on 2026-11-15 (docs/architecture/version-compatibility.md,
 * Retired); version 1 peers are still accepted (`min: 1`). The next change an
 * older peer cannot handle silently bumps it again.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const graphsDomain = defineDomain({ name: "graphs", version: 2, min: 1 });
