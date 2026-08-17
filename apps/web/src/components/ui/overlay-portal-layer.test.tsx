import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import { OverlayPortalLayer, useOverlayPortalLayer } from "./overlay-portal-layer";

afterEach(cleanup);

function LayerProbe({ label }: { label: string }) {
  const layer = useOverlayPortalLayer();
  return <div>{`${label}:${layer ?? "none"}`}</div>;
}

describe("OverlayPortalLayer", () => {
  test("starts unset and nests later layers over earlier ones", () => {
    render(
      <div>
        <LayerProbe label="outside" />
        <OverlayPortalLayer className="z-[70]">
          <LayerProbe label="raised" />
          <OverlayPortalLayer className="z-[90]">
            <LayerProbe label="nested" />
          </OverlayPortalLayer>
        </OverlayPortalLayer>
      </div>,
    );

    expect(screen.getByText("outside:none")).toBeTruthy();
    expect(screen.getByText("raised:z-[70]")).toBeTruthy();
    expect(screen.getByText("nested:z-[90]")).toBeTruthy();
  });
});
