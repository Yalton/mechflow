import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Model } from "@mechflow/core";
import { chainColour, findChains } from "../src/graph/chains.js";
import { GraphView } from "../src/graph/GraphView.js";

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

// Two chains joined by a converter: ore (mine -> ore) and bars (bars -> shop).
const model: Model = {
  version: 1,
  name: "Chains",
  properties: [],
  subsystems: [],
  nodes: [
    { id: "mine", kind: "source", name: "Mine" },
    { id: "ore", kind: "pool", name: "Ore", start: 0 },
    { id: "forge", kind: "converter", name: "Forge", inputs: [{ resource: "ore", amount: 2 }], outputs: [{ resource: "bars", amount: 1 }] },
    { id: "bars", kind: "pool", name: "Bars", start: 0 },
    { id: "shop", kind: "drain", name: "Shop" },
    { id: "lonely", kind: "pool", name: "Lonely", start: 0 },
  ] as Model["nodes"],
  edges: [
    { id: "dig", kind: "flow", from: "mine", to: "ore" },
    { id: "feed", kind: "flow", from: "ore", to: "forge" },
    { id: "make", kind: "flow", from: "forge", to: "bars" },
    { id: "sell", kind: "flow", from: "bars", to: "shop" },
  ],
  noInteraction: [],
  invariants: [],
};

afterEach(cleanup);

describe("findChains", () => {
  it("splits chains at converters and numbers them by smallest node id", () => {
    const chains = findChains(model);
    // "bars" < "mine", so the bars chain is 0.
    expect(Object.fromEntries(chains.nodes)).toEqual({ mine: 1, ore: 1, bars: 0, shop: 0 });
    expect(Object.fromEntries(chains.edges)).toEqual({ dig: 1, feed: 1, make: 0, sell: 0 });
  });

  it("cycles through the palette", () => {
    expect(chainColour(0)).toBe("var(--chain-1)");
    expect(chainColour(6)).toBe("var(--chain-1)");
  });
});

describe("chain colours on the canvas", () => {
  it("colours symbols by chain, and by subsystem when toggled off", () => {
    render(<GraphView model={model} />);
    const ore = () => screen.getAllByTestId("flow-node-pool").find((n) => n.textContent?.includes("Ore"))!;
    expect(ore().dataset.chain).toBe("var(--chain-2)");
    fireEvent.click(screen.getByTestId("view-menu"));
    fireEvent.click(screen.getByTestId("chain-colours-toggle"));
    expect(ore().dataset.chain).toBeUndefined();
  });
});
