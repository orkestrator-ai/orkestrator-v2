// Configuration routes
import { Hono } from "hono";
import { getAvailableModelCatalog, getClaudeRuntimeVersions } from "../services/session-manager.js";
import { invalidateClaudeModelCatalog } from "../services/claude-model-catalog.js";
import type { ModelsResponse } from "../types/index.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.claude");

const config = new Hono();

config.get("/models", async (c) => {
  if (c.req.query("forceRefresh") === "true") invalidateClaudeModelCatalog();
  const startedAt = Date.now();
  log.debug("models.requested");
  const [{ models, source }, versions] = await Promise.all([
    getAvailableModelCatalog(),
    getClaudeRuntimeVersions(),
  ]);
  log.debug("models.responded", { count: models.length, durationMs: Date.now() - startedAt });
  const response: ModelsResponse = {
    models,
    source,
    fetchedAt: new Date().toISOString(),
    ...versions,
  };
  return c.json(response);
});

export default config;
