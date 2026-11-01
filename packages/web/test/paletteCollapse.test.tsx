import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Model } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";
import { useEditorStore } from "../src/state/editor.js";

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

const empty: Model = {
  version: 1,
  name: "Empty",
  properties: [],
  subsystems: [],
  nodes: [],
  edges: [],
  noInteraction: [],
  invariants: [],
};
const full: Model = { ...empty, name: "Full", nodes: [{ id: "a", kind: "pool", name: "A", start: 0 }] };

function EditorGraph(): JSX.Element {
  const model = useEditorStore((s) => s.model);
  return <GraphView model={model} />;
}

afterEach(cleanup);

describe("node palette", () => {
  it("starts collapsed over a model with nodes and expands on demand", () => {
    useEditorStore.getState().load("full.yaml", full, "h");
    render(<EditorGraph />);
    expect(screen.getByTestId("palette").dataset.collapsed).toBe("true");
    expect(screen.queryByTestId("palette-item-pool")).toBeNull();
    fireEvent.click(screen.getByTestId("palette-toggle"));
    expect(screen.getByTestId("palette-item-pool")).toBeTruthy();
    fireEvent.click(screen.getByTestId("palette-toggle"));
    expect(screen.queryByTestId("palette-item-pool")).toBeNull();
  });

  it("starts open on an empty model and stays open once the first node is added", () => {
    useEditorStore.getState().load("empty.yaml", empty, "h");
    render(<EditorGraph />);
    expect(screen.getByTestId("palette-item-pool")).toBeTruthy();
    act(() => useEditorStore.getState().addNode({ id: "b", kind: "pool", name: "B", start: 0 }));
    expect(screen.getByTestId("palette-item-pool")).toBeTruthy();
  });

  it("picks the start state again when another model is opened", () => {
    useEditorStore.getState().load("empty.yaml", empty, "h");
    render(<EditorGraph />);
    expect(screen.getByTestId("palette").dataset.collapsed).toBe("false");
    act(() => useEditorStore.getState().load("full.yaml", full, "h"));
    expect(screen.getByTestId("palette").dataset.collapsed).toBe("true");
  });
});
