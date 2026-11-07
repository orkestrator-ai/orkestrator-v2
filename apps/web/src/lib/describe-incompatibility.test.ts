import { describe, expect, test } from "bun:test";
import {
  incompatibilityIpcMessage,
  toWire,
  unknownCommand,
  unsupportedVersion,
} from "@orkestrator/protocol/contract/errors";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { classifyTransportError } from "./design-client";
import { describeIncompatibility } from "./describe-incompatibility";
import { mediaStreamFailure } from "./chat/media-presentation";
import { GatewayHttpError } from "./native/gateway-http-error";
import { classifyReadError } from "./read-coordinator";

const versioned = unsupportedVersion({ domain: "git", range: { min: 1, max: 2 }, command: "c" });

describe("describeIncompatibility", () => {
  test("names the machine and, when known, its version", () => {
    expect(describeIncompatibility(unknownCommand("get_x"), "Studio")).toBe(
      "Not available on Studio. Update it.",
    );
    expect(describeIncompatibility(versioned, { label: "Studio", version: "2.30.1" })).toBe(
      "Not available on Studio (version 2.30.1). Update it.",
    );
    expect(describeIncompatibility(versioned, { label: " ", version: null })).toBe(
      "Not available on this machine. Update it.",
    );
  });

  test("reads every transport's form", () => {
    const http = new GatewayHttpError(500, "m", toWire(unknownCommand("get_x")));
    // What a desktop renderer receives: only the message crossed the bridge.
    const ipc = new Error(incompatibilityIpcMessage(versioned)!);
    for (const error of [http, ipc]) {
      expect(describeIncompatibility(error, "Studio")).toBe("Not available on Studio. Update it.");
    }
  });

  test("reads a pre-contract machine's text only for the command asked about", () => {
    const legacy = new Error(unknownBackendCommandMessage("get_x"));
    expect(describeIncompatibility(legacy, "Studio", "get_x")).toBe(
      "Not available on Studio. Update it.",
    );
    expect(describeIncompatibility(legacy, "Studio")).toBeNull();
    expect(describeIncompatibility(unknownCommand("get_inner"), "Studio", "get_x")).toBeNull();
  });

  test("leaves other failures to the caller", () => {
    for (const error of [new Error("boom"), new GatewayHttpError(503, "busy"), null, "text"]) {
      expect(describeIncompatibility(error, "Studio", "get_x")).toBeNull();
    }
  });
});

describe("classifiers that do not know the command", () => {
  const coded = new GatewayHttpError(
    500,
    unknownBackendCommandMessage("x"),
    toWire(unknownCommand("x")),
  );
  const legacy = new Error(unknownBackendCommandMessage("x"));

  test("read a coded error and the backend's direct legacy answer as unsupported", () => {
    for (const error of [coded, legacy]) {
      expect(classifyReadError(error)).toBe("unsupported");
      expect(classifyTransportError(error)).toBe("unsupported");
      expect(mediaStreamFailure(error)).toBe("fallback");
    }
  });

  test("leave a wrapped legacy text and other failures alone", () => {
    const wrapped = new Error(`Remote failed: ${unknownBackendCommandMessage("x")}`);
    expect(classifyReadError(wrapped)).toBe("transient");
    expect(classifyReadError(new GatewayHttpError(500, "boom"))).toBe("transient");
    expect(classifyTransportError(new GatewayHttpError(500, "boom"))).toBe("disconnected");
  });
});
