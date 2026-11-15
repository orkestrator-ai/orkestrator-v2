/**
 * The `pipelines` contract domain (docs/reports/unified-federation.md §11.2,
 * plan item 7007): build pipelines, feature builds and the workflow result
 * transport's operational commands. Version 2 since
 * `import_legacy_build_pipelines` (called by e2e seeding, and by renderers
 * v2.21.0 to v2.38.1-beta once at startup while the browser still holds the
 * pre-July `orkestrator-build-pipelines` localStorage key; such a renderer now
 * logs the `unknown-command` and keeps the key) and
 * `set_workflow_result_tools_rollout` (no caller) were removed on 2026-11-15
 * (docs/architecture/version-compatibility.md, Retired); version 1 peers are
 * still accepted (`min: 1`). The next change an older peer cannot handle
 * silently bumps it again.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const pipelinesDomain = defineDomain({ name: "pipelines", version: 2, min: 1 });
