import { describe, expect, test } from "bun:test";
import path from "node:path";

const PROVIDER_SOURCE_FILES = [
  "agent-provider-contract.ts",
  "agent-provider-runtime.ts",
  "http-bridge-interactions.ts",
  "http-bridge-provider.ts",
  "http-bridge-transport.ts",
  "native-agent-provider.ts",
  "opencode-commands.ts",
  "opencode-interactions.ts",
  "opencode-messages.ts",
  "opencode-model-catalog.ts",
  "opencode-provider.ts",
  "opencode-session-lifecycle.ts",
  "opencode-snapshots.ts",
] as const;

async function source(filename: string): Promise<string> {
  return Bun.file(path.join(import.meta.dir, filename)).text();
}

describe("agent provider module boundaries", () => {
  test("keeps every provider implementation module within 1,500 lines", async () => {
    for (const filename of PROVIDER_SOURCE_FILES) {
      const contents = await source(filename);
      expect(
        contents.split("\n").length - 1,
        `${filename} exceeds the provider module line limit`,
      ).toBeLessThanOrEqual(1_500);
    }
  });

  test("keeps OpenCode implementation details out of the pipeline adapter", async () => {
    const pipelineAdapter = await source("build-pipeline-provider.ts");

    expect(pipelineAdapter).not.toMatch(/@opencode-ai|\.\/opencode-|OpenCodeProvider/);
    expect(pipelineAdapter).not.toContain("interactiveSnapshot");
    expect(pipelineAdapter).not.toContain("modelCatalog");
  });

  test("keeps neutral and provider modules independent of pipeline contracts", async () => {
    for (const filename of PROVIDER_SOURCE_FILES) {
      expect(await source(filename), filename).not.toContain(
        "@orkestrator/protocol/build-pipeline",
      );
    }
  });
});
