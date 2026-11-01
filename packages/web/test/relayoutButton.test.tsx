import { describe, expect, it, vi } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import type { Model } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";
import * as layout from "../src/layout/forceLayout.js";
import { useEditorStore } from "../src/state/editor.js";

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

/** A small model with two mechanics sharing a property (so ghost edges exist). */
const model: Model = {
  version: 1,
  name: "Relayout",
  properties: [{ id: "temperature", kind: "number" }],
  subsystems: [{ id: "core", name: "Core", tier: "core" }],
  nodes: [
    { id: "fire", kind: "mechanic", name: "Fire", subsystem: "core", reads: [], writes: ["temperature"] },
    { id: "water", kind: "mechanic", name: "Water", subsystem: "core", reads: ["temperature"], writes: [] },
  ],
  edges: [],
  noInteraction: [],
  invariants: [],
};

describe("RelayoutButton", () => {
  it("renders a Re-layout button in the graph", () => {
    render(<GraphView model={model} />);
    // getByTestId throws when absent, so this asserts the button is present.
    expect(screen.getByTestId("relayout")).toBeDefined();
  });

  it("drives runLayout on click without mutating the model object", () => {
    const spy = vi.spyOn(layout, "runLayout");
    render(<GraphView model={model} />);
    // Opening a model without saved positions lays it out once already.
    spy.mockClear();
    fireEvent.click(screen.getByTestId("relayout"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(model.nodes.every((n) => n.position === undefined)).toBe(true);
  });

  it("writes the new positions into the editor model as one undoable edit", () => {
    useEditorStore.getState().load("relayout.yaml", model, "hash");
    function EditorGraph() {
      const open = useEditorStore((s) => s.model);
      return <GraphView model={open} />;
    }
    render(<EditorGraph />);
    const flowStore = (globalThis as {
      __rfStore?: { getState: () => { getNodes: () => { id: string; position: { x: number; y: number } }[] } };
    }).__rfStore;
    act(() => fireEvent.click(screen.getByTestId("relayout")));
    const state = useEditorStore.getState();
    expect(state.dirty).toBe(true);
    expect(state.undoStack).toHaveLength(1);
    const canvas = new Map(flowStore!.getState().getNodes().map((n) => [n.id, n.position]));
    for (const node of state.model!.nodes) {
      expect(node.position).toEqual(canvas.get(node.id));
      expect(node.position?.pinned).toBeUndefined();
    }
    // A second Re-layout lands on the same positions, so it adds no edit.
    act(() => fireEvent.click(screen.getByTestId("relayout")));
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    act(() => useEditorStore.getState().undo());
    expect(useEditorStore.getState().model!.nodes.every((n) => n.position === undefined)).toBe(true);
  });

  it("keeps dragged nodes where they are and re-places nodes an earlier layout placed", () => {
    const placed: Model = {
      ...model,
      nodes: [
        { ...model.nodes[0]!, position: { x: 500, y: 500, pinned: true } },
        { ...model.nodes[1]!, position: { x: 9999, y: 9999 } },
      ],
    } as Model;
    useEditorStore.getState().load("relayout.yaml", placed, "hash");
    function EditorGraph() {
      const open = useEditorStore((s) => s.model);
      return <GraphView model={open} />;
    }
    render(<EditorGraph />);
    act(() => fireEvent.click(screen.getByTestId("relayout")));
    const [fire, water] = useEditorStore.getState().model!.nodes;
    expect(fire!.position).toEqual({ x: 500, y: 500, pinned: true });
    expect(water!.position).not.toEqual({ x: 9999, y: 9999 });
    expect(Math.hypot(water!.position!.x - 500, water!.position!.y - 500)).toBeLessThan(1000);
  });

  it("keeps layout positions when selection re-renders the parent", async () => {
    function ReRenderingGraph() {
      const [selected, setSelected] = useState("");
      const [graph, setGraph] = useState(model);
      return <>
        <GraphView model={graph} onSelectionChange={(value) => setSelected(value.nodeId ?? "")} />
        <span data-testid="selection">{selected}</span>
        <button data-testid="select-for-test" onClick={() => setSelected("fire")}>Select</button>
        <button data-testid="edit-for-test" onClick={() => setGraph({
          ...graph,
          nodes: graph.nodes.map((node) => node.id === "fire" ? { ...node, name: "New fire" } : node),
        })}>Edit</button>
      </>;
    }
    render(<ReRenderingGraph />);
    const flowStore = (globalThis as {
      __rfStore?: { getState: () => {
        addSelectedNodes: (ids: string[]) => void;
        getNodes: () => { id: string; position: { x: number; y: number } }[];
      } };
    }).__rfStore;
    fireEvent.click(screen.getByTestId("relayout"));
    const positions = flowStore?.getState().getNodes().map((node) => ({ ...node.position }));
    const laidOut = layout.runLayout(model);
    expect(positions).toEqual(model.nodes.map((node) => laidOut.get(node.id)));
    await act(async () => flowStore?.getState().addSelectedNodes(["fire"]));
    fireEvent.click(screen.getByTestId("select-for-test"));
    expect(screen.getByTestId("selection").textContent).toBe("fire");
    fireEvent.click(screen.getByTestId("edit-for-test"));
    expect(flowStore?.getState().getNodes().map((node) => node.position)).toEqual(positions);
  });

  it("clears temporary finding dimming after re-layout", () => {
    const { rerender } = render(<GraphView model={model} highlightedNodeIds={new Set(["fire"])} />);
    expect(screen.getByTestId("rf__node-water").className).toContain("mechflow-dim");
    const flowStore = (globalThis as {
      __rfStore?: { getState: () => { getNodes: () => { position: { x: number; y: number } }[] } };
    }).__rfStore;
    fireEvent.click(screen.getByTestId("relayout"));
    const positions = flowStore?.getState().getNodes().map((node) => node.position);
    rerender(<GraphView model={model} highlightedNodeIds={new Set()} />);
    expect(screen.getByTestId("rf__node-water").className).not.toContain("mechflow-dim");
    expect(flowStore?.getState().getNodes().map((node) => node.position)).toEqual(positions);
  });
});
