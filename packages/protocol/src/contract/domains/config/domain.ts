/**
 * The `config` contract domain (docs/reports/unified-federation.md §11.2):
 * the machine's settings (global and per repository), its credentials, the
 * desktop connection catalogue, the shared client state (coordinator pane
 * layouts, upstream merge checks, notice dismissals) and Orkestrator's own
 * permission rules (plan item 7005). Version 1 until a change an older peer
 * cannot handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const configDomain = defineDomain({ name: "config", version: 1 });
