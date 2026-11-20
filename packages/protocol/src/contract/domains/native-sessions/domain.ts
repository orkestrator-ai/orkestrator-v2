/**
 * The `native-sessions` contract domain (docs/reports/unified-federation.md
 * §11.2). Version 2 since commands nothing called were removed on 2026-11-10,
 * version 3 since the background interaction monitor's three commands, which
 * no client called, were removed on 2026-11-15, version 4 since the sync-v1
 * projection read `get_native_agent_projection_update`, which no client
 * called after joined history paging retired, was removed on 2026-11-16 and
 * the sync capabilities stopped advertising `projectionSyncVersions`
 * (docs/architecture/version-compatibility.md, Retired). Version 5 makes
 * provider failure Retry conditional on the current session and failed turn. Older
 * peers are still accepted (`min: 1`). The next change an older peer cannot handle
 * silently bumps it again; its commands (Phase 7) and events (`./events.ts`)
 * share it.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const nativeSessionsDomain = defineDomain({ name: "native-sessions", version: 6, min: 1 });
