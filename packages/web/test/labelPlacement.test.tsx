import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { getSmoothStepPath, Position, ReactFlowProvider, useStoreApi, type EdgeProps } from "reactflow";
import { FlowEdge } from "../src/graph/edges/FlowEdge.js";
import type { FlowEdgeData } from "../src/graph/toFlow.js";
import { CARD_SIZE } from "../src/layout/forceLayout.js";
import { pathPoints, placeLabel, pointAlong } from "../src/graph/edges/labelPlacement.js";

const label = { width: 60, height: 18 };

describe("label placement", () => {
  it("reads the corner points of a smooth-step path", () => {
    const [d] = getSmoothStepPath({
      sourceX: 0,
      sourceY: 0,
      sourcePosition: Position.Right,
      targetX: 200,
      targetY: 100,
      targetPosition: Position.Left,
    });
    const points = pathPoints(d);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 200, y: 100 });
    expect(pointAlong([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 0.75)).toEqual({ x: 100, y: 50 });
  });

  it("keeps the midpoint when it is clear", () => {
    const d = "M0 0L400 0";
    expect(placeLabel(d, label, [{ x: 0, y: 100, width: 50, height: 50 }], { x: 200, y: 0 })).toEqual({ x: 200, y: 0 });
  });

  it("moves the label along the path off a card that covers the midpoint", () => {
    const d = "M0 0L400 0";
    const card = { x: 150, y: -40, width: 100, height: 80 };
    const spot = placeLabel(d, label, [card], { x: 200, y: 0 });
    expect(spot.y).toBe(0);
    expect(spot.x + label.width / 2 <= card.x || spot.x - label.width / 2 >= card.x + card.width).toBe(true);
  });

  it("keeps the midpoint when the whole path is covered evenly", () => {
    const d = "M0 0L100 0";
    expect(placeLabel(d, label, [{ x: -50, y: -50, width: 300, height: 100 }], { x: 50, y: 0 })).toEqual({ x: 50, y: 0 });
  });

  it("takes the spot covering the least card when none is clear", () => {
    // Two cards with a gap narrower than the label: the label spans the gap.
    const d = "M0 0L200 0";
    const cards = [
      { x: -100, y: -20, width: 180, height: 40 },
      { x: 120, y: -20, width: 180, height: 40 },
    ];
    const { x } = placeLabel(d, label, cards, { x: 40, y: 0 });
    expect(x - label.width / 2).toBeLessThanOrEqual(84);
    expect(x + label.width / 2).toBeGreaterThanOrEqual(116);
  });

  it("draws a label clear of a card the edge runs behind", () => {
    // The flow from a to c passes straight behind b, which sits on its midpoint.
    const nodes = [
      { id: "a", type: "source", position: { x: 0, y: 0 }, data: {} },
      { id: "b", type: "pool", position: { x: 252, y: -48 }, data: {} },
      { id: "c", type: "drain", position: { x: 600, y: 0 }, data: {} },
    ];
    function Cards(): null {
      const store = useStoreApi();
      useLayoutEffect(() => store.getState().setNodes(nodes), [store]);
      return null;
    }
    const { container } = render(
      <ReactFlowProvider>
        <Cards />
        <FlowEdge
          {...({
            id: "ac",
            source: "a",
            target: "c",
            sourceX: 92,
            sourceY: 0,
            targetX: 600,
            targetY: 0,
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
            label: "wages",
            data: { kind: "flow" },
          } as unknown as EdgeProps<FlowEdgeData>)}
        />
      </ReactFlowProvider>,
    );
    const g = container.querySelector('[data-edge-id="ac"] ~ g');
    const [x, y] = (g?.getAttribute("transform") ?? "").match(/-?\d*\.?\d+/g)!.map(Number) as [
      number,
      number,
    ];
    const width = "wages".length * 7 + 10;
    const b = { x: 252, y: -48, ...CARD_SIZE.pool };
    expect(x).not.toBe(346);
    const clear =
      x + width / 2 <= b.x || x - width / 2 >= b.x + b.width || y + 9 <= b.y || y - 9 >= b.y + b.height;
    expect(clear).toBe(true);
  });
});
