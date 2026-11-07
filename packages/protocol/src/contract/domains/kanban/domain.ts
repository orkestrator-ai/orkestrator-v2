/**
 * The `kanban` contract domain (docs/reports/unified-federation.md §11.2):
 * Kanban tickets, their comments and images, feature plans and planning,
 * project notes, and the Linear connection. Version 1 until a change an
 * older peer cannot handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const kanbanDomain = defineDomain({ name: "kanban", version: 1 });
