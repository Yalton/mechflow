import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Model } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";

/** jsdom has no `ResizeObserver`, which React Flow mounts on init. */
class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

/** One mechanic writing a declared property. */
const model: Model = {
  version: 1,
  name: "Property layer",
  properties: [{ id: "temperature", kind: "number" }],
  subsystems: [{ id: "core", name: "Core", tier: "core" }],
  nodes: [
    {
      id: "fire",
      kind: "mechanic",
      name: "Fire",
      subsystem: "core",
      reads: [],
      writes: ["temperature"],
    },
  ],
  edges: [],
  noInteraction: [],
  invariants: [],
};

describe("property layer", () => {
  // React Flow drops any edge whose target node has no handle, so the
  // node-to-hub links only render if the hub has a target handle. jsdom never
  // lays out edges, so this checks the handle the links attach to.
  it("gives each property hub a target handle that users cannot drag from", async () => {
    render(<GraphView model={model} />);
    fireEvent.click(screen.getByTestId("property-layer-toggle"));
    const hub = await screen.findByTestId("property-node");
    const node = hub.closest(".react-flow__node");
    const handle = node?.querySelector(".react-flow__handle.target");
    expect(handle).not.toBeNull();
    expect(handle?.classList.contains("connectable")).toBe(false);
  });

  it("places each hub near the nodes it links to, at their canvas positions", async () => {
    const placed: Model = {
      ...model,
      nodes: [
        {
          id: "fire",
          kind: "mechanic",
          name: "Fire",
          subsystem: "core",
          reads: [],
          writes: ["temperature"],
          position: { x: 2000, y: 1000 },
        },
        {
          id: "stove",
          kind: "entity",
          name: "Stove",
          subsystem: "core",
          has: ["temperature"],
          position: { x: 2200, y: 1000 },
        },
      ],
    };
    render(<GraphView model={placed} />);
    fireEvent.click(screen.getByTestId("property-layer-toggle"));
    const hub = await screen.findByTestId("property-node");
    const transform = (hub.closest(".react-flow__node") as HTMLElement).style.transform;
    const [, x, y] = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(transform) ?? [];
    // Centroid (2100, 1000) plus at most the 48px radial spread.
    expect(Math.abs(Number(x) - 2100)).toBeLessThanOrEqual(48);
    expect(Math.abs(Number(y) - 1000)).toBeLessThanOrEqual(48);
  });
});
