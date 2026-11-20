import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import path from "node:path";

const PROVIDER_SOURCE_FILES = [
  "agent-provider-contract.ts",
  "agent-provider-runtime.ts",
  "http-bridge/interactions.ts",
  "http-bridge/provider.ts",
  "http-bridge/runtime-health.ts",
  "http-bridge/transport.ts",
  "native-agent/provider.ts",
] as const;

/** The neutral modules above plus every OpenCode 2.x provider module. */
async function providerSourceFiles(): Promise<string[]> {
  const openCode2 = (await readdir(path.join(import.meta.dir, "opencode2")))
    .filter((file) => file.endsWith(".ts") && !/\.test(-support)?\.ts$/.test(file))
    .map((file) => `opencode2/${file}`);
  expect(openCode2.length).toBeGreaterThan(0);
  return [...PROVIDER_SOURCE_FILES, ...openCode2];
}

async function source(filename: string): Promise<string> {
  return Bun.file(path.join(import.meta.dir, filename)).text();
}

describe("agent provider module boundaries", () => {
  test("keeps every provider implementation module within 1,500 lines", async () => {
    for (const filename of await providerSourceFiles()) {
      const contents = await source(filename);
      expect(
        contents.split("\n").length - 1,
        `${filename} exceeds the provider module line limit`,
      ).toBeLessThanOrEqual(1_500);
    }
  });

  test("keeps OpenCode implementation details out of the pipeline adapter", async () => {
    const pipelineAdapter = await source("build-pipeline/provider.ts");

    expect(pipelineAdapter).not.toMatch(/@opencode-ai|\.\.\/opencode(?:-|2\/)|OpenCodeProvider/);
    expect(pipelineAdapter).not.toContain("interactiveSnapshot");
    expect(pipelineAdapter).not.toContain("modelCatalog");
  });

  test("keeps OpenCode wiring and policy out of the shared native-agent service", async () => {
    // OpenCode-specific construction lives behind `createNativeAgentProvider`
    // and its policy behind `native-agent/platform-policy.ts`; the shared
    // service only imports the connection type, never OpenCode runtime modules,
    // and does not branch on the platform.
    const files = (await readdir(path.join(import.meta.dir, "native-agent")))
      .filter((file) => /^service-.*\.ts$/.test(file) && !file.endsWith(".test.ts"))
      .map((file) => `native-agent/${file}`);
    expect(files.length).toBeGreaterThan(0);
    for (const filename of files) {
      const contents = await source(filename);
      const runtimeContents =
        filename === "native-agent/service-shared.ts"
          ? contents.replace(
              'import type { OpenCode2ServerConnection } from "../opencode2/index.js";',
              "",
            )
          : contents;
      expect(runtimeContents, filename).not.toMatch(/from ["']\.\.\/opencode(?:-|2\/)/);
      expect(contents, filename).not.toMatch(/[!=]==\s*"opencode"/);
    }
  });

  test("keeps neutral and provider modules independent of pipeline contracts", async () => {
    for (const filename of await providerSourceFiles()) {
      expect(await source(filename), filename).not.toContain(
        "@orkestrator/protocol/build-pipeline",
      );
    }
  });
});
