/**
 * The `projects` contract domain (docs/reports/unified-federation.md §11.2):
 * the project list and its sidebar arrangement, adding, creating and removing
 * projects, the host folder picker, project copies between machines and the
 * AGENTS.md section proposals (plan item 7005). Version 2 since commands
 * nothing called were removed on 2026-11-10
 * (docs/architecture/version-compatibility.md, Retired); version 1 peers are
 * still accepted (`min: 1`). The next change an older peer cannot handle
 * silently bumps it again.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const projectsDomain = defineDomain({ name: "projects", version: 2, min: 1 });
