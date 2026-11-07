/**
 * The `ticket-sync` contract domain (docs/reports/unified-federation.md §11.2).
 * Version 1 until a change an older peer cannot handle silently; its
 * commands (Phase 7) and events (`./events.ts`) share it.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const ticketSyncDomain = defineDomain({ name: "ticket-sync", version: 1 });
