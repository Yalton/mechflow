import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Model, TraceResult } from "@mechflow/core";
import { traceEffects } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";
import { useEditorStore } from "../src/state/editor.js";
import { applyTrace } from "../src/graph/traceLayer.js";

/**
 * jsdom has no `ResizeObserver`, but React Flow mounts one on init. Provide a
 * no-op polyfill so the graph can render in the jsdom test environment.
 */
class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??=
  ResizeObserverPolyfill;

/** The React Flow store captured by {@link InstanceRef} and exposed on
 * `globalThis`. Read directly so the trace test locates the selected node the
 * way React Flow itself does. */
type RFStoreLike = {
  getState(): {
    addSelectedNodes?: (ids: string[]) => void;
    getNodes?: () => Array<{
      id: string;
      className?: string;
      data?: { traceDepth?: number; tracePolarity?: "+" | "-" };
    }>;
  };
};

/**
 * A chain of mechanics: m1 writes p1, m2 reads p1 and writes p2, m3 reads p2
 * and writes p3, m4 reads p3. Flow edges connect the chain. Tracing m1 reaches
 * m2 (depth 1), m3 (depth 2), m4 (depth 3).
 */
function traceModel(): Model {
  return {
    version: 1,
    name: "Trace",
    properties: [],
    subsystems: [],
    nodes: [
      { id: "m1", kind: "mechanic", name: "M1", reads: [], writes: ["p1"] },
      { id: "m2", kind: "mechanic", name: "M2", reads: ["p1"], writes: ["p2"] },
      { id: "m3", kind: "mechanic", name: "M3", reads: ["p2"], writes: ["p3"] },
      { id: "m4", kind: "mechanic", name: "M4", reads: ["p3"], writes: [] },
    ],
    edges: [
      { id: "e1", kind: "flow", from: "m1", to: "m2", rate: "1" },
      { id: "e2", kind: "flow", from: "m2", to: "m3", rate: "1" },
      { id: "e3", kind: "flow", from: "m3", to: "m4", rate: "1" },
    ],
    noInteraction: [],
    invariants: [],
  };
}

function load(model: Model = traceModel()): void {
  useEditorStore.getState().load("trace.yaml", model, "hash-1");
}

describe("traceEffects computation", () => {
  it("records reached nodes once, at shallowest depth, by order", () => {
    const result: TraceResult = traceEffects(traceModel(), "m1");

    expect(result.levels[0].nodes[0]).toMatchObject({
      id: "m1",
      via: null,
      polarity: "+",
    });
    expect(result.levels[1].nodes[0].id).toBe("m2");
    expect(result.levels[2].nodes[0].id).toBe("m3");
    expect(result.levels[3].nodes[0].id).toBe("m4");
  });
});

describe("GraphView effect trace", () => {
  afterEach(() => {
    useEditorStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("marks reached nodes by depth and polarity when applied", () => {
    const result = traceEffects(traceModel(), "m1");
    const graph = {
      nodes: traceModel().nodes.map((node) => ({
        id: node.id,
        type: node.kind,
        data: { node },
      })),
      edges: traceModel().edges.map((edge) => ({
        id: edge.id,
        type: "mechflow-edge",
        data: { edge },
      })),
    };
    const traced = applyTrace(graph, result);

    const m2 = traced.nodes.find((node) => node.id === "m2")!;
    expect(m2.className).toBe("trace-depth-1");
    expect(m2.data?.traceDepth).toBe(1);
    expect(m2.data?.tracePolarity).toBe("+");

    const m3 = traced.nodes.find((node) => node.id === "m3")!;
    expect(m3.className).toBe("trace-depth-2");
    expect(m3.data?.traceDepth).toBe(2);

    const m4 = traced.nodes.find((node) => node.id === "m4")!;
    expect(m4.className).toBe("trace-depth-3");
  });

  it("applies the trace to the graph on Trace and clears on Esc", async () => {
    load();
    render(<GraphView model={useEditorStore.getState().model} />);

    // Establish selection of m1, as a click does through the React Flow store.
    const store = (globalThis as { __rfStore?: RFStoreLike }).__rfStore;
    await act(async () => {
      store!.getState().addSelectedNodes(["m1"]);
    });

    // Click Trace. `setTrace` is a React state update, so it is wrapped in act.
    await act(async () => {
      fireEvent.click(await screen.findByTestId("trace"));
    });

    // The overlay marks reached nodes by depth and polarity.
    const m2 = store!.getState().getNodes()?.find((node) => node.id === "m2");
    expect(m2?.className).toBe("trace-depth-1");
    expect(m2?.data?.traceDepth).toBe(1);

    const m3 = store!.getState().getNodes()?.find((node) => node.id === "m3");
    expect(m3?.className).toBe("trace-depth-2");

    const m4 = store!.getState().getNodes()?.find((node) => node.id === "m4");
    expect(m4?.className).toBe("trace-depth-3");

    // Press Esc. `setTrace` updates state, so wrap the keydown in act.
    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });

    // Trace cleared: m2 no longer carries a depth class.
    const m2After = store
      ?.getState()
      .getNodes()?.find((node) => node.id === "m2");
    expect(m2After?.className).toBeUndefined();
  });
});
