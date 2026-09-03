import { describe, expect, mock, test } from "bun:test";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { publishConnections, subscribeToConnections } from "./connections";

const list: ConnectionList = {
  activeConnectionId: "local",
  credentialStorage: "secure",
  connections: [],
};

describe("connection snapshots", () => {
  test("publishes snapshots and removes subscribers", () => {
    const subscriber = mock((_list: ConnectionList) => undefined);
    const unsubscribe = subscribeToConnections(subscriber);

    publishConnections(list);
    expect(subscriber).toHaveBeenCalledWith(list);

    unsubscribe();
    publishConnections({ ...list, activeConnectionId: "remote-1" });
    expect(subscriber).toHaveBeenCalledTimes(1);
  });
});
