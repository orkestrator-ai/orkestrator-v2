/**
 * An administrator-managed Codex host (8085 (retired)): reading
 * `configRequirements/read`, narrowing a sandbox the administrator forbids,
 * and the policy a session then reports. The runtime path through the
 * scripted app-server is `app-server-runtime-managed-requirements.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import { AppServerRpcError, JSON_RPC_METHOD_NOT_FOUND } from "./app-server/errors.js";
import {
  CODEX_MANAGED_NETWORK_PROXY_NOTE,
  CODEX_MANAGED_READ_ONLY_SANDBOX_NOTE,
  CODEX_MANAGED_WORKSPACE_SANDBOX_NOTE,
  CodexManagedRequirementsReader,
  codexManagedReportedPolicy,
  codexManagedSandbox,
  codexManagedTurnConfig,
  codexNeedsManagedRequirements,
  parseCodexManagedRequirements,
  type CodexManagedRequirements,
} from "./codex-managed-requirements.js";
import type { EngineTurnConfig } from "./engine/types.js";

const hostPolicy: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};

const hostDefault: EngineTurnConfig = {
  mode: "build",
  sandbox: "danger-full-access",
  policy: hostPolicy,
};

const noFullAccess: CodexManagedRequirements = {
  allowedSandboxModes: ["workspace-write", "read-only"],
  networkProxy: false,
};

/** The answer Codex 0.167.0 gave in a disposable container for such a file. */
function requirementsResponse(requirements: Record<string, unknown> | null) {
  return { supportsIndependentSpeedModes: true, requirements };
}

describe("parseCodexManagedRequirements", () => {
  test("a host with no requirements is null", () => {
    expect(parseCodexManagedRequirements(requirementsResponse(null))).toBeNull();
  });

  test("reads the allowed sandbox modes and the network proxy", () => {
    expect(
      parseCodexManagedRequirements(
        requirementsResponse({
          allowedSandboxModes: ["read-only", "workspace-write"],
          network: { enabled: true, httpPort: null },
        }),
      ),
    ).toEqual({ allowedSandboxModes: ["workspace-write", "read-only"], networkProxy: true });
  });

  test("unrestricted modes and no proxy", () => {
    expect(
      parseCodexManagedRequirements(
        requirementsResponse({ allowedSandboxModes: null, network: null }),
      ),
    ).toEqual({ networkProxy: false });
    expect(
      parseCodexManagedRequirements(requirementsResponse({ network: { enabled: false } })),
    ).toEqual({ networkProxy: false });
  });

  test("drops modes this bridge does not know", () => {
    expect(
      parseCodexManagedRequirements(
        requirementsResponse({ allowedSandboxModes: ["read-only", "external-sandbox"] }),
      ),
    ).toEqual({ allowedSandboxModes: ["read-only"], networkProxy: false });
  });

  test("an unreadable answer is undefined", () => {
    expect(parseCodexManagedRequirements(undefined)).toBeUndefined();
    expect(parseCodexManagedRequirements({})).toBeUndefined();
    expect(parseCodexManagedRequirements({ requirements: "x" })).toBeUndefined();
  });
});

describe("codexManagedSandbox", () => {
  test("the host default runs in the workspace-write sandbox where full access is forbidden", () => {
    expect(codexManagedSandbox(hostDefault, noFullAccess)).toBe("workspace-write");
    expect(codexManagedTurnConfig(hostDefault, noFullAccess)).toEqual({
      ...hostDefault,
      sandbox: "workspace-write",
    });
  });

  test("a config with no sandbox named is treated as full access in build mode", () => {
    expect(codexManagedSandbox({ mode: "build" }, noFullAccess)).toBe("workspace-write");
    expect(codexManagedSandbox({ mode: "plan" }, noFullAccess)).toBeUndefined();
  });

  test("narrows to read-only when that is all the administrator allows", () => {
    const readOnlyOnly = { allowedSandboxModes: ["read-only"] as const, networkProxy: false };
    expect(codexManagedSandbox(hostDefault, readOnlyOnly)).toBe("read-only");
    expect(
      codexManagedSandbox(
        {
          ...hostDefault,
          sandbox: "workspace-write",
          policy: { ...hostPolicy, sandbox: "provider" },
        },
        readOnlyOnly,
      ),
    ).toBe("read-only");
  });

  test("never widens, and leaves an allowed or unsatisfiable request alone", () => {
    const fullOnly = { allowedSandboxModes: ["danger-full-access"] as const, networkProxy: false };
    expect(codexManagedSandbox({ ...hostDefault, sandbox: "read-only" }, fullOnly)).toBe(
      "read-only",
    );
    expect(codexManagedSandbox({ ...hostDefault, sandbox: "workspace-write" }, fullOnly)).toBe(
      "workspace-write",
    );
    expect(codexManagedSandbox(hostDefault, fullOnly)).toBe("danger-full-access");
    expect(codexManagedSandbox(hostDefault, { allowedSandboxModes: [], networkProxy: false })).toBe(
      "danger-full-access",
    );
  });

  test("no requirements, unreadable ones or an unrestricted list change nothing", () => {
    expect(codexManagedSandbox(hostDefault, null)).toBe("danger-full-access");
    expect(codexManagedSandbox(hostDefault, undefined)).toBe("danger-full-access");
    expect(codexManagedSandbox(hostDefault, { networkProxy: true })).toBe("danger-full-access");
    expect(codexManagedTurnConfig(hostDefault, null)).toBe(hostDefault);
  });

  test("leaves sessions whose sandbox was decided for another reason to Codex", () => {
    const container: EngineTurnConfig = {
      ...hostDefault,
      policy: { ...hostPolicy, id: "interactive-container", sandbox: "container" },
    };
    expect(codexManagedSandbox(container, noFullAccess)).toBe("danger-full-access");
    expect(
      codexManagedSandbox(
        { ...hostDefault, readOnlyCommandSandboxOff: "no user namespaces" },
        noFullAccess,
      ),
    ).toBe("danger-full-access");
    expect(
      codexManagedSandbox({ ...hostDefault, permissionProfile: "orkestrator" }, noFullAccess),
    ).toBe("danger-full-access");
  });
});

describe("codexNeedsManagedRequirements", () => {
  test("asks only for a request an administrator could refuse", () => {
    expect(codexNeedsManagedRequirements(hostDefault)).toBe(true);
    expect(codexNeedsManagedRequirements({ ...hostDefault, sandbox: "workspace-write" })).toBe(
      true,
    );
    expect(codexNeedsManagedRequirements({ ...hostDefault, sandbox: "read-only" })).toBe(false);
    expect(codexNeedsManagedRequirements({ mode: "plan" })).toBe(false);
    expect(codexNeedsManagedRequirements({ ...hostDefault, permissionProfile: "p" })).toBe(false);
    expect(
      codexNeedsManagedRequirements({
        ...hostDefault,
        policy: { ...hostPolicy, sandbox: "container" },
      }),
    ).toBe(false);
  });
});

describe("codexManagedReportedPolicy", () => {
  test("a narrowed host default reports the provider sandbox and says why", () => {
    expect(codexManagedReportedPolicy(hostDefault, noFullAccess)).toEqual({
      ...hostPolicy,
      sandbox: "provider",
      note: CODEX_MANAGED_WORKSPACE_SANDBOX_NOTE,
    });
    expect(
      codexManagedReportedPolicy(hostDefault, {
        allowedSandboxModes: ["read-only"],
        networkProxy: false,
      }),
    ).toEqual({ ...hostPolicy, sandbox: "provider", note: CODEX_MANAGED_READ_ONLY_SANDBOX_NOTE });
  });

  test("keeps a note the policy already carries", () => {
    const noted = { ...hostDefault, policy: { ...hostPolicy, note: "Earlier." } };
    expect(codexManagedReportedPolicy(noted, noFullAccess)?.note).toBe(
      `Earlier. ${CODEX_MANAGED_WORKSPACE_SANDBOX_NOTE}`,
    );
  });

  test("an unsandboxed host session says the administrator's proxy does not apply", () => {
    expect(codexManagedReportedPolicy(hostDefault, { networkProxy: true })).toEqual({
      ...hostPolicy,
      note: CODEX_MANAGED_NETWORK_PROXY_NOTE,
    });
  });

  test("no proxy note where Codex's sandbox runs, or where the proxy is off", () => {
    const provider: EngineTurnConfig = {
      ...hostDefault,
      sandbox: "workspace-write",
      policy: { ...hostPolicy, sandbox: "provider" },
    };
    expect(codexManagedReportedPolicy(provider, { networkProxy: true })).toBe(provider.policy);
    expect(
      codexManagedReportedPolicy({ ...hostDefault, sandbox: "read-only" }, { networkProxy: true }),
    ).toBe(hostPolicy);
    expect(
      codexManagedReportedPolicy(
        { ...hostDefault, policy: { ...hostPolicy, sandbox: "container" } },
        { networkProxy: true },
      )?.note,
    ).toBeUndefined();
    expect(codexManagedReportedPolicy(hostDefault, { networkProxy: false })).toBe(hostPolicy);
  });

  test("a narrowed session with the proxy on reports only the narrowing", () => {
    expect(
      codexManagedReportedPolicy(hostDefault, { ...noFullAccess, networkProxy: true })?.note,
    ).toBe(CODEX_MANAGED_WORKSPACE_SANDBOX_NOTE);
  });

  test("unknown requirements, or no policy, report what the session holds", () => {
    expect(codexManagedReportedPolicy(hostDefault, undefined)).toBe(hostPolicy);
    expect(codexManagedReportedPolicy(hostDefault, null)).toBe(hostPolicy);
    expect(
      codexManagedReportedPolicy({ mode: "build", sandbox: "danger-full-access" }, noFullAccess),
    ).toBeUndefined();
  });
});

describe("CodexManagedRequirementsReader", () => {
  test("asks once per generation and reports the settled answer", async () => {
    let calls = 0;
    const reader = new CodexManagedRequirementsReader(async () => {
      calls += 1;
      return requirementsResponse({ allowedSandboxModes: ["workspace-write"] });
    });
    expect(reader.known(1)).toBeUndefined();
    const first = reader.read(1);
    expect(reader.read(1)).toBe(first);
    expect(await first).toEqual({ allowedSandboxModes: ["workspace-write"], networkProxy: false });
    expect(reader.known(1)).toEqual({
      allowedSandboxModes: ["workspace-write"],
      networkProxy: false,
    });
    expect(reader.known(2)).toBeUndefined();
    await reader.read(2);
    expect(calls).toBe(2);
  });

  test("keeps an error app-server answered, and asks again after a lost transport", async () => {
    const outputs: LogOutput[] = [];
    configureLogger({ sink: (output) => void outputs.push(output) });
    try {
      let calls = 0;
      const answered = new CodexManagedRequirementsReader(async () => {
        calls += 1;
        throw new AppServerRpcError("configRequirements/read", {
          code: JSON_RPC_METHOD_NOT_FOUND,
          message: "unknown",
        });
      });
      expect(await answered.read(1)).toBeUndefined();
      expect(await answered.read(1)).toBeUndefined();
      expect(calls).toBe(1);

      let lost = 0;
      const transport = new CodexManagedRequirementsReader(async () => {
        lost += 1;
        throw new Error("Verified generation is no longer ready");
      });
      expect(await transport.read(1)).toBeUndefined();
      expect(await transport.read(1)).toBeUndefined();
      expect(lost).toBe(2);
      // Method-not-found from an older Codex is expected and stays quiet.
      expect(outputs.map((output) => output.record?.event)).toEqual([
        "managed-requirements.unreadable",
        "managed-requirements.unreadable",
      ]);
    } finally {
      resetLogger();
    }
  });

  test("forget drops the answer of an exited generation", async () => {
    const reader = new CodexManagedRequirementsReader(async () => requirementsResponse(null));
    await reader.read(1);
    expect(reader.known(1)).toBeNull();
    reader.forget();
    expect(reader.known(1)).toBeUndefined();
  });
});
