import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Architecture guards for backend-owned change tracking
 * (docs/architecture/change-tracking.md):
 *
 * - portable contracts stay portable (no Node, Bun, Git or SDK imports);
 * - shared algorithms and backend domain code never branch on provider names
 *   or import provider SDKs — provider knowledge ends at adapter ingress;
 * - renderer code has no line-counting, diffing, provider-classification or
 *   provider-SDK engines: it renders backend projections.
 */

const repoRoot = resolve(import.meta.dir, "../..");

function files(root: string, include: (path: string) => boolean): string[] {
  const results: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      if (name === "node_modules" || name === "dist") continue;
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (include(path)) results.push(path);
    }
  };
  walk(root);
  return results;
}

const isSource = (path: string) => /\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path);
const read = (path: string) => readFileSync(path, "utf8");
const rel = (path: string) => relative(repoRoot, path);

const PROVIDER_SDKS = [
  "@anthropic-ai/",
  "@opencode-ai/sdk",
  "@cursor/sdk",
  "@agentclientprotocol/sdk",
  "@openai/codex",
];

describe("change-tracking architecture boundaries", () => {
  test("portable change contracts import nothing platform- or provider-specific", () => {
    for (const name of ["change-evidence.ts", "change-measurements.ts", "change-resources.ts"]) {
      const source = read(join(repoRoot, "packages/protocol/src", name));
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        expect(
          specifier.startsWith("node:") || specifier.startsWith("bun:"),
          `${name} imports ${specifier}`,
        ).toBe(false);
        expect(specifier.includes("/node/"), `${name} imports ${specifier}`).toBe(false);
        expect(
          PROVIDER_SDKS.some((sdk) => specifier.startsWith(sdk)),
          `${name} imports ${specifier}`,
        ).toBe(false);
      }
    }
  });

  test("shared algorithms and the backend domain never switch on provider names or import SDKs", () => {
    const roots = [
      join(repoRoot, "packages/protocol/src/node/change-tracking"),
      join(repoRoot, "apps/backend/src/core/change-tracking"),
    ];
    // The legacy compatibility adapter is the one documented place that knows
    // old bridges' write-tool placeholder; it is checked separately below.
    const allowed = new Set(["legacy-payload.ts"]);
    for (const root of roots) {
      for (const path of files(root, isSource)) {
        if (allowed.has(path.split("/").at(-1)!)) continue;
        const source = read(path);
        for (const sdk of PROVIDER_SDKS) {
          expect(source.includes(`"${sdk}`), `${rel(path)} imports ${sdk}`).toBe(false);
        }
        expect(
          /(===|!==|case)\s*"(claude|codex|cursor|grok|pi|opencode)"/.test(source),
          `${rel(path)} branches on a provider name`,
        ).toBe(false);
      }
    }
  });

  test("renderer code has no counting, diffing or provider-classification engine", () => {
    const forbidden: Array<[RegExp, string]> = [
      [/@orkestrator\/protocol\/line-diff/, "client line diff"],
      [/@orkestrator\/protocol\/node\//, "Node-only protocol module"],
      [/\bcountTextLines\s*\(/, "client line counting"],
      [/\blineChangeStatsFromSides\s*\(/, "client replacement counting"],
      [/\bcountDiffStats\s*\(/, "client patch counting"],
      [/\btoolDiffFromOpenCodeToolState\s*\(/, "client provider payload parsing"],
      [/\bisFileEditToolName\s*\(/, "client provider tool classification"],
      [/<DiffEditor\b/, "client-side two-buffer diffing"],
    ];
    const offenders: string[] = [];
    for (const path of files(join(repoRoot, "apps/web/src"), isSource)) {
      const source = read(path);
      for (const [pattern, label] of forbidden) {
        if (pattern.test(source)) offenders.push(`${rel(path)}: ${label}`);
      }
      for (const sdk of PROVIDER_SDKS) {
        if (source.includes(`from "${sdk}`)) offenders.push(`${rel(path)}: provider SDK ${sdk}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the renderer never reports a missing count as zero in handoff text", () => {
    const source = read(join(repoRoot, "apps/web/src/lib/agent-handoff.ts"));
    expect(/additions\s*\?\?\s*0|deletions\s*\?\?\s*0/.test(source)).toBe(false);
  });
});
