import { afterEach, describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_CONFLICT,
} from "@orkestrator/protocol/web-annotations";
import { isWebAnnotationId } from "@orkestrator/protocol/web-annotations-validation";
import { fixtureCapabilities, invokeMock } from "@/test/web-annotation-fakes";
import {
  captureOperationIds,
  classifyWebAnnotationError,
  describeWebAnnotationError,
  fetchWebAnnotationCapabilities,
  newWebAnnotationOperationId,
  webAnnotationCommand,
  webAnnotationFeatures,
} from "./client";

afterEach(() => {
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("web annotation client", () => {
  test("invokes the named command with its exact arguments", async () => {
    invokeMock.mockImplementation(async () => ({ receipt: null }));
    await webAnnotationCommand("web_annotation_operation_receipt", {
      environmentId: "env-1",
      operationId: "op-1",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("web_annotation_operation_receipt", {
      environmentId: "env-1",
      operationId: "op-1",
    });
  });

  test("classifies the contract's error prefixes", () => {
    expect(classifyWebAnnotationError(new Error(`${WEB_ANNOTATION_CONFLICT} stale`))).toBe(
      "conflict",
    );
    expect(classifyWebAnnotationError(`${WEB_ANNOTATION_CAPACITY} images`)).toBe("capacity");
    expect(classifyWebAnnotationError(new Error("Unknown backend command: x"))).toBe("unsupported");
    expect(classifyWebAnnotationError(new Error("socket hang up"))).toBe("other");
    expect(describeWebAnnotationError(new Error(`${WEB_ANNOTATION_CAPACITY} 512 MiB used`))).toBe(
      "Capacity reached: 512 MiB used",
    );
  });

  test("derives stable, valid operation ids from a capture id", () => {
    const first = captureOperationIds("capture 1/with:odd chars");
    const second = captureOperationIds("capture 1/with:odd chars");
    expect(first).toEqual(second);
    for (const id of Object.values(first)) expect(isWebAnnotationId(id)).toBe(true);
    expect(new Set(Object.values(first)).size).toBe(5);
    expect(isWebAnnotationId(newWebAnnotationOperationId("req"))).toBe(true);
    expect(newWebAnnotationOperationId()).not.toBe(newWebAnnotationOperationId());
  });

  test("treats an unknown command or malformed payload as unavailable, not an error", async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error("Unknown backend command: web_annotations_capabilities");
    });
    expect((await fetchWebAnnotationCapabilities("env-1")).status).toBe("unavailable");
    invokeMock.mockImplementation(async () => undefined);
    expect((await fetchWebAnnotationCapabilities("env-1")).status).toBe("unavailable");
    invokeMock.mockImplementation(async () => ({ ...fixtureCapabilities(), contractVersion: 2 }));
    expect((await fetchWebAnnotationCapabilities("env-1")).status).toBe("unavailable");
    invokeMock.mockImplementation(async () => {
      throw new Error("Gateway disconnected");
    });
    expect(await fetchWebAnnotationCapabilities("env-1")).toEqual({
      status: "error",
      error: "Gateway disconnected",
    });
    invokeMock.mockImplementation(async () => fixtureCapabilities());
    expect((await fetchWebAnnotationCapabilities("env-1")).status).toBe("available");
  });

  test("enables capture only when backend and desktop agree", () => {
    const capabilities = fixtureCapabilities();
    expect(webAnnotationFeatures(capabilities, false).capture).toBe(false);
    expect(webAnnotationFeatures(capabilities, true).capture).toBe(true);
    const degraded = { ...capabilities, storage: "degraded" as const };
    expect(webAnnotationFeatures(degraded, true)).toMatchObject({
      read: true,
      author: false,
      capture: false,
      dispatch: false,
    });
    expect(
      webAnnotationFeatures(fixtureCapabilities({ batch: false }), true).maxRequestAnnotations,
    ).toBe(1);
  });
});
