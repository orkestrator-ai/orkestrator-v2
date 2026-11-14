import { afterEach, expect, test } from "bun:test";
import {
  ANTHROPIC_REFUSAL,
  OPENAI_REFUSAL,
  refusalFor,
  serveRefusedLoginModel,
  type RefusedLoginModel,
} from "./refused-login-model";

// The test preload replaces the global with happy-dom's, which applies a page's
// same-origin policy to these loopback requests.
const fetch = Bun.fetch;

let model: RefusedLoginModel | undefined;
afterEach(() => {
  model?.stop();
  model = undefined;
});

test("answers each provider's own refusal shape", () => {
  expect(refusalFor("/v1/messages")).toBe(ANTHROPIC_REFUSAL);
  expect(refusalFor("/v1/messages/count_tokens")).toBe(ANTHROPIC_REFUSAL);
  expect(refusalFor("/v1/chat/completions")).toBe(OPENAI_REFUSAL);
  expect(refusalFor("/responses")).toBe(OPENAI_REFUSAL);
  expect(refusalFor("/v1/models")).toBe(OPENAI_REFUSAL);
});

test("refuses every model request with a 401 and counts it", async () => {
  model = await serveRefusedLoginModel();
  const messages = await fetch(`${model.origin}/v1/messages`, { method: "POST", body: "{}" });
  expect(messages.status).toBe(401);
  expect(await messages.json()).toEqual(ANTHROPIC_REFUSAL);
  const chat = await fetch(`${model.origin}/v1/chat/completions`, { method: "POST", body: "{}" });
  expect(chat.status).toBe(401);
  expect(await chat.json()).toEqual(OPENAI_REFUSAL);
  expect(model.stats()).toEqual({ requests: 2, held: 0 });
});

test("refuses a WebSocket upgrade instead of accepting it", async () => {
  model = await serveRefusedLoginModel();
  const response = await fetch(`${model.origin}/v1/responses`, {
    headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13" },
  });
  expect(response.status).toBe(401);
});

test("holds a WebSocket upgrade like any model request", async () => {
  model = await serveRefusedLoginModel();
  model.setHold(true);
  let settled = false;
  const pending = fetch(`${model.origin}/v1/responses`, {
    headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13" },
  }).then((response) => {
    settled = true;
    return response.status;
  });
  for (let i = 0; i < 100 && model.stats().held === 0; i += 1) await Bun.sleep(10);
  expect(model.stats()).toEqual({ requests: 1, held: 1 });
  expect(settled).toBe(false);
  model.setHold(false);
  expect(await pending).toBe(401);
  expect(model.stats().held).toBe(0);
});

test("holds requests until released, through the control route too", async () => {
  model = await serveRefusedLoginModel();
  const hold = await fetch(`${model.origin}/__qa/hold`, {
    method: "POST",
    body: JSON.stringify({ hold: true }),
  });
  expect(await hold.json()).toEqual({ hold: true, held: 0 });
  let settled = false;
  const pending = fetch(`${model.origin}/v1/messages`, { method: "POST", body: "{}" }).then(
    (response) => {
      settled = true;
      return response.status;
    },
  );
  for (let i = 0; i < 100 && model.stats().held === 0; i += 1) await Bun.sleep(10);
  expect(model.stats().held).toBe(1);
  expect(settled).toBe(false);
  const stats = await fetch(`${model.origin}/__qa/stats`);
  expect(await stats.json()).toEqual({ requests: 1, held: 1 });
  await fetch(`${model.origin}/__qa/hold`, {
    method: "POST",
    body: JSON.stringify({ hold: false }),
  });
  expect(await pending).toBe(401);
  expect(model.stats().held).toBe(0);
});

test("a held request whose client goes away stops being held", async () => {
  model = await serveRefusedLoginModel();
  model.setHold(true);
  const controller = new AbortController();
  const pending = fetch(`${model.origin}/v1/chat/completions`, {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  }).catch(() => "aborted");
  for (let i = 0; i < 100 && model.stats().held === 0; i += 1) await Bun.sleep(10);
  controller.abort();
  expect(await pending).toBe("aborted");
  for (let i = 0; i < 100 && model.stats().held > 0; i += 1) await Bun.sleep(10);
  expect(model.stats().held).toBe(0);
});
