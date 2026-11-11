import { expect, test } from "bun:test";
import { startOpenCode2WithLauncher } from "../src/core/opencode2-container-launch";
import { createCommandFixtures } from "./command-fixtures";

const { fs, withFakeDocker } = await createCommandFixtures();

test("prepares the root cache and filtered project config before invoking the launcher", async () => {
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
      const password = await startOpenCode2WithLauncher("fixture-container");
      expect(password).toMatch(/^okb_/);
      const calls = await fs.readFile(logs.exec, "utf8");
      const config = calls.indexOf("next=$(mktemp");
      const cache = calls.indexOf("cache=/run/orkestrator-opencode2/cache");
      const project = calls.indexOf("/run/orkestrator-opencode2/project/opencode.json");
      const launch = calls.lastIndexOf("orkestrator-bridge-launch opencode2");
      expect(config).toBeGreaterThanOrEqual(0);
      expect(cache).toBeGreaterThan(config);
      expect(project).toBeGreaterThan(cache);
      expect(launch).toBeGreaterThan(project);
      const staged = calls.slice(project, launch);
      expect(staged).toContain('"model": "fixture/model"');
      expect(staged).not.toContain("untrusted-plugin");
      // OpenCode 1.x's launch root is never touched.
      expect(calls).not.toContain("/run/orkestrator-opencode/");
    },
  );
});
