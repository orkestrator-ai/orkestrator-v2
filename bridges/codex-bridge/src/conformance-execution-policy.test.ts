/**
 * The shared execution-policy conformance suite (`tests/conformance/execution-policy`)
 * over the Codex bridge.
 *
 * A real runtime against a scripted app-server child: the session is created
 * and prompted with the controls the backend sends, and the observation is
 * read from the `thread/start` and `turn/start` requests the child received
 * plus the `-c` overrides the app-server process is launched with
 * (`codexAppServerConfigOverrides`). The reported policy is `getStatus`'s,
 * which the progressive backend projects into Agent Info; config must agree.
 */
import { expect } from "bun:test";
import {
  conformancePromptControls,
  runExecutionPolicyConformance,
  type AdapterEffects,
} from "../../../tests/conformance/execution-policy/suite.js";
import { codexAppServerConfigOverrides } from "./codex-config.js";
import { harness, threadPayload } from "./app-server-runtime-test-harness.js";

const COORDINATOR_ENV = {
  ORKESTRATOR_BRIDGE_EXECUTION_POLICY: "coordinator-read-only",
  CODEX_BRIDGE_PERMISSION_PROFILE: "coordinator-conformance",
  CODEX_BRIDGE_READABLE_RUNTIME_ROOT: "/opt/codex-runtime",
} as const;

async function withEnvironment<T>(
  values: Partial<Record<keyof typeof COORDINATOR_ENV, string>>,
  run: () => Promise<T>,
): Promise<T> {
  const keys = Object.keys(COORDINATOR_ENV) as (keyof typeof COORDINATOR_ENV)[];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type SandboxPolicy = { type: string; networkAccess?: boolean };

function observeCodex(
  thread: Record<string, unknown>,
  turn: Record<string, unknown>,
  overrides: Record<string, string>,
): AdapterEffects {
  const profile = overrides.default_permissions
    ? (JSON.parse(overrides.default_permissions) as string)
    : undefined;
  const sandboxPolicy = turn.sandboxPolicy as SandboxPolicy | undefined;
  // A permission profile replaces the sandbox override; the coordinator's
  // reads the workspace only and turns the network off.
  const sandbox = sandboxPolicy?.type ?? (profile ? "readOnly" : "dangerFullAccess");
  const providerSandbox = sandbox !== "dangerFullAccess";
  const restrictsNetwork = sandboxPolicy
    ? providerSandbox && sandboxPolicy.networkAccess === false
    : overrides[`permissions.${profile}.network.enabled`] === "false";
  const approvalPolicy = turn.approvalPolicy as string;
  const approvals: AdapterEffects["approvals"] =
    turn.approvalsReviewer === "auto_review"
      ? "auto-approve"
      : approvalPolicy === "untrusted"
        ? "ask"
        : approvalPolicy === "on-request"
          ? // Codex asks only at the edge of its sandbox; without one it never does.
            providerSandbox
            ? "ask"
            : "auto-approve"
          : sandbox === "readOnly"
            ? "deny"
            : "auto-approve";
  const cwd = thread.cwd as string;
  // A process `-c` override pins with a dotted key. Thread config pins only
  // as a nested table: Codex ignores a dotted `projects."<path>"` key there.
  const processPin = Object.entries(overrides).some(
    ([key, value]) =>
      key === `projects.${JSON.stringify(cwd)}.trust_level` && value === '"untrusted"',
  );
  const threadProjects = ((thread.config ?? {}) as { projects?: Record<string, unknown> }).projects;
  const threadPin =
    (threadProjects?.[cwd] as { trust_level?: unknown } | undefined)?.trust_level === "untrusted";
  return {
    providerSandbox,
    approvals,
    // Without a pin, Codex loads the configuration of a project it trusts.
    projectResources: !processPin && !threadPin,
    restrictsNetwork,
  };
}

runExecutionPolicyConformance({
  platform: "codex",
  async apply(shape) {
    const coordinator = shape.policy.id === "coordinator-read-only";
    return withEnvironment(coordinator ? COORDINATOR_ENV : {}, async () => {
      const h = await harness({
        // Coordinators must read back the hosted-network lock before dispatch.
        "config/read": () => ({
          config: { web_search: "disabled", features: { standalone_web_search: false } },
          origins: {},
          layers: null,
        }),
        "thread/start": () => ({
          thread: threadPayload("thread-1"),
          ...(coordinator
            ? { activePermissionProfile: { id: COORDINATOR_ENV.CODEX_BRIDGE_PERMISSION_PROFILE } }
            : {}),
        }),
      });
      const { sessionId } = h.runtime.createSession({ mode: "build", policy: shape.policy });
      const controls = conformancePromptControls("codex", shape.policy);
      expect(
        await h.runtime.prompt(sessionId, {
          prompt: "Check the policy",
          requestId: `conformance-${shape.id}`,
          attachments: [],
          ...(controls.approvalMode
            ? { approvalMode: controls.approvalMode as "never" | "untrusted" | "on-request" }
            : {}),
        }),
      ).toMatchObject({ ok: true });
      const requests = h.child().requests;
      const thread = requests.find((request) => request.method === "thread/start")!.params;
      const turn = requests.find((request) => request.method === "turn/start")!.params;
      const overrides = codexAppServerConfigOverrides({ ...process.env, CWD: "/tmp/ws" });
      const reported = h.runtime.getStatus(sessionId)!.policy!;
      expect(reported).toEqual((await h.runtime.getConfig(sessionId))!.policy!);
      h.child().notify("turn/completed", {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      });
      await h.drain();
      return { reported, observed: observeCodex(thread, turn, overrides) };
    });
  },
});
