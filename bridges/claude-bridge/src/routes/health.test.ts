import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import health from "./health.js";

const app = new Hono();
app.route("/", health);

describe("GET /health", () => {
  test("returns ok status with version", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const body = await res.json();
    expect(body).toEqual({ status: "ok", version: "1.0.0" });
  });
});
