/**
 * The `native-sessions` contract domain (docs/reports/unified-federation.md
 * §11.2). Version 2 since commands nothing called were removed on 2026-11-10
 * (docs/architecture/version-compatibility.md, Retired); version 1 peers are
 * still accepted (`min: 1`). The next change an older peer cannot handle
 * silently bumps it again; its commands (Phase 7) and events (`./events.ts`)
 * share it.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const nativeSessionsDomain = defineDomain({ name: "native-sessions", version: 2, min: 1 });
