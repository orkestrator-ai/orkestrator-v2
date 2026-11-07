import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../..");
const storesDir = path.join(root, "apps/web/src/stores");
const agentTestingDir = path.join(root, "e2e/agent-testing");

/** Every per-node store hook (`export const useX = scopedStoreHook(def)`). */
function scopedStoreHooks(): string[] {
  const hooks: string[] = [];
  for (const file of readdirSync(storesDir)) {
    if (!/\.tsx?$/.test(file) || /\.test\.tsx?$/.test(file)) continue;
    const source = readFileSync(path.join(storesDir, file), "utf8");
    for (const match of source.matchAll(/export const (use\w+) = scopedStoreHook\(/g)) {
      hooks.push(match[1]!);
    }
  }
  return hooks;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !file.split(path.sep).includes("node_modules"))
    .map((file) => path.join(dir, file));
}

/**
 * The agent-testing specs reach the renderer's stores through dynamic imports
 * inside `page.evaluate`, which the type checker cannot see. Since 3018 a
 * per-node store's hook has no `getState`/`setState`/`subscribe` statics, so
 * such a call fails only at run time ("getState is not a function"). The
 * command scope's instance is `getWindowScope().commandScope().store(hook.def)`.
 */
describe("agent-testing specs and per-node store statics", () => {
  test("no spec calls a removed static on a per-node store hook", () => {
    const hooks = scopedStoreHooks();
    expect(hooks.length).toBeGreaterThan(30);
    const statics = new RegExp(
      `\\b(${hooks.join("|")})\\.(getState|setState|subscribe|getInitialState)\\b`,
      "g",
    );
    const findings: string[] = [];
    for (const file of sourceFiles(agentTestingDir)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        for (const match of line.matchAll(statics)) {
          findings.push(`${path.relative(root, file)}:${index + 1} ${match[0]}`);
        }
      });
    }
    expect(findings).toEqual([]);
  });
});
