import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  startOpenCode2Fixture,
  type OpenCode2Fixture,
} from "../../../../../scripts/opencode2-steer-probe.js";
import { OpenCode2Client } from "./client.js";
import { OPENCODE2_FLAGS, writeOpenCode2HostConfig } from "./server.js";
import { mintOpenCode2InputId } from "./steer.js";

/**
 * The 2.x host server's launch environment against the real pinned binary:
 * the credential plugin keeps the server password from the agent's shell.
 * Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const liveTest = process.env.RUN_LIVE_OPENCODE2 === "1" && binary ? test : test.skip;

let fixture: OpenCode2Fixture | undefined;
let dataDir: string | undefined;
afterEach(async () => {
  await fixture?.stop();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  fixture = undefined;
  dataDir = undefined;
});

/** What the agent's shell sees, as SET/none; never the value itself. */
const PROBE = "RUN_BASH:echo PW=${OPENCODE_PASSWORD:+SET} SPW=${OPENCODE_SERVER_PASSWORD:+SET} END";

async function shellSees(f: OpenCode2Fixture): Promise<string> {
  const client = new OpenCode2Client({
    baseUrl: f.baseUrl,
    password: f.password,
    directory: f.directory,
  });
  const session = await client.createSession({ model: { providerID: "fixture", id: "fixture" } });
  await client.prompt(session.id, { id: mintOpenCode2InputId(), text: PROBE, delivery: "steer" });
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = (await client.listMessages(session.id, { limit: 20, order: "asc" }))
      .messages as Array<{ content?: Array<{ type: string; state?: { content?: unknown } }> }>;
    const tool = rows.flatMap((row) => row.content ?? []).find((part) => part.type === "tool");
    const output = JSON.stringify(tool?.state?.content ?? "");
    if (output.includes("END")) return output;
    await Bun.sleep(100);
  }
  throw new Error("the shell tool never answered");
}

liveTest(
  "the credential plugin keeps the server password from the agent's shell",
  async () => {
    // Control: without the plugin the shell inherits the password.
    fixture = await startOpenCode2Fixture(binary!);
    expect(await shellSees(fixture)).toContain("PW=SET");
    await fixture.stop();

    dataDir = await mkdtemp(path.join(tmpdir(), "ork-opencode2-data-"));
    const configDir = await writeOpenCode2HostConfig(dataDir, { HOME: dataDir });
    fixture = await startOpenCode2Fixture(binary!, {
      env: { OPENCODE_CONFIG_DIR: configDir, OPENCODE_FLAGS: OPENCODE2_FLAGS },
    });
    const seen = await shellSees(fixture);
    expect(seen).toContain("PW= SPW= END");
    // The server still authenticates: it read the password before the plugin removed it.
    const client = new OpenCode2Client({
      baseUrl: fixture.baseUrl,
      password: fixture.password,
      directory: fixture.directory,
    });
    expect((await client.info()).version.startsWith("2.")).toBe(true);
    await expect(
      new OpenCode2Client({
        baseUrl: fixture.baseUrl,
        password: "wrong",
        directory: fixture.directory,
      }).listPermissions("ses_x"),
    ).rejects.toThrow();
  },
  120_000,
);
