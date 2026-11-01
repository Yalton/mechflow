import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { parseModelYaml, type Model } from "@mechflow/core";
import { ReactFlowProvider, type EdgeProps } from "reactflow";
import { GraphView } from "../src/graph/GraphView.js";
import { WaveEdge, type WaveEdgeData } from "../src/graph/edges/WaveEdge.js";
import { describeWave, firstWave, nextWave } from "../src/graph/mechanicRun.js";

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

afterEach(cleanup);

const parsed = parseModelYaml(readFileSync(`${process.cwd()}/../../fixtures/examples/elements.yaml`, "utf8"));
if (!parsed.ok) throw new Error("elements.yaml does not parse");
const elements: Model = parsed.model;

describe("mechanic run waves", () => {
  it("starts from the mechanics that read nothing and follows the properties they write", () => {
    const first = firstWave(elements)!;
    expect(first.fired).toEqual(["fire"]);
    expect(first.links).toEqual([
      { from: "fire", to: "ice", properties: ["temperature"] },
      { from: "fire", to: "water", properties: ["temperature"] },
    ]);
    const second = nextWave(elements, first);
    expect(second.fired).toEqual(["ice", "water"]);
    // Water writes temperature too, but does not set itself off.
    expect(second.links).toEqual([
      { from: "water", to: "electricity", properties: ["wetness"] },
      { from: "water", to: "ice", properties: ["temperature"] },
    ]);
    const third = nextWave(elements, second);
    expect(third.fired).toEqual(["electricity", "ice"]);
    const fourth = nextWave(elements, third);
    expect(fourth.fired).toEqual([]);
    expect(describeWave(elements, fourth)).toBe("Step 4: settled");
  });

  it("fires every mechanic first when each one reads something", () => {
    const loop: Model = {
      ...elements,
      nodes: [
        { id: "a", kind: "mechanic", name: "A", reads: ["x"], writes: ["y"] },
        { id: "b", kind: "mechanic", name: "B", reads: ["y"], writes: ["x"] },
      ],
      edges: [],
      noInteraction: [],
    };
    const first = firstWave(loop)!;
    expect(first.fired).toEqual(["a", "b"]);
    // A loop keeps going rather than settling.
    expect(nextWave(loop, nextWave(loop, first)).fired).toEqual(["a", "b"]);
  });
});

describe("mechanic run controls", () => {
  it("steps a mechanics-only map, lighting up the mechanics that fire", () => {
    render(<GraphView model={elements} />);
    expect(screen.queryByTestId("run-controls")).toBeNull();
    expect(screen.getByTestId("wave-label").textContent).toBe("Not started");
    fireEvent.click(screen.getByTestId("wave-step"));
    expect(screen.getByTestId("wave-label").textContent).toBe("Step 1: Fire");
    const firing = () => screen.getAllByTestId("flow-node-mechanic")
      .filter((n) => n.dataset.firing === "true").map((n) => n.textContent?.split("reads")[0]);
    expect(firing()).toEqual(["Fire"]);
    fireEvent.click(screen.getByTestId("wave-step"));
    expect(screen.getByTestId("wave-label").textContent).toBe("Step 2: Ice, Water");
    expect(firing().sort()).toEqual(["Ice", "Water"]);
    fireEvent.click(screen.getByTestId("wave-reset"));
    expect(screen.getByTestId("wave-label").textContent).toBe("Not started");
    expect(firing()).toEqual([]);
  });
});

describe("wave edge", () => {
  it("names the properties carried and sends tokens along the link", () => {
    const props = {
      id: "wave:water->electricity", source: "water", target: "electricity",
      sourceX: 0, sourceY: 0, targetX: 200, targetY: 0,
      data: { properties: ["wetness"], step: 2 },
    } as unknown as EdgeProps<WaveEdgeData>;
    const { container } = render(<ReactFlowProvider><WaveEdge {...props} /></ReactFlowProvider>);
    expect(container.querySelector('[data-testid="wave-badge"]')?.textContent).toBe("wetness");
    expect(container.querySelectorAll('[data-testid="wave-tokens"] circle').length).toBe(3);
  });
});
