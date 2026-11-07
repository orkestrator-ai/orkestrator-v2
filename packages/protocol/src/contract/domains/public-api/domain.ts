/**
 * The `public-api` contract domain (docs/reports/unified-federation.md §11.2,
 * Appendix E's "Public API (`public_action`)" group): the one registry command
 * the `orkestrator` CLI, Control MCP and scheduled jobs reach the backend
 * through. Version 1 until a change an older peer cannot handle silently.
 *
 * The public actions behind it keep their own versioning
 * (`PUBLIC_API_SCHEMA_VERSION`, each action's `actionVersion`, the
 * `capabilities` action; docs/architecture/public-cli.md): this domain
 * versions only the `public_action` wrapper.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const publicApiDomain = defineDomain({ name: "public-api", version: 1 });
