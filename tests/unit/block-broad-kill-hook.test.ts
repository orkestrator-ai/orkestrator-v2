import { describe, expect, test } from "bun:test";
import path from "node:path";
import { findBroadKill } from "../../scripts/agent-hooks/block-broad-kill";

const HOOK = path.resolve(import.meta.dir, "../../scripts/agent-hooks/block-broad-kill.ts");

describe("broad kill hook", () => {
  test.each([
    ["pkill -f resources/backend/main.js", "pkill"],
    ["killall bun", "killall"],
    ["/usr/bin/pkill -9 node", "pkill"],
    ["sudo pkill opencode", "pkill"],
    ["timeout 5 killall -q bun", "killall"],
    ["FOO=1 pkill x", "pkill"],
    ["cd /tmp && pkill -f coord-burn; echo done", "pkill"],
    ["fuser -k 34121/tcp", "fuser -k"],
    ["fuser -vk 8080/tcp", "fuser -k"],
    ["kill $(lsof -t -i:34121)", "kill"],
    ['kill -9 "$(pgrep -f bridge)"', "kill"],
    ["kill `pgrep bun`", "kill"],
    ["pgrep -f bridge | xargs kill", "kill"],
    ["pgrep -f bridge | xargs -r kill -9", "kill"],
    ["kill 0", "kill"],
    ["kill -9 -1", "kill"],
    ["kill -- -1", "kill"],
    ["kill -s KILL -1", "kill"],
    ["bash -c 'pkill -f vite'", "pkill"],
    ['sh -lc "killall node"', "killall"],
    ["eval 'pkill x'", "pkill"],
    ["echo $(pkill x)", "pkill"],
    ["(cd x && killall y)", "killall"],
  ])("refuses %s", (command, expected) => {
    expect(findBroadKill(command)).toBe(expected);
  });

  test.each([
    "kill 12345",
    "kill -9 12345",
    "kill -TERM $PID",
    'kill -- "-$PGID"',
    "kill -1 12345",
    "kill %1",
    "git commit -m 'stop using pkill and killall in tests'",
    'echo "never run pkill -f bun"',
    "grep -rn pkill docs/",
    "rg 'kill \\$\\(' scripts",
    "cat <<'EOF' > notes.md\npkill -f bun\nkillall node\nEOF",
    "git commit -F - <<EOF\nfix: a SIGTERM no longer orphans; avoid kill \\$(pgrep x)\nEOF",
    "mise run test:logged -- --name killall-docs -- bun test tests/unit/x.test.ts",
    "ls # pkill would be wrong here",
    "skill-runner --kill-after 5",
  ])("allows %s", (command) => {
    expect(findBroadKill(command)).toBe(null);
  });

  test("blocks through the hook protocol and allows malformed input", async () => {
    const run = async (stdin: string) => {
      const child = Bun.spawn([process.execPath, HOOK], {
        stdin: new TextEncoder().encode(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      return { code, stderr };
    };
    const blocked = await run(
      JSON.stringify({ tool_name: "Bash", tool_input: { command: "pkill bun" } }),
    );
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain("Production Orkestrator shares this host");
    expect((await run(JSON.stringify({ tool_input: { command: "ls" } }))).code).toBe(0);
    expect((await run("not json")).code).toBe(0);
  }, 30_000);
});
