import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildConcurrentGroups } from "../../scripts/test-all";

const root = path.resolve(import.meta.dir, "../..");
const TEST_FILE = /\.(?:test|spec)\.tsx?$/;

function repositoryTestFiles(): string[] {
  const result = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "git ls-files failed");
  return result.stdout.split("\n").filter((file) => TEST_FILE.test(file));
}

function defaultOwners(file: string): string[] {
  const owners: string[] = [];
  if (file.startsWith("tests/")) owners.push("root");
  if (
    file === "e2e/agent-testing/artifact-sanitizer.test.ts" ||
    file === "scripts/opencode-live-compatibility-probe.test.ts" ||
    file === "test-fixtures/agent-project/server.test.ts"
  )
    owners.push("root");
  if (/^apps\/(?:web|backend|web-public)\/(?:src|tests)\//.test(file)) owners.push("workspace");
  if (file.startsWith("apps/desktop/scripts/dev/")) owners.push("workspace");
  if (
    /^apps\/desktop\/electron\/(?:agent-platform-selection|application-logging|macos-permissions|runtime-profile)\.test\.ts$/.test(
      file,
    )
  )
    owners.push("workspace");
  if (file.startsWith("packages/protocol/src/") || file.startsWith("packages/cli/tests/"))
    owners.push("workspace");
  if (/^bridges\/[^/]+\/src\//.test(file)) owners.push("bridges");
  return owners;
}

function explicitOwners(file: string): string[] {
  const owners: string[] = [];
  if (/^e2e\/(?!agent-testing\/)/.test(file)) owners.push("browser");
  if (/^e2e\/agent-testing\/.*\.spec\.ts$/.test(file)) owners.push("agent-browser/electron");
  if (file.startsWith("test-fixtures/test-diagnostics/")) owners.push("diagnostic fixture");
  return owners;
}

describe("test suite ownership", () => {
  test("every repository test has exactly one default owner or an explicit opt-in owner", () => {
    const unowned: string[] = [];
    const duplicateDefaultOwners: string[] = [];

    for (const file of repositoryTestFiles()) {
      const defaults = defaultOwners(file);
      const explicit = explicitOwners(file);
      if (defaults.length === 0 && explicit.length === 0) unowned.push(file);
      if (defaults.length > 1) duplicateDefaultOwners.push(`${file}: ${defaults.join(", ")}`);
    }

    expect(unowned).toEqual([]);
    expect(duplicateDefaultOwners).toEqual([]);
  });

  test("the ownership model agrees with the aggregate and package selectors", () => {
    const groups = buildConcurrentGroups(8);
    const rootArgs = groups.find((group) => group.name === "root and agent-support tests")?.args;
    expect(rootArgs).toContain("./tests");
    expect(rootArgs).toContain("./e2e/agent-testing/artifact-sanitizer.test.ts");
    expect(rootArgs).toContain("./scripts/opencode-live-compatibility-probe.test.ts");
    expect(rootArgs).toContain("./test-fixtures/agent-project/server.test.ts");

    const desktop = JSON.parse(
      readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"),
    ) as {
      scripts: Record<string, string>;
    };
    expect(desktop.scripts["test:workspace"]).toContain(
      "./electron/agent-platform-selection.test.ts",
    );

    const mise = readFileSync(path.join(root, "mise.toml"), "utf8");
    expect(mise).toContain("bunx playwright test --config e2e/playwright.config.ts");
    expect(mise).toContain("e2e/agent-testing/playwright.browser.config.ts");
    expect(mise).toContain("e2e/agent-testing/playwright.electron.config.ts");
  });
});
