// Configuration routes
import { Hono } from "hono";
import {
  getAvailableModelCatalog,
  getClaudeRuntimeVersions,
} from "../services/session-manager.js";
import type { ModelsResponse } from "../types/index.js";

const config = new Hono();

config.get("/models", async (c) => {
  const startedAt = Date.now();
  console.log("[config] /models requested");
  const [{ models, source }, versions] = await Promise.all([
    getAvailableModelCatalog(),
    getClaudeRuntimeVersions(),
  ]);
  console.log("[config] /models responded", {
    count: models.length,
    durationMs: Date.now() - startedAt,
  });
  const response: ModelsResponse = {
    models,
    source,
    fetchedAt: new Date().toISOString(),
    ...versions,
  };
  return c.json(response);
});

export default config;
