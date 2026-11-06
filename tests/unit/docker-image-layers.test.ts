import { describe, expect, test } from "bun:test";
import { changedLayers, pairLayers, parseDuKib } from "../../scripts/docker-image-layers";

describe("docker-image-layers", () => {
  // `docker history` lists newest first; metadata rows have no size.
  const history = [
    { size: 0, createdBy: "ENV A=1" },
    { size: 300, createdBy: "COPY bundle" },
    { size: 0, createdBy: "ARG B" },
    { size: 2000, createdBy: "RUN npm install -g x" },
    { size: 100, createdBy: "debian.sh" },
  ];

  test("pairs layers oldest first and skips rows that made no layer", () => {
    expect(pairLayers(["sha256:base", "sha256:npm", "sha256:bundle"], history)).toEqual([
      { diffId: "sha256:base", size: 100, createdBy: "debian.sh" },
      { diffId: "sha256:npm", size: 2000, createdBy: "RUN npm install -g x" },
      { diffId: "sha256:bundle", size: 300, createdBy: "COPY bundle" },
    ]);
  });

  test("refuses to guess when the counts disagree", () => {
    expect(() => pairLayers(["sha256:base", "sha256:npm"], history)).toThrow(/cannot pair/);
  });

  test("counts only the probe's layers the base does not hold", () => {
    const base = pairLayers(["sha256:base", "sha256:npm", "sha256:bundle"], history);
    const probe = [
      base[0]!,
      base[1]!,
      { diffId: "sha256:bundle-probed", size: 310, createdBy: "COPY bundle" },
    ];
    expect(changedLayers(base, probe)).toEqual({
      layers: [probe[2]!],
      bytes: 310,
      total: 3,
    });
  });

  test("reads du's KiB and treats missing output as unknown", () => {
    expect(parseDuKib("349184\t/home/node/.npm\n")).toBe(349184 * 1024);
    expect(parseDuKib("")).toBeNull();
  });
});
