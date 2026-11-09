import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { quoteShell } from "../commands-agent-support.js";
import { OPENCODE2_SERVER_PORT } from "../constants.js";
import { buildOpenCode2ContainerUserConfigScript } from "./user-config.js";
import { CONTAINER_GITHUB_CREDENTIAL_FILE } from "../agent-credential-files.js";
import { OPENCODE2_DB_PATH, OPENCODE_DB_PATH } from "../container-state-layout.js";
import {
  OPENCODE2_CONTAINER_CLI_PATH,
  OPENCODE2_CONTAINER_CONFIG_DIR,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT,
  OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE,
  OPENCODE2_CONTAINER_PROCESS_PATTERN,
  OPENCODE2_GITHUB_ENV_PLUGIN_ID,
  OPENCODE_CONTAINER_USER_CONFIG_DIR,
  STOP_OPENCODE2_CONTAINER_SERVER_SCRIPT,
  buildOpenCode2ContainerStartScript,
  buildOpenCode2GitHubEnvironmentPluginSource,
  manifestRunsOpenCode2,
  openCode2ContainerPluginPath,
  openCode2ContainerPlugins,
  publishesOpenCode2Port,
} from "./container-server.js";
import {
  OPENCODE2_CREDENTIAL_PLUGIN_ID,
  OPENCODE2_FLAGS,
  buildOpenCode2CredentialPluginSource,
} from "./server.js";

describe("buildOpenCode2ContainerStartScript", () => {
  const script = buildOpenCode2ContainerStartScript();

  test("hands the password to the server alone, never inline", () => {
    expect(script).toContain("export -n OPENCODE_PASSWORD");
    expect(script).toContain(
      `OPENCODE_PASSWORD="$OPENCODE_PASSWORD" setsid ${OPENCODE2_CONTAINER_CLI_PATH} serve --port ${OPENCODE2_SERVER_PORT} --hostname 0.0.0.0`,
    );
    // The log writer is started first, without the variable.
    expect(script.indexOf("exec 3>")).toBeLessThan(script.indexOf('OPENCODE_PASSWORD="'));
    expect(script).not.toContain("setsid sh -c");
    // Nothing that could carry 1.x's password or a GitHub token reaches 2.x.
    expect(script).toContain(
      "unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN OPENCODE_SERVER_PASSWORD OPENCODE_SERVER_USERNAME",
    );
  });

  test("gives 2.x its own database, config directory, pinned flags and no autoupdate", () => {
    expect(script).toContain(`export OPENCODE_DB=${OPENCODE2_DB_PATH}`);
    expect(script).not.toContain(OPENCODE_DB_PATH);
    expect(script).toContain(`export OPENCODE_CONFIG_DIR=${OPENCODE2_CONTAINER_CONFIG_DIR}`);
    expect(script).toContain("export OPENCODE_DISABLE_AUTOUPDATE=1");
    expect(script).toContain(`export OPENCODE_FLAGS='${OPENCODE2_FLAGS}'`);
    // The exports follow the runtime-env snapshot, which must not override them.
    expect(script.indexOf("orkestrator_source_runtime_env")).toBeLessThan(
      script.indexOf("export OPENCODE_DB="),
    );
    expect(script).toContain("cd /workspace");
  });

  test("writes both plugins and the fingerprint the reuse check reads", () => {
    for (const { id } of openCode2ContainerPlugins()) {
      expect(script).toContain(`> ${openCode2ContainerPluginPath(id)}`);
    }
    expect(script).toContain(`rm -rf ${OPENCODE2_CONTAINER_CONFIG_DIR}/plugins`);
    expect(script).toContain(
      `printf '%s' '${OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT}' > ${OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT_FILE}`,
    );
    expect(script).toContain("umask 077");
  });

  test("mirrors the container's user configuration after its plugins, and fingerprints it", () => {
    const mirror = buildOpenCode2ContainerUserConfigScript(
      OPENCODE_CONTAINER_USER_CONFIG_DIR,
      OPENCODE2_CONTAINER_CONFIG_DIR,
      quoteShell,
    );
    expect(script).toContain(mirror);
    expect(script.indexOf(mirror)).toBeGreaterThan(
      script.indexOf(openCode2ContainerPluginPath(OPENCODE2_CREDENTIAL_PLUGIN_ID)),
    );
    expect(script.indexOf(mirror)).toBeLessThan(script.indexOf("export OPENCODE_CONFIG_DIR="));
    // A server started before the mirror existed is replaced, not reused.
    const pluginsOnly = createHash("sha256")
      .update(JSON.stringify(openCode2ContainerPlugins()))
      .digest("hex");
    expect(OPENCODE2_CONTAINER_PLUGINS_FINGERPRINT).not.toBe(pluginsOnly);
  });
});

describe("container plugins", () => {
  test("the credential plugin is the hardened form, the GitHub plugin reads the managed file", () => {
    const plugins = openCode2ContainerPlugins();
    expect(plugins.map(({ id }) => id)).toEqual([
      OPENCODE2_CREDENTIAL_PLUGIN_ID,
      OPENCODE2_GITHUB_ENV_PLUGIN_ID,
    ]);
    expect(plugins[0]!.source).toBe(
      buildOpenCode2CredentialPluginSource({ hardened: "refuse-tools" }),
    );
    expect(plugins[1]!.source).toContain(JSON.stringify(CONTAINER_GITHUB_CREDENTIAL_FILE));
  });

  test("the GitHub plugin is a 2.x shell hook exporting both names", () => {
    const source = buildOpenCode2GitHubEnvironmentPluginSource("/x/token");
    expect(source).toContain("export default {");
    expect(source).toContain(`id: "${OPENCODE2_GITHUB_ENV_PLUGIN_ID}"`);
    expect(source).toContain('ctx.shell.hook("create.before"');
    expect(source).toContain("event.env.GITHUB_TOKEN = token;");
    expect(source).toContain("event.env.GH_TOKEN = token;");
    expect(source).not.toContain("shell.env");
  });

  test("the stop script matches only the 2.x server", () => {
    expect(STOP_OPENCODE2_CONTAINER_SERVER_SCRIPT).toContain(
      `pkill -f '${OPENCODE2_CONTAINER_PROCESS_PATTERN}'`,
    );
    const pattern = new RegExp(OPENCODE2_CONTAINER_PROCESS_PATTERN);
    expect(pattern.test(`${OPENCODE2_CONTAINER_CLI_PATH} serve --port 4102`)).toBe(true);
    expect(pattern.test("opencode serve --port 4096 --hostname 0.0.0.0")).toBe(false);
  });
});

describe("which containers run 2.x", () => {
  test("only a manifest listing a 2.x opencode2", () => {
    expect(manifestRunsOpenCode2({ opencode2: "2.2.6", opencode: "1.19.5" })).toBe(true);
    expect(manifestRunsOpenCode2({ opencode: "1.19.5" })).toBe(false);
    expect(manifestRunsOpenCode2({ opencode2: "unknown" })).toBe(false);
    expect(manifestRunsOpenCode2({ opencode2: "1.19.5" })).toBe(false);
    expect(manifestRunsOpenCode2(undefined)).toBe(false);
  });

  test("only a container that publishes the 2.x port", () => {
    expect(
      publishesOpenCode2Port(
        JSON.stringify({
          "4096/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }],
          [`${OPENCODE2_SERVER_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: "" }],
        }),
      ),
    ).toBe(true);
    expect(publishesOpenCode2Port(JSON.stringify({ "4096/tcp": [{ HostPort: "" }] }))).toBe(false);
    expect(publishesOpenCode2Port("null")).toBe(false);
    expect(publishesOpenCode2Port("")).toBe(false);
    expect(publishesOpenCode2Port("not json")).toBe(false);
  });
});
