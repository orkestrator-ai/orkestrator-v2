/**
 * The `config` contract domain (docs/reports/unified-federation.md §11.2): the
 * machine's settings (global and per repository), its credentials, the desktop
 * connection catalogue, the shared client state (coordinator pane layouts,
 * upstream merge checks, notice dismissals) and Orkestrator's own permission
 * rules (plan item 7005). Version 2 since commands nothing called were removed
 * on 2026-11-10 (docs/architecture/version-compatibility.md, Retired); version
 * 1 peers are still accepted (`min: 1`). The next change an older peer cannot
 * handle silently bumps it again.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const configDomain = defineDomain({ name: "config", version: 2, min: 1 });
