/**
 * The `projects` contract domain (docs/reports/unified-federation.md §11.2):
 * the project list and its sidebar arrangement, adding, creating and removing
 * projects, the host folder picker, project copies between machines and the
 * AGENTS.md section proposals (plan item 7005). Version 1 until a change an
 * older peer cannot handle silently.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const projectsDomain = defineDomain({ name: "projects", version: 1 });
