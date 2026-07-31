import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function checkIgnored(path: string): {
  exitCode: number;
  ignored: boolean;
  output: string;
} {
  const result = Bun.spawnSync([
    "git",
    "check-ignore",
    "--no-index",
    "--verbose",
    path,
  ], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    ignored: result.exitCode === 0,
    output: result.stdout.toString(),
  };
}

describe("repository ignore contract", () => {
  test("ignores root build artifacts without hiding nested source directories", () => {
    const rootArtifact = checkIgnored("build/release/app.js");
    const nestedSource = checkIgnored(
      "apps/web/src/components/build/FutureBuildComponent.tsx",
    );

    expect(rootArtifact.ignored).toBe(true);
    expect(rootArtifact.output).toContain("/build/");
    expect(nestedSource.exitCode).toBe(1);
    expect(nestedSource.ignored).toBe(false);
  });
});
