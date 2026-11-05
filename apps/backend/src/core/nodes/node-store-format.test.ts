import { expect, test } from "bun:test";
import { readStoredNodeRegistry } from "./node-store-format.js";

test("destructive absence checks refuse partial or unsupported registry views", () => {
  for (const value of [
    { version: 2, nodes: [] },
    { version: 1, nodes: [{}] },
    { version: 1 },
    { version: 1, nodes: [], pendingHandover: {} },
  ]) {
    expect(() => readStoredNodeRegistry(value, true)).toThrow();
    expect(() => readStoredNodeRegistry(value)).not.toThrow();
  }
  expect(readStoredNodeRegistry({ version: 1, nodes: [] }, true).registry.nodes).toEqual([]);
});
