/**
 * The `kanban` contract domain (docs/reports/unified-federation.md §11.2):
 * Kanban tickets, their comments and images, feature plans and planning,
 * project notes, and the Linear connection. Version 2 since commands nothing
 * called were removed on 2026-11-10
 * (docs/architecture/version-compatibility.md, Retired); version 1 peers are
 * still accepted (`min: 1`). The next change an older peer cannot handle
 * silently bumps it again.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const kanbanDomain = defineDomain({ name: "kanban", version: 2, min: 1 });
