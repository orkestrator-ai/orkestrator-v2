import { describe, expect, test } from "bun:test";
import {
  jwtExpiryMs,
  nonRotatingOAuthProviders,
  PROVIDER_AUTH_MIN_VALIDITY_MS,
  restrictCodexAuthSnapshot,
  restrictGrokAuthSnapshot,
  restrictOpenCodeAuthSnapshot,
  restrictPiAuthSnapshot,
  restrictProviderAuthEntries,
} from "./login-snapshots";

const NOW = Date.parse("2026-10-21T12:00:00Z");

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(claims)}.sig`;
}

function text(snapshot: ReturnType<typeof restrictCodexAuthSnapshot>): Record<string, unknown> {
  if (!("text" in snapshot)) throw new Error(`withheld: ${snapshot.withheld}`);
  return JSON.parse(snapshot.text) as Record<string, unknown>;
}

describe("restrictGrokAuthSnapshot", () => {
  test("keeps a live login's access token and blanks its refresh token", () => {
    const snapshot = restrictGrokAuthSnapshot(
      JSON.stringify({
        "https://auth.x.ai::client": {
          key: "access",
          refresh_token: "single-use",
          expires_at: "2026-10-21T18:00:00Z",
          email: "a@example.com",
        },
      }),
      NOW,
    );
    expect(text(snapshot)).toEqual({
      "https://auth.x.ai::client": {
        key: "access",
        refresh_token: "",
        expires_at: "2026-10-21T18:00:00Z",
        email: "a@example.com",
      },
    });
  });

  test("drops expired and nearly expired logins, and withholds when none is left", () => {
    const login = (expiresAt: string) => ({ key: "k", refresh_token: "r", expires_at: expiresAt });
    const mixed = restrictGrokAuthSnapshot(
      JSON.stringify({
        expired: login("2026-10-21T11:00:00Z"),
        closing: login("2026-10-21T12:00:30Z"),
        live: login("2026-10-21T13:00:00Z"),
      }),
      NOW,
    );
    expect(Object.keys(text(mixed))).toEqual(["live"]);
    const none = restrictGrokAuthSnapshot(
      JSON.stringify({ expired: login("2026-10-21T11:00:00Z") }),
      NOW,
    );
    expect(none).toHaveProperty("withheld");
    expect(JSON.stringify(none)).not.toContain('"k"');
  });

  test("withholds text that is not a JSON object, without echoing it", () => {
    for (const input of ["SENTINEL-not-json", "[]", "null"]) {
      const snapshot = restrictGrokAuthSnapshot(input, NOW);
      expect(snapshot).toHaveProperty("withheld");
      expect(JSON.stringify(snapshot)).not.toContain("SENTINEL");
    }
  });
});

describe("restrictCodexAuthSnapshot", () => {
  const live = jwt({ exp: NOW / 1000 + 9 * 24 * 3600 });
  const expired = jwt({ exp: NOW / 1000 - 60 });

  test("blanks a ChatGPT login's refresh token and stamps last_refresh now", () => {
    const restricted = text(
      restrictCodexAuthSnapshot(
        JSON.stringify({
          OPENAI_API_KEY: null,
          auth_mode: "chatgpt",
          last_refresh: "2026-10-12T00:00:00Z",
          tokens: { id_token: "id", access_token: live, refresh_token: "rt", account_id: "acc" },
        }),
        NOW,
      ),
    );
    expect(restricted).toEqual({
      OPENAI_API_KEY: null,
      auth_mode: "chatgpt",
      last_refresh: new Date(NOW).toISOString(),
      tokens: { id_token: "id", access_token: live, refresh_token: "", account_id: "acc" },
    });
  });

  test("withholds an expired ChatGPT login, keeping an API key when there is one", () => {
    const expiredLogin = {
      auth_mode: "chatgpt",
      last_refresh: "2026-10-01T00:00:00Z",
      tokens: { access_token: expired, refresh_token: "SENTINEL-RT" },
    };
    const withheld = restrictCodexAuthSnapshot(JSON.stringify(expiredLogin), NOW);
    expect(withheld).toHaveProperty("withheld");
    expect(JSON.stringify(withheld)).not.toContain("SENTINEL");
    expect(
      text(
        restrictCodexAuthSnapshot(
          JSON.stringify({ ...expiredLogin, OPENAI_API_KEY: "sk-test" }),
          NOW,
        ),
      ),
    ).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  test("keeps an API-key login unchanged and withholds an empty one", () => {
    expect(text(restrictCodexAuthSnapshot('{"OPENAI_API_KEY":"sk-test"}', NOW))).toEqual({
      OPENAI_API_KEY: "sk-test",
    });
    expect(restrictCodexAuthSnapshot('{"OPENAI_API_KEY":null,"tokens":null}', NOW)).toHaveProperty(
      "withheld",
    );
    expect(restrictCodexAuthSnapshot("SENTINEL", NOW)).toHaveProperty("withheld");
    expect(restrictCodexAuthSnapshot('{"tokens":"x"}', NOW)).toHaveProperty("withheld");
  });

  test("an access token without a readable expiry is kept, refresh token blanked", () => {
    const restricted = text(
      restrictCodexAuthSnapshot(
        JSON.stringify({ tokens: { access_token: "opaque", refresh_token: "rt" } }),
        NOW,
      ),
    );
    expect(restricted.tokens).toEqual({ access_token: "opaque", refresh_token: "" });
  });
});

describe("jwtExpiryMs", () => {
  test("reads exp in milliseconds and ignores anything else", () => {
    expect(jwtExpiryMs(jwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000);
    expect(jwtExpiryMs(jwt({ iat: 1 }))).toBeUndefined();
    expect(jwtExpiryMs("opaque")).toBeUndefined();
    expect(jwtExpiryMs("a.!!!.c")).toBeUndefined();
  });
});

describe("restrictPiAuthSnapshot", () => {
  const HOUR = 60 * 60 * 1000;
  const oauth = (expires: number, extra: Record<string, unknown> = {}) => ({
    type: "oauth",
    access: "access-token",
    refresh: "rotating-refresh",
    expires,
    ...extra,
  });

  test("blanks rotating OAuth refresh tokens and keeps everything else on the entry", () => {
    const snapshot = restrictPiAuthSnapshot(
      JSON.stringify({
        anthropic: oauth(NOW + 8 * HOUR),
        "openai-codex": oauth(NOW + 240 * HOUR, { accountId: "acct" }),
        openai: oauth(NOW + HOUR, { clientId: "client", scopes: ["a"] }),
      }),
      NOW,
    );
    expect(text(snapshot)).toEqual({
      anthropic: { ...oauth(NOW + 8 * HOUR), refresh: "" },
      "openai-codex": { ...oauth(NOW + 240 * HOUR, { accountId: "acct" }), refresh: "" },
      openai: { ...oauth(NOW + HOUR, { clientId: "client", scopes: ["a"] }), refresh: "" },
    });
    expect(snapshot).not.toHaveProperty("dropped");
  });

  test("keeps API keys and non-rotating OAuth logins whole, even past expiry", () => {
    const entries = {
      openrouter: { type: "api_key", key: "sk-or" },
      env: { type: "api_key", env: { AWS_PROFILE: "work" } },
      "github-copilot": oauth(NOW + 10 * 60 * 1000, { enterpriseUrl: "ghe.example.com" }),
      meta: oauth(NOW - HOUR),
    };
    expect(text(restrictPiAuthSnapshot(JSON.stringify(entries), NOW))).toEqual(entries);
  });

  test("drops logins too close to Pi's own five-minute refresh window", () => {
    const snapshot = restrictPiAuthSnapshot(
      JSON.stringify({
        expired: oauth(NOW - HOUR),
        closing: oauth(NOW + 5 * 60 * 1000),
        live: oauth(NOW + PROVIDER_AUTH_MIN_VALIDITY_MS),
        key: { type: "api_key", key: "k" },
      }),
      NOW,
    );
    expect(Object.keys(text(snapshot))).toEqual(["live", "key"]);
    expect(snapshot).toMatchObject({ dropped: 2 });
  });

  test("honours a JWT access token that expires before the stored expiry", () => {
    const access = jwt({ exp: Math.floor((NOW + 60_000) / 1000) });
    const snapshot = restrictPiAuthSnapshot(
      JSON.stringify({ xai: { ...oauth(NOW + 6 * HOUR), access } }),
      NOW,
    );
    expect(snapshot).toHaveProperty("withheld");
  });

  test("uses a JWT access token's expiry when the stored one is missing", () => {
    const access = jwt({ exp: Math.floor((NOW + 2 * HOUR) / 1000) });
    const { expires: _expires, ...noExpiry } = oauth(0, { access });
    expect(text(restrictPiAuthSnapshot(JSON.stringify({ xai: noExpiry }), NOW))).toEqual({
      xai: { ...noExpiry, refresh: "" },
    });
    const nearly = jwt({ exp: Math.floor((NOW + 60_000) / 1000) });
    expect(
      restrictPiAuthSnapshot(JSON.stringify({ xai: { ...noExpiry, access: nearly } }), NOW),
    ).toHaveProperty("withheld");
    // With neither expiry readable the login cannot be shown to be live.
    expect(
      restrictPiAuthSnapshot(JSON.stringify({ xai: { ...noExpiry, access: "opaque" } }), NOW),
    ).toHaveProperty("withheld");
  });

  test("withholds a file of expired logins without echoing it, and keeps an empty one", () => {
    const none = restrictPiAuthSnapshot(JSON.stringify({ anthropic: oauth(NOW - HOUR) }), NOW);
    expect(none).toHaveProperty("withheld");
    expect(JSON.stringify(none)).not.toContain("rotating-refresh");
    expect(text(restrictPiAuthSnapshot("{}", NOW))).toEqual({});
    expect(restrictPiAuthSnapshot("[]", NOW)).toHaveProperty("withheld");
    expect(JSON.stringify(restrictPiAuthSnapshot("not json rotating-refresh", NOW))).not.toContain(
      "rotating-refresh",
    );
  });

  test("drops entries Pi would reject, so one cannot invalidate the whole file", () => {
    const snapshot = restrictPiAuthSnapshot(
      JSON.stringify({
        future: { type: "device", token: "t" },
        broken: "string",
        anthropic: oauth(NOW + 8 * HOUR),
      }),
      NOW,
    );
    expect(Object.keys(text(snapshot))).toEqual(["anthropic"]);
    expect(snapshot).toMatchObject({ dropped: 2 });
  });
});

describe("restrictOpenCodeAuthSnapshot", () => {
  test("keeps api and wellknown keys and Copilot's reused GitHub token", () => {
    const entries = {
      "opencode-go": { type: "api", key: "sk-go", metadata: { a: "b" } },
      "https://gateway.example.com": { type: "wellknown", key: "KEY", token: "t" },
      // OpenCode stores Copilot's GitHub token as both access and refresh, expires 0.
      "github-copilot": { type: "oauth", access: "gho", refresh: "gho", expires: 0 },
    };
    expect(text(restrictOpenCodeAuthSnapshot(JSON.stringify(entries), NOW))).toEqual(entries);
  });

  test("blanks OpenAI and xAI OAuth refresh tokens and drops expired ones", () => {
    const snapshot = restrictOpenCodeAuthSnapshot(
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "a",
          refresh: "single-use",
          expires: NOW + 3_600_000,
          accountId: "acct",
        },
        xai: { type: "oauth", access: "x", refresh: "single-use", expires: 0 },
      }),
      NOW,
    );
    expect(text(snapshot)).toEqual({
      openai: {
        type: "oauth",
        access: "a",
        refresh: "",
        expires: NOW + 3_600_000,
        accountId: "acct",
      },
    });
    expect(snapshot).toMatchObject({ dropped: 1 });
  });
});

describe("restrictProviderAuthEntries", () => {
  test("lists every rotating OAuth provider, including dropped ones", () => {
    const restricted = restrictProviderAuthEntries(
      "pi",
      JSON.stringify({
        anthropic: { type: "oauth", access: "a", refresh: "r", expires: NOW - 1 },
        "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: NOW + 3_600_000 },
        "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: NOW - 1 },
        key: { type: "api_key", key: "k" },
      }),
      NOW,
    );
    if ("withheld" in restricted) throw new Error(restricted.withheld);
    expect(restricted.accessOnly).toEqual(["anthropic", "openai-codex"]);
    expect(Object.keys(restricted.entries)).toEqual(["openai-codex", "github-copilot", "key"]);
  });

  test("a withheld file still lists its rotating providers, and its text no credential", () => {
    const restricted = restrictProviderAuthEntries(
      "opencode",
      JSON.stringify({
        openai: { type: "oauth", access: "a", refresh: "SENTINEL", expires: NOW - 1 },
        "github-copilot": { type: "device", token: "t" },
      }),
      NOW,
    );
    expect(restricted).toEqual({ withheld: expect.any(String), accessOnly: ["openai"] });
    expect(restrictProviderAuthEntries("opencode", "[]", NOW)).toEqual({
      withheld: expect.any(String),
      accessOnly: [],
    });
    // The snapshot form is unchanged: a reason and nothing else.
    expect(
      Object.keys(
        restrictOpenCodeAuthSnapshot(
          JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: 1 } }),
          NOW,
        ),
      ),
    ).toEqual(["withheld"]);
    expect(JSON.stringify(restricted)).not.toContain("SENTINEL");
  });

  test("names the non-rotating providers the entrypoint must match", () => {
    expect(nonRotatingOAuthProviders("opencode")).toEqual(["github-copilot"]);
    expect(nonRotatingOAuthProviders("pi")).toEqual(["github-copilot", "meta"]);
  });
});
