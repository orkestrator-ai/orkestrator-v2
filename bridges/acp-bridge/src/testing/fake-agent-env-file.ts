/**
 * Per-test fake-agent switches for a bridge that several tests share
 * (`sharedBridge` in `acp-test-harness.ts`).
 *
 * The bridge hands its own environment to every agent it starts, so a
 * `FAKE_ACP_*` switch normally costs a bridge process per combination.
 * `FAKE_ACP_ENV_FILE` names a JSON object of further variables that this agent
 * applies when it starts. A test writes the file before creating its session,
 * and every agent that session starts (a respawn, a fork's `session/load`)
 * reads the same values.
 *
 * `fake-agent.ts` imports this module first, so it runs before any other fake
 * module reads the environment at load time.
 */
import { readFileSync } from "node:fs";

const file = process.env.FAKE_ACP_ENV_FILE;
if (file) {
  let text: string | undefined;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // No file: this test asked for no switches.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    for (const [key, value] of Object.entries(JSON.parse(text) as Record<string, string>)) {
      process.env[key] = value;
    }
  }
}
