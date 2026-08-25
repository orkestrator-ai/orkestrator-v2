import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  assertAuthenticated,
  authStatus,
  CredentialError,
  setAuthProbeTimeoutForTests,
} from "./credentials.js";
import { setModelRuntimeFactoryForTests } from "./runtime.js";

interface RuntimeOptions {
  providers: Array<{ id: string; name?: string }>;
  configured?: ReadonlySet<string>;
  checkAuth?: (providerId: string) => Promise<unknown>;
  getAvailable?: (providerId?: string) => Promise<unknown[]>;
}

function fakeRuntime(options: RuntimeOptions): ModelRuntime {
  return {
    getProviders: () => options.providers,
    hasConfiguredAuth: (providerId: string) => options.configured?.has(providerId) ?? false,
    checkAuth: (providerId: string) =>
      options.checkAuth?.(providerId) ?? Promise.resolve(undefined),
    getAvailable: (providerId?: string) =>
      options.getAvailable?.(providerId) ?? Promise.resolve([]),
  } as unknown as ModelRuntime;
}

function install(runtime: ModelRuntime): void {
  setModelRuntimeFactoryForTests(async () => runtime);
}

afterEach(() => {
  setAuthProbeTimeoutForTests();
  setModelRuntimeFactoryForTests();
});

describe("authStatus", () => {
  test("reports configured credentials without exposing their value", async () => {
    install(
      fakeRuntime({
        providers: [
          { id: "anthropic", name: "Anthropic" },
          { id: "openai", name: "OpenAI" },
        ],
        configured: new Set(["anthropic"]),
        checkAuth: async () => ({ source: "environment", type: "api_key" }),
        getAvailable: async (providerId) => (providerId === "anthropic" ? [{ id: "opus" }] : []),
      }),
    );

    expect(await authStatus()).toEqual({
      authenticated: true,
      providers: [
        {
          id: "anthropic",
          label: "Anthropic",
          authenticated: true,
          source: "environment",
          type: "api_key",
          modelCount: 1,
        },
        { id: "openai", label: "OpenAI", authenticated: false, modelCount: 0 },
      ],
    });
  });

  test("reports a configured but revoked credential as unauthenticated", async () => {
    install(
      fakeRuntime({
        providers: [{ id: "anthropic", name: "Anthropic" }],
        configured: new Set(["anthropic"]),
        checkAuth: async () => undefined,
        getAvailable: async () => [],
      }),
    );

    expect(await authStatus()).toEqual({
      authenticated: false,
      providers: [{ id: "anthropic", label: "Anthropic", authenticated: false, modelCount: 0 }],
    });
  });

  test("bounds stalled auth and model probes and fails closed", async () => {
    setAuthProbeTimeoutForTests(5);
    install(
      fakeRuntime({
        providers: [{ id: "slow", name: "Slow Provider" }],
        configured: new Set(["slow"]),
        checkAuth: () => new Promise(() => undefined),
        getAvailable: () => new Promise(() => undefined),
      }),
    );

    const started = performance.now();
    const status = await authStatus();
    expect(performance.now() - started).toBeLessThan(250);
    expect(status).toEqual({
      authenticated: false,
      providers: [{ id: "slow", label: "Slow Provider", authenticated: false, modelCount: 0 }],
    });
  });

  test("starts every provider's auth and model probes concurrently in input order", async () => {
    const started: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    install(
      fakeRuntime({
        providers: [
          { id: "first", name: "First" },
          { id: "second", name: "Second" },
        ],
        configured: new Set(["first", "second"]),
        checkAuth: async (providerId) => {
          started.push(`auth:${providerId}`);
          await gate;
          return { source: "file", type: "api_key" };
        },
        getAvailable: async (providerId) => {
          started.push(`models:${providerId}`);
          await gate;
          return [{ id: `${providerId}-model` }];
        },
      }),
    );

    const statusPromise = authStatus();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["auth:first", "models:first", "auth:second", "models:second"]);
    release();

    const status = await statusPromise;
    expect(status.providers.map((provider) => provider.id)).toEqual(["first", "second"]);
  });
});

describe("assertAuthenticated", () => {
  test("accepts a runtime with an available model", async () => {
    install(fakeRuntime({ providers: [], getAvailable: async () => [{ id: "available" }] }));
    await expect(assertAuthenticated()).resolves.toBeUndefined();
  });

  test("rejects early when no model provider is usable", async () => {
    install(fakeRuntime({ providers: [], getAvailable: async () => [] }));
    await expect(assertAuthenticated()).rejects.toBeInstanceOf(CredentialError);
  });
});
