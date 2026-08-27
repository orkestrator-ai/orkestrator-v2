import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  accountUsageForResolvedCredential,
  CursorInternalApiProvider,
  getCursorAccountUsage,
  MISSING_CURSOR_CREDENTIAL_MESSAGE,
  normalizeCursorAccountUsage,
  numberish,
  percent,
  signedNumberish,
  unixMsToIso,
} from "./cursor-usage.js";

const CURRENT_PERIOD = {
  billingCycleStart: "1785542400000",
  billingCycleEnd: "1788220800000",
  planUsage: {
    totalSpend: 23_222,
    includedSpend: "23222",
    remaining: 16_778,
    limit: 40_000,
    autoPercentUsed: 0,
    apiPercentUsed: "46.444",
    totalPercentUsed: 15.48,
  },
  spendLimitUsage: {
    totalSpend: 0,
    pooledLimit: 50_000,
    pooledUsed: 0,
    pooledRemaining: 50_000,
    individualLimit: 10_000,
    individualRemaining: 10_000,
    limitType: "user",
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Cursor usage tolerant parsing", () => {
  test("accepts numeric strings without accepting invalid or nonsensical values", () => {
    expect(numberish("123")).toBe(123);
    expect(numberish(null)).toBeUndefined();
    expect(numberish("Infinity")).toBeUndefined();
    expect(numberish(-1)).toBeUndefined();
    expect(signedNumberish(-1)).toBe(-1);
    expect(signedNumberish("-2500")).toBe(-2500);
    expect(signedNumberish("nope")).toBeUndefined();
    expect(percent("46.444")).toBe(46.444);
    expect(unixMsToIso("1785542400000")).toBe("2026-08-01T00:00:00.000Z");
    expect(unixMsToIso(1_788_220_800_000)).toBe("2026-09-01T00:00:00.000Z");
    expect(unixMsToIso("not-a-date")).toBeUndefined();
  });

  test("keeps an over-quota percentage rather than discarding it", () => {
    // Discarding >100 dropped the bar for the accounts the readout matters most
    // for, and for a percentage-only response dropped every field.
    expect(percent(101)).toBe(101);
    expect(percent(112.5)).toBe(112.5);
    expect(percent(-1)).toBeUndefined();
  });

  test("rejects implausible billing-cycle timestamps instead of rendering 1970", () => {
    expect(unixMsToIso(0)).toBeUndefined();
    // Second-scale: the same instant as the valid millisecond value above.
    expect(unixMsToIso(1_785_542_400)).toBeUndefined();
    // Microsecond-scale.
    expect(unixMsToIso(1_785_542_400_000_000)).toBeUndefined();
  });

  test("normalizes individual usage, plan information, buckets, and spend limits", () => {
    const result = normalizeCursorAccountUsage(
      CURRENT_PERIOD,
      {
        planInfo: {
          planName: "Ultra",
          includedAmountCents: 40_000,
          unknownFutureField: true,
        },
      },
      "2026-08-26T16:00:00.000Z",
    );

    expect(result).toEqual({
      ok: true,
      data: {
        provider: "cursor",
        plan: "Ultra",
        cycle: {
          startsAt: "2026-08-01T00:00:00.000Z",
          endsAt: "2026-09-01T00:00:00.000Z",
        },
        included: {
          usedCents: 23_222,
          remainingCents: 16_778,
          limitCents: 40_000,
          usedPercent: 58.055,
        },
        buckets: [
          {
            id: "cursor-internal-auto",
            label: "Cursor Models",
            window: "billing_cycle",
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: "2026-09-01T00:00:00.000Z",
            sourceField: "planUsage.autoPercentUsed",
          },
          {
            id: "cursor-internal-api",
            label: "Other Models",
            window: "billing_cycle",
            usedPercent: 46.444,
            remainingPercent: 53.556,
            resetsAt: "2026-09-01T00:00:00.000Z",
            sourceField: "planUsage.apiPercentUsed",
          },
        ],
        onDemand: {
          usedCents: 0,
          individualLimitCents: 10_000,
          individualRemainingCents: 10_000,
          pooledLimitCents: 50_000,
          pooledUsedCents: 0,
          pooledRemainingCents: 50_000,
          limitType: "user",
        },
        internalPercentages: {
          autoPercentUsed: 0,
          apiPercentUsed: 46.444,
          totalPercentUsed: 15.48,
        },
        source: {
          kind: "internal-dashboard-api",
          retrievedAt: "2026-08-26T16:00:00.000Z",
        },
      },
    });
  });

  test("keeps the reported quota separate from saturated included spend", () => {
    const result = normalizeCursorAccountUsage(
      {
        billingCycleEnd: 1_788_220_800_000,
        planUsage: {
          includedSpend: 2_000,
          limit: 2_000,
          autoPercentUsed: 50,
          apiPercentUsed: 0,
          totalPercentUsed: 50,
        },
      },
      { planInfo: { planName: "Pro" } },
      "2026-08-27T12:32:54.000Z",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        included: {
          usedCents: 2_000,
          limitCents: 2_000,
          usedPercent: 100,
        },
        internalPercentages: { autoPercentUsed: 50, apiPercentUsed: 0, totalPercentUsed: 50 },
        buckets: [
          { label: "Cursor Models", usedPercent: 50 },
          { label: "Other Models", usedPercent: 0 },
        ],
      },
    });
  });

  test("derives included usage from totalSpend when the reported percentage is absent", () => {
    const result = normalizeCursorAccountUsage(
      {
        planUsage: {
          totalSpend: 10_000,
          limit: 40_000,
        },
      },
      undefined,
      "2026-08-27T12:32:54.000Z",
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        included: {
          usedCents: 10_000,
          limitCents: 40_000,
          usedPercent: 25,
        },
      },
    });
  });

  test("omits the derived percentage when the included limit is zero", () => {
    const result = normalizeCursorAccountUsage(
      {
        planUsage: {
          includedSpend: 1_000,
          limit: 0,
        },
      },
      undefined,
      "2026-08-27T12:32:54.000Z",
    );

    expect(result).toMatchObject({
      ok: true,
      data: { included: { usedCents: 1_000, limitCents: 0 } },
    });
    if (!result.ok) return;
    expect(result.data.included).not.toHaveProperty("usedPercent");
  });

  test("reports an over-allowance account even when Cursor's quota is below 100 percent", () => {
    const result = normalizeCursorAccountUsage(
      {
        billingCycleEnd: 1_788_220_800_000,
        planUsage: {
          includedSpend: 46_000,
          remaining: -6_000,
          limit: 40_000,
          autoPercentUsed: 112.5,
          totalPercentUsed: 50,
        },
      },
      undefined,
      "2026-08-26T16:00:00.000Z",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.included).toMatchObject({
      usedCents: 46_000,
      remainingCents: -6_000,
      limitCents: 40_000,
    });
    expect(result.data.included.usedPercent).toBeCloseTo(115, 6);
    expect(result.data.buckets[0]).toMatchObject({
      usedPercent: 112.5,
      remainingPercent: 0,
    });
    expect(result.data.internalPercentages).toEqual({
      autoPercentUsed: 112.5,
      totalPercentUsed: 50,
    });
  });

  test("accepts a response carrying only percentages", () => {
    // No cents fields at all: discarding out-of-range percentages used to drop
    // every field here and report a well-formed payload as INVALID_RESPONSE.
    expect(
      normalizeCursorAccountUsage(
        { planUsage: { autoPercentUsed: 120, apiPercentUsed: 130, totalPercentUsed: 125 } },
        undefined,
        "2026-08-26T16:00:00.000Z",
      ),
    ).toMatchObject({
      ok: true,
      data: {
        included: {},
        buckets: [{ usedPercent: 120 }, { usedPercent: 130 }],
        internalPercentages: {
          autoPercentUsed: 120,
          apiPercentUsed: 130,
          totalPercentUsed: 125,
        },
      },
    });
  });

  test("does not turn a team response with no planUsage into zero usage", () => {
    expect(
      normalizeCursorAccountUsage(
        {
          billingCycleStart: "1785542400000",
          billingCycleEnd: "1788220800000",
          displayThreshold: 100,
        },
        undefined,
        "2026-08-26T16:00:00.000Z",
      ),
    ).toMatchObject({ ok: false, code: "MISSING_PLAN_USAGE", retryable: false });
  });

  test("keeps valid partial fields and omits malformed optional fields", () => {
    const result = normalizeCursorAccountUsage(
      {
        billingCycleStart: "invalid",
        billingCycleEnd: 1_788_220_800_000,
        planUsage: {
          includedSpend: "nope",
          remaining: null,
          limit: 40_000,
          autoPercentUsed: -1,
          apiPercentUsed: 12.5,
          totalPercentUsed: Number.POSITIVE_INFINITY,
          future: { nested: true },
        },
      },
      { planInfo: { planName: 123 } },
      "2026-08-26T16:00:00.000Z",
      { auto: "Auto", api: "API" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.cycle).toEqual({ endsAt: "2026-09-01T00:00:00.000Z" });
    expect(result.data.included).toEqual({ limitCents: 40_000 });
    expect(result.data.buckets).toEqual([
      {
        id: "cursor-internal-api",
        label: "API",
        window: "billing_cycle",
        usedPercent: 12.5,
        remainingPercent: 87.5,
        resetsAt: "2026-09-01T00:00:00.000Z",
        sourceField: "planUsage.apiPercentUsed",
      },
    ]);
    expect(result.data).not.toHaveProperty("plan");
    expect(result.data.included).not.toHaveProperty("usedCents");
  });
});

describe("CursorInternalApiProvider", () => {
  test("re-exchanges once when an access token expires and caches successful quota reads", async () => {
    let now = Date.parse("2026-08-26T16:00:00.000Z");
    const responses = [
      json({ accessToken: "old-token", expires_in: 3600 }),
      json({ error: "expired" }, 401),
      json({ access_token: "fresh-token", expires_in: "3600" }),
      json(CURRENT_PERIOD),
      json({ planInfo: { planName: "Ultra" } }),
    ];
    const sent: Array<{ url: string; authorization?: string }> = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(input),
        authorization: (init?.headers as Record<string, string> | undefined)?.Authorization,
      });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    const provider = new CursorInternalApiProvider("crsr_test", {
      fetchImpl,
      now: () => now,
    });

    const first = await provider.getAccountUsage();
    expect(first).toMatchObject({ ok: true, data: { plan: "Ultra" } });
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    // The raw user key buys a token and goes no further. Both exchanges carry
    // it (the second is the re-exchange); every dashboard call carries an
    // exchanged bearer instead.
    const keyBearers = sent.filter((request) => request.authorization === "Bearer crsr_test");
    expect(keyBearers.map((request) => request.url)).toEqual([
      "https://api2.cursor.sh/auth/exchange_user_api_key",
      "https://api2.cursor.sh/auth/exchange_user_api_key",
    ]);
    const dashboardCalls = sent.filter((request) => request.url.includes("DashboardService"));
    expect(dashboardCalls).toHaveLength(3);
    expect(dashboardCalls.map((request) => request.authorization)).toEqual([
      "Bearer old-token",
      "Bearer fresh-token",
      "Bearer fresh-token",
    ]);

    now += 30_000;
    expect(await provider.getAccountUsage()).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  test("returns a structured authentication failure without leaking the key", async () => {
    const fetchImpl = mock(async () => json({ error: "invalid key" }, 401));
    const result = await new CursorInternalApiProvider("crsr_super_secret", {
      fetchImpl,
    }).getAccountUsage();

    expect(result).toMatchObject({ ok: false, code: "AUTH_FAILED", retryable: false });
    expect(JSON.stringify(result)).not.toContain("crsr_super_secret");
  });

  test("reports malformed plan usage instead of fabricating an empty balance", async () => {
    const responses = [
      json({ token: "access-token" }),
      json({ planUsage: { limit: "not-money" } }),
      json({}),
    ];
    const fetchImpl = mock(async () => responses.shift()!);
    const result = await new CursorInternalApiProvider("crsr_test", {
      fetchImpl,
    }).getAccountUsage();

    expect(result).toMatchObject({ ok: false, code: "INVALID_RESPONSE" });
  });
});

/** Minimal unsigned JWT carrying only the `exp` claim the provider reads. */
function tokenExpiringAt(expiryMs: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(expiryMs / 1_000) })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

function streamingResponse(chunks: Uint8Array[], signal?: AbortSignal | null): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (signal) {
        signal.addEventListener("abort", () => controller.error(new Error("aborted")));
      } else {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200 });
}

describe("CursorInternalApiProvider transport failures", () => {
  test.each([
    [429, "RATE_LIMITED", true],
    [404, "INTERNAL_API_CHANGED", false],
    [405, "INTERNAL_API_CHANGED", false],
    [500, "NETWORK_ERROR", true],
    [418, "NETWORK_ERROR", false],
  ] as const)("maps HTTP %i onto %s", async (status, code, retryable) => {
    const responses = [json({ accessToken: "token" }), json({ error: "no" }, status)];
    const result = await new CursorInternalApiProvider("crsr_test", {
      fetchImpl: mock(async () => responses.shift()!),
    }).getAccountUsage();

    expect(result).toMatchObject({ ok: false, code, retryable });
  });

  test("reports a rate-limited key exchange rather than an authentication failure", async () => {
    const result = await new CursorInternalApiProvider("crsr_test", {
      fetchImpl: mock(async () => json({ error: "slow down" }, 429)),
    }).getAccountUsage();

    expect(result).toMatchObject({ ok: false, code: "RATE_LIMITED", retryable: true });
  });

  test("reports a timeout as a network error even when it lands mid-body", async () => {
    const encoder = new TextEncoder();
    let call = 0;
    const fetchImpl = mock(async (_input: string | URL | Request, init?: RequestInit) => {
      call += 1;
      if (call === 1) return json({ accessToken: "token" });
      // A body that arrives partially and then never completes: the abort fires
      // while `readBoundedJson` is still draining the stream.
      return streamingResponse([encoder.encode('{"planUsage":')], init?.signal);
    });

    const result = await new CursorInternalApiProvider("crsr_test", {
      fetchImpl,
      requestTimeoutMs: 15,
    }).getAccountUsage();

    expect(result).toMatchObject({ ok: false, code: "NETWORK_ERROR", retryable: true });
    if (result.ok) return;
    expect(result.message).toContain("timed out");
  });

  test("reports a timeout before the response headers arrive", async () => {
    const fetchImpl = mock(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );

    const result = await new CursorInternalApiProvider("crsr_test", {
      fetchImpl,
      requestTimeoutMs: 15,
    }).getAccountUsage();

    expect(result).toMatchObject({ ok: false, code: "NETWORK_ERROR", retryable: true });
    if (result.ok) return;
    expect(result.message).toContain("timed out");
  });

  test("reports an oversized body distinctly from malformed data, and does not invite a retry", async () => {
    const oversized = new Uint8Array(600 * 1024).fill(32);
    let call = 0;
    const fetchImpl = mock(async () => {
      call += 1;
      if (call === 1) return json({ accessToken: "token" });
      return streamingResponse([oversized, oversized]);
    });

    const result = await new CursorInternalApiProvider("crsr_test", {
      fetchImpl,
    }).getAccountUsage();

    expect(result).toMatchObject({ ok: false, code: "INVALID_RESPONSE", retryable: false });
    if (result.ok) return;
    expect(result.message).toContain("too large");
  });
});

describe("CursorInternalApiProvider caching and coalescing", () => {
  test("coalesces concurrent reads onto a single set of requests", async () => {
    const responses = [
      json({ accessToken: "token" }),
      json(CURRENT_PERIOD),
      json({ planInfo: { planName: "Ultra" } }),
    ];
    const fetchImpl = mock(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    const provider = new CursorInternalApiProvider("crsr_test", { fetchImpl });

    const [first, second, third] = await Promise.all([
      provider.getAccountUsage(),
      provider.getAccountUsage(),
      provider.getAccountUsage(),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(first).toMatchObject({ ok: true });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  test("caches a non-retryable failure instead of re-exchanging on every read", async () => {
    let now = Date.parse("2026-08-26T16:00:00.000Z");
    const fetchImpl = mock(async () => json({ error: "invalid key" }, 401));
    const provider = new CursorInternalApiProvider("crsr_test", { fetchImpl, now: () => now });

    const first = await provider.getAccountUsage();
    expect(first).toMatchObject({ ok: false, code: "AUTH_FAILED", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Every panel open used to pay the full exchange again.
    now += 60_000;
    expect(await provider.getAccountUsage()).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 10 * 60_000;
    await provider.getAccountUsage();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test("holds a retryable failure only briefly", async () => {
    let now = Date.parse("2026-08-26T16:00:00.000Z");
    const fetchImpl = mock(async () => json({ error: "slow down" }, 429));
    const provider = new CursorInternalApiProvider("crsr_test", { fetchImpl, now: () => now });

    expect(await provider.getAccountUsage()).toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 5_000;
    await provider.getAccountUsage();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now += 6_000;
    await provider.getAccountUsage();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("CursorInternalApiProvider access-token expiry", () => {
  test("takes the earliest reported expiry when the JWT and the payload disagree", async () => {
    const now0 = Date.parse("2026-08-26T16:00:00.000Z");
    let now = now0;
    // `expires_in` claims an hour; the token itself expires in a minute.
    const responses = [
      json({ accessToken: tokenExpiringAt(now0 + 60_000), expires_in: 3600 }),
      json(CURRENT_PERIOD),
      json({ planInfo: { planName: "Ultra" } }),
      json({ accessToken: "second-token", expires_in: 3600 }),
      json(CURRENT_PERIOD),
      json({ planInfo: { planName: "Ultra" } }),
    ];
    const fetchImpl = mock(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    const provider = new CursorInternalApiProvider("crsr_test", {
      fetchImpl,
      now: () => now,
      accountUsageTtlMs: 0,
    });

    await provider.getAccountUsage();
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    now += 40_000;
    await provider.getAccountUsage();
    // Trusting `expires_in` would have skipped the exchange here.
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  test("ignores an already-past expiry and falls back to a conservative lifetime", async () => {
    const now0 = Date.parse("2026-08-26T16:00:00.000Z");
    let now = now0;
    const responses = [
      json({ accessToken: "opaque-token", expires_at: now0 - 1_000 }),
      json(CURRENT_PERIOD),
      json({ planInfo: { planName: "Ultra" } }),
      json(CURRENT_PERIOD),
      json({ planInfo: { planName: "Ultra" } }),
    ];
    const fetchImpl = mock(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return response;
    });
    const provider = new CursorInternalApiProvider("crsr_test", {
      fetchImpl,
      now: () => now,
      accountUsageTtlMs: 0,
    });

    await provider.getAccountUsage();
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    now += 40_000;
    await provider.getAccountUsage();
    // Two dashboard calls, no second exchange.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
});

describe("getCursorAccountUsage credential fingerprint", () => {
  const originalAutoLabel = process.env.CURSOR_USAGE_AUTO_LABEL;

  afterEach(() => {
    if (originalAutoLabel === undefined) delete process.env.CURSOR_USAGE_AUTO_LABEL;
    else process.env.CURSOR_USAGE_AUTO_LABEL = originalAutoLabel;
  });

  test("reuses one provider per key, discards it when the key rotates, and honours label overrides", async () => {
    process.env.CURSOR_USAGE_AUTO_LABEL = "Fast requests";
    // One response serves both the exchange and the dashboard calls.
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      json({ accessToken: "token", ...CURRENT_PERIOD })) as unknown as typeof fetch);

    try {
      const first = await getCursorAccountUsage("crsr_key_one");
      expect(first).toMatchObject({ ok: true });
      if (!first.ok) return;
      expect(first.data.buckets[0]?.label).toBe("Fast requests");
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // Same key: served from the provider's cache.
      await getCursorAccountUsage("crsr_key_one");
      expect(fetchSpy).toHaveBeenCalledTimes(3);

      // A rotated key must not be answered from the previous account's cache.
      await getCursorAccountUsage("crsr_key_two");
      expect(fetchSpy).toHaveBeenCalledTimes(6);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("accountUsageForResolvedCredential", () => {
  test("prefers the configured key over the stored SDK login", async () => {
    const load = mock(async () => ({ ok: true }) as never);
    const storedApiKey = mock(async () => "sdk-key");

    await accountUsageForResolvedCredential({
      configuredApiKey: "configured-key",
      storedApiKey,
      load,
    });

    expect(load).toHaveBeenCalledWith("configured-key");
    expect(storedApiKey).not.toHaveBeenCalled();
  });

  test("falls back to the stored SDK login when nothing is configured", async () => {
    const load = mock(async () => ({ ok: true }) as never);

    await accountUsageForResolvedCredential({
      configuredApiKey: undefined,
      storedApiKey: async () => "sdk-key",
      load,
    });
    expect(load).toHaveBeenCalledWith("sdk-key");

    // A blank configured value is not a credential.
    await accountUsageForResolvedCredential({
      configuredApiKey: "   ",
      storedApiKey: async () => "sdk-key",
      load,
    });
    expect(load).toHaveBeenLastCalledWith("sdk-key");
  });

  test("answers with a structured, non-retryable failure when there is no credential", async () => {
    const load = mock(async () => ({ ok: true }) as never);

    const result = await accountUsageForResolvedCredential({
      configuredApiKey: undefined,
      storedApiKey: async () => undefined,
      load,
    });

    expect(result).toEqual({
      ok: false,
      code: "AUTH_FAILED",
      message: MISSING_CURSOR_CREDENTIAL_MESSAGE,
      retryable: false,
    });
    expect(load).not.toHaveBeenCalled();
  });

  test("passes the provider result through untouched", async () => {
    const provided = {
      ok: false as const,
      code: "MISSING_PLAN_USAGE" as const,
      message: "Cursor did not expose plan quota for this account.",
      retryable: false,
    };

    expect(
      await accountUsageForResolvedCredential({
        configuredApiKey: "configured-key",
        storedApiKey: async () => undefined,
        load: async () => provided,
      }),
    ).toEqual(provided);
  });
});
