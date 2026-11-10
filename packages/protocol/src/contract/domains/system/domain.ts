/**
 * The `system` contract domain (docs/reports/unified-federation.md §11.2).
 * Version 2 since `get_resource_revision_manifest` was removed on 2026-11-10
 * (docs/architecture/version-compatibility.md, Retired); version 1 peers are
 * still accepted (`min: 1`). The next change an older peer cannot handle
 * silently bumps it again. Its commands (Phase 7) and events (`./events.ts`)
 * share it.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const systemDomain = defineDomain({ name: "system", version: 2, min: 1 });
