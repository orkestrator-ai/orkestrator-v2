import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { copyProjectSeedFilesIntoContainer } from "../src/core/container-project-seed-files";
import { runCommand } from "../src/core/shell";

// Opt-in: uses only a disposable container, no mounts, credentials or network.
// Bypassing the entrypoint deliberately proves delivery needs no modern relay.
const image = process.env.ORKESTRATOR_SEED_TEST_IMAGE;
test.skipIf(!image)(
  "Docker preserves private node ownership without an entrypoint relay",
  async () => {
    const setup = await readFile(
      new URL("../../../docker/workspace-setup.sh", import.meta.url),
      "utf8",
    );
    const copyPhase = setup.slice(
      setup.indexOf("project_input() {"),
      setup.indexOf("# Run orkestrator-ai.json setup script"),
    );
    expect(copyPhase).toContain('cp "$OPENCODE_PROJECT_JSON_INPUT" /workspace/opencode.json');
    const { stdout } = await runCommand("docker", [
      "create",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      image!,
      "-c",
      "sleep 120",
    ]);
    const id = stdout.trim();
    try {
      await copyProjectSeedFilesIntoContainer(id, [
        { name: ".env", target: "project-env/.env", contents: Buffer.from("A=1\n") },
        { name: ".env.local", target: "project-env/.env.local", contents: Buffer.from("B=2\n") },
        {
          name: "opencode.json",
          target: "opencode-project-json",
          contents: Buffer.from('{"model":"test"}'),
        },
      ]);
      await runCommand("docker", ["start", id]);
      // Execute the same read/copy operations as workspace setup, as node. The
      // mode assertions also detect accidental widening to other container users.
      const result = await runCommand("docker", [
        "exec",
        "--user",
        "node",
        id,
        "bash",
        "-ec",
        `
      test "$(stat -c '%u:%g:%a' /project-env)" = 1000:1000:700
      for file in /project-env/.env /project-env/.env.local /opencode-project-json; do
        test "$(stat -c '%u:%g:%a' "$file")" = 1000:1000:600
      done
      mkdir /tmp/seed-workspace
      ${copyPhase.replaceAll("/workspace", "/tmp/seed-workspace")}
      test "$(cat /tmp/seed-workspace/.env)" = A=1
      test "$(cat /tmp/seed-workspace/.env.local)" = B=2
      test "$(cat /tmp/seed-workspace/opencode.json)" = '{"model":"test"}'
    `,
      ]);
      expect(result.stderr).toBe("");
    } finally {
      await runCommand("docker", ["rm", "-f", id]);
    }
  },
  30_000,
);
