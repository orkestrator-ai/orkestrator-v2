/**
 * The `pipelines` contract domain (docs/reports/unified-federation.md §11.2,
 * plan item 7007): build pipelines, feature builds and the workflow result
 * transport's operational commands. Version 2 since
 * `import_legacy_build_pipelines` (only e2e seeding called it) and
 * `set_workflow_result_tools_rollout` (no caller) were removed on 2026-11-15
 * (docs/architecture/version-compatibility.md, Retired); version 1 peers are
 * still accepted (`min: 1`). The next change an older peer cannot handle
 * silently bumps it again.
 *
 * Browser-safe.
 */
import { defineDomain } from "../../domain.js";

export const pipelinesDomain = defineDomain({ name: "pipelines", version: 2, min: 1 });
