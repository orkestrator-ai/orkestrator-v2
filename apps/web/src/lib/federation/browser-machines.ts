/**
 * Other machines a hosted browser page connects to directly.
 *
 * The page's own backend is the bound machine. Each additional machine is a
 * direct, independently authenticated HTTPS session — never relayed through
 * the bound backend — and must list this page's origin in its allowed
 * origins. Non-secret metadata (origin, nickname) is kept in localStorage;
 * gateway tokens follow the existing browser policy and stay in this tab's
 * sessionStorage only. SSH routes do not exist here: a browser has no SSH
 * subprocess facility, so a machine is reachable only by HTTPS.
 */

import {
  BACKEND_HELLO_PATH,
  isClientApiCompatible,
  parseBackendHello,
  type BackendHello,
} from "@orkestrator/protocol/backend-profile";
import type {
  ConnectionList,
  ConnectionSummary,
  ConnectionTransportState,
} from "@orkestrator/protocol/connections";
import { normalizeGatewayToken } from "@orkestrator/protocol/gateway-token";
import { normalizeConnectionNickname } from "@orkestrator/protocol/connections";
import { createHttpBackendClient, type BackendClient } from "./backend-client";

const MACHINES_KEY = "orkestrator.federation.machines";
const TOKENS_KEY = "orkestrator.federation.tokens";
const CHANGED_EVENT = "orkestrator:federation-machines-changed";
export const BOUND_BROWSER_MACHINE_ID = "this-page";
const MAX_BROWSER_MACHINES = 16;
const HELLO_TIMEOUT_MS = 10_000;

type StoredMachine = { id: string; origin: string; nickname?: string; addedAt: string };

type MachineStatus = {
  transport: ConnectionTransportState;
  detail?: string;
  hello?: BackendHello;
};

const statuses = new Map<string, MachineStatus>();
let boundHello: BackendHello | null = null;
let boundHelloRequested = false;

function storage(kind: "local" | "session"): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

function readMachines(): StoredMachine[] {
  try {
    const parsed = JSON.parse(storage("local")?.getItem(MACHINES_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .flatMap((entry): StoredMachine[] => {
        if (!entry || typeof entry !== "object") return [];
        const { id, origin, nickname, addedAt } = entry as Record<string, unknown>;
        if (typeof id !== "string" || typeof origin !== "string") return [];
        try {
          return [
            {
              id,
              origin: normalizeMachineOrigin(origin),
              ...(typeof nickname === "string" && nickname ? { nickname } : {}),
              addedAt: typeof addedAt === "string" ? addedAt : "",
            },
          ];
        } catch {
          return [];
        }
      })
      .slice(0, MAX_BROWSER_MACHINES);
  } catch {
    return [];
  }
}

function readTokens(): Record<string, string> {
  try {
    const parsed = JSON.parse(storage("session")?.getItem(TOKENS_KEY) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function writeMachines(machines: StoredMachine[]): void {
  storage("local")?.setItem(MACHINES_KEY, JSON.stringify(machines));
}

function writeTokens(tokens: Record<string, string>): void {
  storage("session")?.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

function notify(): void {
  window.dispatchEvent(new CustomEvent(CHANGED_EVENT));
}

export function subscribeToBrowserMachines(callback: () => void): () => void {
  window.addEventListener(CHANGED_EVENT, callback);
  return () => window.removeEventListener(CHANGED_EVENT, callback);
}

/** HTTPS origin only (loopback may use HTTP); no credentials, path or query. */
export function normalizeMachineOrigin(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter the machine's HTTPS address.");
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error("Enter a valid HTTPS address.");
  }
  if (url.username || url.password) {
    throw new Error("Put the gateway token in the token field, not in the URL.");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use the machine's origin only, without a path, query, or fragment.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Other machines must be reached over HTTPS, such as their Tailscale address.");
  }
  return url.origin;
}

async function fetchHello(origin: string, token: string | null): Promise<BackendHello | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HELLO_TIMEOUT_MS);
  try {
    const response = await fetch(new URL(BACKEND_HELLO_PATH, origin), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      credentials: token ? "omit" : "same-origin",
      mode: token ? "cors" : "same-origin",
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status === 401) throw new Error("The gateway token was rejected.");
    if (!response.ok) return null;
    const hello = parseBackendHello(await response.json());
    if (!isClientApiCompatible(hello)) {
      throw new Error(`That machine (${hello.appVersion}) does not support this client version.`);
    }
    return hello;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("The machine did not respond in time.");
    if (error instanceof TypeError) {
      // The browser hides the reason (network, certificate, CORS or local
      // network permission); say what is known instead of inventing a cause.
      throw new Error(
        "Could not reach this route. Check the address, that the machine is online, and that it allows this page's origin.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function boundSummary(): ConnectionSummary {
  if (!boundHelloRequested) {
    boundHelloRequested = true;
    void fetchHello(window.location.origin, null)
      .then((hello) => {
        boundHello = hello;
        notify();
      })
      .catch(() => undefined);
  }
  return {
    id: BOUND_BROWSER_MACHINE_ID,
    name: window.location.hostname,
    address: window.location.origin,
    kind: "remote",
    active: true,
    requiresToken: false,
    transport: "connected",
    identity: boundHello ? "verified" : "provisional",
    ...(boundHello
      ? {
          backendId: boundHello.installationId,
          profile: {
            displayName: boundHello.profile.displayName,
            colorToken: boundHello.profile.colorToken,
            revision: boundHello.profile.revision,
            cached: false,
          },
        }
      : {}),
  };
}

export function browserFederationList(): ConnectionList {
  const tokens = readTokens();
  const boundId = boundHello?.installationId;
  return {
    activeConnectionId: BOUND_BROWSER_MACHINE_ID,
    supportedRouteKinds: ["https"],
    features: { federation: true, sshRoutes: false, routeFallback: false },
    connections: [
      boundSummary(),
      ...readMachines().map((machine): ConnectionSummary => {
        const status = statuses.get(machine.id);
        const hello = status?.hello;
        const conflict = Boolean(hello && boundId && hello.installationId === boundId);
        return {
          id: machine.id,
          name: machine.nickname || new URL(machine.origin).hostname,
          ...(machine.nickname ? { nickname: machine.nickname } : {}),
          address: machine.origin,
          kind: "remote",
          active: false,
          requiresToken: !tokens[machine.id],
          transport: tokens[machine.id]
            ? (status?.transport ?? "connecting")
            : "authentication-required",
          ...(status?.detail ? { transportDetail: status.detail } : {}),
          identity: hello ? (conflict ? "conflict" : "verified") : "provisional",
          ...(hello && !conflict
            ? {
                backendId: hello.installationId,
                generation: hello.generation,
                profile: {
                  displayName: hello.profile.displayName,
                  colorToken: hello.profile.colorToken,
                  revision: hello.profile.revision,
                  cached: false,
                },
              }
            : {}),
          routes: [
            {
              id: `${machine.id}-https`,
              kind: "https",
              label: new URL(machine.origin).host,
              enabled: true,
              active: true,
              supported: true,
            },
          ],
        };
      }),
    ],
  };
}

export async function addBrowserMachine(input: {
  address: string;
  token: string;
  nickname?: string;
}): Promise<void> {
  const origin = normalizeMachineOrigin(input.address);
  if (origin === window.location.origin) {
    throw new Error("This page already shows that machine.");
  }
  const token = normalizeGatewayToken(input.token);
  const nickname = normalizeConnectionNickname(input.nickname);
  const hello = await fetchHello(origin, token);
  const machines = readMachines();
  if (machines.length >= MAX_BROWSER_MACHINES) throw new Error("Remove a machine first.");
  if (hello) {
    const duplicate = machines.find(
      (machine) => statuses.get(machine.id)?.hello?.installationId === hello.installationId,
    );
    if (duplicate || hello.installationId === boundHello?.installationId) {
      throw new Error("That address answers as a machine you already have.");
    }
  }
  const existing = machines.find((machine) => machine.origin === origin);
  const id = existing?.id ?? `machine-${crypto.randomUUID()}`;
  writeMachines([
    ...machines.filter((machine) => machine.id !== id),
    {
      id,
      origin,
      ...(nickname ? { nickname } : {}),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
    },
  ]);
  writeTokens({ ...readTokens(), [id]: token });
  statuses.set(id, { transport: "connecting", ...(hello ? { hello } : {}) });
  notify();
}

/** Forget a machine in this browser. It does not revoke anything remotely. */
export function removeBrowserMachine(id: string): void {
  writeMachines(readMachines().filter((machine) => machine.id !== id));
  const tokens = readTokens();
  delete tokens[id];
  writeTokens(tokens);
  statuses.delete(id);
  notify();
}

/** Credentials for a same-origin panel frame of this tab; never sent anywhere else. */
export function browserMachineCredentials(id: string): { origin: string; token: string } | null {
  const machine = readMachines().find((candidate) => candidate.id === id);
  const token = readTokens()[id];
  return machine && token ? { origin: machine.origin, token } : null;
}

function setStatus(id: string, update: Partial<MachineStatus>): void {
  const previous = statuses.get(id) ?? { transport: "connecting" as const };
  const next = { ...previous, ...update };
  if (update.detail === undefined && "detail" in update) delete next.detail;
  if (previous.transport === next.transport && previous.detail === next.detail && !update.hello)
    return;
  statuses.set(id, next);
  notify();
}

export function createBrowserMachineClient(id: string): BackendClient | null {
  const credentials = browserMachineCredentials(id);
  if (!credentials) return null;
  const client = createHttpBackendClient({
    connectionId: id,
    origin: credentials.origin,
    token: credentials.token,
    onTransport: (state, detail) => {
      setStatus(id, {
        transport:
          state === "open"
            ? "connected"
            : state === "unauthorized"
              ? "authentication-required"
              : "reconnecting",
        detail: state === "open" ? undefined : detail,
      });
    },
  });
  if (!statuses.get(id)?.hello) {
    void fetchHello(credentials.origin, credentials.token)
      .then((hello) => {
        if (hello) setStatus(id, { hello });
      })
      .catch((error: unknown) =>
        setStatus(id, {
          transport: "unreachable",
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  return client;
}
