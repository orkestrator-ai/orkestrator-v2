import { expect, mock, test } from "bun:test";
import {
  DOCKER_CONTAINER_STATE_CACHE_MS,
  DockerContainerStateCache,
} from "./docker-container-state-cache.js";

test("container states expire at the cache lifetime boundary", async () => {
  const cache = new DockerContainerStateCache();
  const fetch = mock(async () => new Map());
  const initial = cache.read("owner-a", fetch, 100);
  expect(cache.read("owner-a", fetch, 100 + DOCKER_CONTAINER_STATE_CACHE_MS - 1)).toBe(initial);
  const refreshed = cache.read("owner-a", fetch, 100 + DOCKER_CONTAINER_STATE_CACHE_MS);
  expect(refreshed).not.toBe(initial);
  expect(cache.read("owner-a", fetch, 101 + DOCKER_CONTAINER_STATE_CACHE_MS)).toBe(refreshed);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await refreshed).not.toBe(await initial);
});

test("a different ownership scope replaces even an in-flight cached snapshot", async () => {
  const cache = new DockerContainerStateCache();
  let finish!: (states: Map<string, "running">) => void;
  const first = cache.read("owner-a", () => new Promise((resolve) => (finish = resolve)), 0);
  const fetch = mock(async () => new Map<string, "stopped">([["b", "stopped"]]));
  const second = cache.read("owner-b", fetch, 1);
  expect(second).not.toBe(first);
  expect(cache.read("owner-b", fetch, 2)).toBe(second);
  finish(new Map([["a", "running"]]));
  await first;
  // Resolving the old owner's request cannot overwrite the replacement.
  expect(cache.read("owner-b", fetch, 3)).toBe(second);
  const third = cache.read("owner-a", fetch, 4);
  expect(third).not.toBe(first);
  expect(third).not.toBe(second);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await second).toEqual(new Map([["b", "stopped"]]));
});
