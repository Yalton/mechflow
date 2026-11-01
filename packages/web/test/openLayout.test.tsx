import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { parseModelYaml, type Model } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

function elements(): Model {
  const parsed = parseModelYaml(
    readFileSync(`${process.cwd()}/../../fixtures/examples/elements.yaml`, "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.model;
}

type Point = { x: number; y: number };

function canvasPositions(): Map<string, Point> {
  const store = (globalThis as {
    __rfStore?: { getState: () => { getNodes: () => { id: string; position: Point }[] } };
  }).__rfStore!;
  return new Map(store.getState().getNodes().map((n) => [n.id, n.position]));
}

const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

describe("layout on open", () => {
  it("clusters nodes that share properties when the model has no saved positions", () => {
    render(<GraphView model={elements()} />);
    const at = canvasPositions();
    const fireToWater = distance(at.get("fire")!, at.get("water")!);
    expect(fireToWater).toBeLessThan(distance(at.get("fire")!, at.get("wood")!));
    expect(fireToWater).toBeLessThan(distance(at.get("fire")!, at.get("metal_door")!));
  });

  it("opens a model whose nodes all have positions exactly as saved", () => {
    const model = elements();
    model.nodes.forEach((node, i) => (node.position = { x: i * 100, y: 50 }));
    render(<GraphView model={model} />);
    const at = canvasPositions();
    model.nodes.forEach((node, i) => expect(at.get(node.id)).toEqual({ x: i * 100, y: 50 }));
  });

  it("keeps saved positions and lays out only the nodes without one", () => {
    const model = elements();
    model.nodes.find((n) => n.id === "wood")!.position = { x: 7, y: 9, pinned: true };
    render(<GraphView model={model} />);
    expect(canvasPositions().get("wood")).toEqual({ x: 7, y: 9, pinned: true });
  });

  it("does not move nodes on the canvas when the model is edited", () => {
    const model = elements();
    const { rerender } = render(<GraphView model={model} />);
    const before = canvasPositions();
    rerender(
      <GraphView
        model={{
          ...model,
          nodes: [
            ...model.nodes.map((n) => (n.id === "fire" ? { ...n, name: "Blaze" } : n)),
            { id: "steam", kind: "mechanic", name: "Steam", reads: ["temperature"], writes: [] },
          ],
        }}
      />,
    );
    const after = canvasPositions();
    for (const [id, position] of before) expect(after.get(id)).toEqual(position);
    expect(after.get("steam")).toBeDefined();
  });
});
