/**
 * The execution policies the conformance suite drives through every adapter.
 *
 * Each shape is the literal policy `resolveNativeAgentExecutionPolicy` returns
 * for its environment, origin and override; the backend runner
 * (`apps/backend/src/core/conformance-execution-policy.test.ts`) fails if the
 * resolver ever returns something else. Bridges cannot import the backend, so
 * they take the literal and trust that check.
 */
import type {
  NativeAgentExecutionPolicy,
  NativeAgentExecutionPolicyOverride,
} from "@orkestrator/protocol/native-agent";

export const POLICY_PLATFORMS = ["claude", "codex", "cursor", "opencode", "grok", "pi"] as const;
export type PolicyPlatform = (typeof POLICY_PLATFORMS)[number];

export interface PolicyShape {
  id: string;
  title: string;
  environment: {
    environmentType: "local" | "containerized";
    networkAccessMode: "full" | "restricted";
  };
  origin: "interactive-native" | "coordinator";
  override?: NativeAgentExecutionPolicyOverride;
  policy: NativeAgentExecutionPolicy;
}

const SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE =
  "Restricted network access is enforced by the provider sandbox, so this session runs sandboxed.";

const local = { environmentType: "local", networkAccessMode: "full" } as const;
const hostDefault: NativeAgentExecutionPolicy = {
  id: "interactive-host",
  sandbox: "none",
  approvals: "auto-approve",
  projectResources: false,
  networkAccess: "full",
};
const container = (networkAccess: "full" | "restricted"): NativeAgentExecutionPolicy => ({
  id: "interactive-container",
  sandbox: "container",
  approvals: "auto-approve",
  projectResources: true,
  networkAccess,
});

export const POLICY_SHAPES = [
  {
    id: "host-auto-approve",
    title: "host default: no sandbox, auto-approve",
    environment: local,
    origin: "interactive-native",
    policy: hostDefault,
  },
  {
    id: "host-ask",
    title: "host with approvals on request",
    environment: local,
    origin: "interactive-native",
    override: { approvals: "ask" },
    policy: { ...hostDefault, approvals: "ask" },
  },
  {
    id: "host-deny",
    title: "host with approvals denied",
    environment: local,
    origin: "interactive-native",
    override: { approvals: "deny" },
    policy: { ...hostDefault, approvals: "deny" },
  },
  {
    id: "coordinator",
    title: "read-only coordinator",
    environment: { environmentType: "local", networkAccessMode: "restricted" },
    origin: "coordinator",
    policy: {
      id: "coordinator-read-only",
      sandbox: "provider",
      approvals: "deny",
      projectResources: false,
      toolPolicy: { deny: ["write", "edit", "apply_patch", "shell"] },
      capabilityPolicy: { deny: ["file.write", "file.patch", "shell.mutate", "network"] },
      networkAccess: "restricted",
    },
  },
  {
    id: "host-network-restricted",
    title: "host with restricted network (runs sandboxed)",
    environment: local,
    origin: "interactive-native",
    override: { networkAccess: "restricted" },
    policy: {
      ...hostDefault,
      sandbox: "provider",
      networkAccess: "restricted",
      note: SANDBOXED_FOR_NETWORK_RESTRICTION_NOTE,
    },
  },
  {
    id: "host-provider-sandbox",
    title: "host with the provider sandbox and full network",
    environment: local,
    origin: "interactive-native",
    override: { sandbox: "provider" },
    policy: { ...hostDefault, sandbox: "provider" },
  },
  {
    id: "host-project-resources",
    title: "host with project resources on",
    environment: local,
    origin: "interactive-native",
    override: { projectResources: true },
    policy: { ...hostDefault, projectResources: true },
  },
  {
    id: "container-restricted",
    title: "container with restricted network",
    environment: { environmentType: "containerized", networkAccessMode: "restricted" },
    origin: "interactive-native",
    policy: container("restricted"),
  },
  {
    id: "container-full",
    title: "container with full network",
    environment: { environmentType: "containerized", networkAccessMode: "full" },
    origin: "interactive-native",
    policy: container("full"),
  },
  {
    id: "container-ask",
    title: "container with approvals on request",
    environment: { environmentType: "containerized", networkAccessMode: "restricted" },
    origin: "interactive-native",
    override: { approvals: "ask" },
    policy: { ...container("restricted"), approvals: "ask" },
  },
] as const satisfies readonly PolicyShape[];

export type PolicyShapeId = (typeof POLICY_SHAPES)[number]["id"];
