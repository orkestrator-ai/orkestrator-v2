import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temp() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "release-workflow-"));
  directories.push(directory);
  return directory;
}
function stepScript(file: string, name: string) {
  const text = readFileSync(file, "utf8");
  const step = text.split(`      - name: ${name}\n`)[1]!.split(/\n      - name:|\n  [a-z]/)[0]!;
  return step
    .split("        run: |\n")[1]!
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
}

test.each([
  ["push", "", "2.21.0", ["latest", "stable", "2.21", "2"]],
  ["push", "", "2.22.0-beta.1", ["beta"]],
  ["push", "false", "2.21.0", []],
  ["workflow_dispatch", "true", "2.21.0", ["latest", "stable"]],
  ["workflow_dispatch", "false", "2.21.0", []],
  ["schedule", "false", "2.22.0-unstable.20261015.1.gaaaaaaa", []],
])("container tags for %s input %s version %s", async (event, moving, version, expected) => {
  const output = path.join(temp(), "output");
  // Execute the actual step with its event/input environment. Reusable workflows
  // retain the caller's event name, so exercise dispatch/schedule as well as push.
  const script = stepScript(
    ".github/workflows/publish-container.yml",
    "Compute channel tags",
  ).replace("mise exec -- bun", JSON.stringify(process.execPath));
  const child = Bun.spawn(["bash", "-c", script], {
    env: {
      ...process.env,
      RELEASE_EVENT: event,
      MOVING_TAGS: moving,
      RELEASE_VERSION: version,
      RELEASE_COMMIT: "a".repeat(40),
      REGISTRY: "ghcr.io",
      IMAGE_NAME: "o/r",
      GITHUB_OUTPUT: output,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(0);
  const tags = readFileSync(output, "utf8").split("\n");
  expect(tags).toContain(`ghcr.io/o/r:${version}`);
  for (const tag of expected) expect(tags).toContain(`ghcr.io/o/r:${tag}`);
  if (moving === "false")
    for (const tag of ["latest", "stable", "beta", "unstable", "2", "2.21"])
      expect(tags).not.toContain(`ghcr.io/o/r:${tag}`);
});

test("moving-tag calculation failure fails the unstable publishing step", async () => {
  const directory = temp();
  writeFileSync(path.join(directory, "bun"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
  writeFileSync(path.join(directory, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const script = stepScript(".github/workflows/release-unstable.yml", "Move the GHCR unstable tag");
  const child = Bun.spawn(["bash", "-c", script], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      VERSION: "2.22.0-unstable.20261015.1.gaaaaaaa",
      GITHUB_REPOSITORY: "o/r",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await child.exited).toBe(42);
});

test.each(["true", "missing", "false"])(
  "skip requires a published release: draft=%s",
  async (draft) => {
    const directory = temp();
    const output = path.join(directory, "output");
    writeFileSync(
      path.join(directory, "git"),
      '#!/bin/sh\nif [ "$1" = "rev-parse" ]; then echo aaaaaaa123; else echo v2.22.0-unstable.20261015.1.gaaaaaaa; fi\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(directory, "gh"), `#!/bin/sh\necho ${draft}\n`, { mode: 0o755 });
    const script = stepScript(
      ".github/workflows/release-unstable.yml",
      "Skip a commit that already has an unstable release",
    );
    const child = Bun.spawn(["bash", "-c", script], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FORCE: "false",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_OUTPUT: output,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`skip=${draft === "false"}\n`);
  },
);

test("only the macOS signing job receives the key and cancellation invokes cleanup", () => {
  const workflow = readFileSync(".github/workflows/release-unstable.yml", "utf8");
  expect(workflow.split("  build-linux:")[1]!.split("  publish-npm:")[0]).not.toContain(
    "secrets.ORKESTRATOR_RELEASE_SIGNING_KEY",
  );
  expect(workflow).toContain("gem install --no-document fpm --version 1.17.0");
  expect(workflow).toContain("if: (failure() || cancelled()) && needs.prepare.outputs.tag != ''");
});
