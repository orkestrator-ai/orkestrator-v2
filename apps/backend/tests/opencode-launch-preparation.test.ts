import { expect, test } from "bun:test";
import { startOpenCodeWithLauncher } from "../src/core/opencode-container-launch";
import { createCommandFixtures } from "./command-fixtures";

const { fs, withFakeDocker } = await createCommandFixtures();

test("1.x prepares the root cache and filtered project config before invoking the launcher", async () => {
  await withFakeDocker(
    `#!/bin/sh
printf 'ARGV:%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
case " $* " in
  *" -i "*) cat >> "$FAKE_DOCKER_EXEC_LOG" ;;
esac
case "$*" in
  *"head -c"*"/workspace/opencode.json'"*) printf 'F{"model":"fixture/model","plugin":["untrusted-plugin"]}' ;;
esac
exit 0
`,
    async (logs) => {
      const password = await startOpenCodeWithLauncher("fixture-container");
      expect(password).toMatch(/^okb_/);
      const calls = await fs.readFile(logs.exec, "utf8");
      const config = calls.indexOf("next=$(mktemp");
      const cache = calls.indexOf("cache=/run/orkestrator-opencode/cache");
      const project = calls.indexOf("/project/opencode.json");
      const launch = calls.lastIndexOf("orkestrator-bridge-launch opencode");
      expect(config).toBeGreaterThanOrEqual(0);
      expect(cache).toBeGreaterThan(config);
      expect(project).toBeGreaterThan(cache);
      expect(launch).toBeGreaterThan(project);
      const staged = calls.slice(project, launch);
      expect(staged).toContain('"model": "fixture/model"');
      expect(staged).not.toContain("untrusted-plugin");
    },
  );
});
