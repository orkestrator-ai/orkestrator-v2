import { describe, expect, test } from "bun:test";
import {
  jwtExpiryMs,
  restrictCodexAuthSnapshot,
  restrictGrokAuthSnapshot,
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
