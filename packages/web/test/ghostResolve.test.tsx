import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { findGhostEdges, type Model } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";
import { Inspector } from "../src/panels/Inspector.js";
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

/**
 * jsdom lays nothing out, so React Flow measures every node as 0x0 and skips
 * drawing its edges. Give elements a size, and polyfill the
 * `DOMMatrixReadOnly` that React Flow's node measuring reads, so the ghost
 * edge renders.
 */
const sizeProps = ["offsetWidth", "offsetHeight"] as const;
beforeAll(() => {
  for (const prop of sizeProps) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => 100 });
  }
  (window as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly ??= class {
    m22 = 1;
  };
});
afterAll(() => {
  for (const prop of sizeProps) delete (HTMLElement.prototype as Record<string, unknown>)[prop];
});

type FlowStoreLike = {
  getState(): {
    updateNodeDimensions(
      updates: { id: string; nodeElement: HTMLDivElement; forceUpdate?: boolean }[],
    ): void;
  };
};

/** Fire writes temperature, water reads it, and nothing connects them. */
function ghostModel(): Model {
  return {
    version: 1,
    name: "Ghost",
    properties: [{ id: "temperature", kind: "number" }],
    subsystems: [],
    nodes: [
      { id: "fire", kind: "mechanic", name: "Fire", reads: [], writes: ["temperature"] },
      { id: "water", kind: "mechanic", name: "Water", reads: ["temperature"], writes: [] },
    ],
    edges: [],
    noInteraction: [],
    invariants: [],
  };
}

/**
 * Renders the graph and inspector over the editor store's live model, with
 * ghost edges recomputed from it on every edit (standing in for the App's
 * debounced re-analysis).
 */
function Harness(): JSX.Element {
  const model = useEditorStore((s) => s.model);
  const [selection, setSelection] = useState<{ nodeId?: string; edgeId?: string }>({});
  // The store is reset after each test, possibly before unmount.
  if (!model) return <></>;
  return (
    <>
      <GraphView
        model={model}
        report={{ ghostEdges: findGhostEdges(model) }}
        onSelectionChange={setSelection}
      />
      <Inspector model={model} selection={selection} />
    </>
  );
}

/**
 * The no-op ResizeObserver never reports sizes, so measure the nodes by hand.
 * Needed after each model change too: the graph rebuilds its nodes then.
 */
async function measureNodes(): Promise<void> {
  const flowStore = (globalThis as { __rfStore?: FlowStoreLike }).__rfStore!;
  await act(async () => {
    flowStore.getState().updateNodeDimensions(
      [...document.querySelectorAll<HTMLDivElement>(".react-flow__node")].map((nodeElement) => ({
        id: nodeElement.dataset.id!,
        nodeElement,
        forceUpdate: true,
      })),
    );
  });
}

async function openGhostPopover(): Promise<void> {
  render(<Harness />);
  await measureNodes();
  const ghost = await screen.findByTestId("ghost-edge");
  expect(ghost.getAttribute("data-edge-id")).toBe("ghost-edge:fire_water");
  fireEvent.click(ghost);
  expect(screen.getByTestId("ghost-resolve-popover")).toBeTruthy();
}

describe("resolving ghost edges from the canvas", () => {
  afterEach(() => {
    useEditorStore.getState().reset();
  });

  it("opens a popover listing the pair and every reason", async () => {
    useEditorStore.getState().load("ghost.yaml", ghostModel(), "h1");
    await openGhostPopover();
    const popover = screen.getByTestId("ghost-resolve-popover");
    expect(popover.textContent).toContain("Fire");
    expect(popover.textContent).toContain("Water");
    expect(screen.getByTestId("ghost-resolve-reasons").textContent).toContain(
      "temperature is written by one and read by the other",
    );
    fireEvent.click(screen.getByTestId("ghost-resolve-close"));
    expect(screen.queryByTestId("ghost-resolve-popover")).toBeNull();
  });

  it("Connect adds an undoable interaction edge and opens the inspector on it", async () => {
    useEditorStore.getState().load("ghost.yaml", ghostModel(), "h1");
    await openGhostPopover();
    await act(async () => fireEvent.click(screen.getByTestId("ghost-resolve-connect")));

    const edges = useEditorStore.getState().model!.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: "interaction", from: "fire", to: "water" });
    expect(screen.queryByTestId("ghost-resolve-popover")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("edge-inspector")).toBeTruthy());
    expect(screen.getByTestId("edge-inspector").textContent).toContain("Interaction");
    // The pair is now connected, so its ghost edge is gone.
    expect(screen.queryByTestId("ghost-edge")).toBeNull();

    await act(async () => useEditorStore.getState().undo());
    await measureNodes();
    expect(useEditorStore.getState().model!.edges).toHaveLength(0);
    expect(await screen.findByTestId("ghost-edge")).toBeTruthy();
  });

  it("Intentionally none asks for a reason and adds an undoable noInteraction", async () => {
    useEditorStore.getState().load("ghost.yaml", ghostModel(), "h1");
    await openGhostPopover();
    fireEvent.click(screen.getByTestId("ghost-resolve-none"));
    const confirm = screen.getByTestId("ghost-resolve-confirm") as HTMLButtonElement;
    // A reason is required before it can be recorded.
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("ghost-resolve-reason"), {
      target: { value: "  Water is cosmetic here  " },
    });
    await act(async () => fireEvent.click(confirm));

    expect(useEditorStore.getState().model!.noInteraction).toEqual([
      { a: "fire", b: "water", reason: "Water is cosmetic here" },
    ]);
    expect(useEditorStore.getState().model!.edges).toHaveLength(0);
    expect(screen.queryByTestId("ghost-resolve-popover")).toBeNull();
    expect(screen.queryByTestId("ghost-edge")).toBeNull();

    await act(async () => useEditorStore.getState().undo());
    await measureNodes();
    expect(useEditorStore.getState().model!.noInteraction).toEqual([]);
    expect(await screen.findByTestId("ghost-edge")).toBeTruthy();
  });

  it("Back returns from the reason prompt without recording anything", async () => {
    useEditorStore.getState().load("ghost.yaml", ghostModel(), "h1");
    await openGhostPopover();
    fireEvent.click(screen.getByTestId("ghost-resolve-none"));
    fireEvent.click(screen.getByTestId("ghost-resolve-cancel"));
    expect(screen.getByTestId("ghost-resolve-connect")).toBeTruthy();
    expect(useEditorStore.getState().model!.noInteraction).toEqual([]);
  });
});
