import { afterEach, describe, expect, it, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  createEvent,
} from "@testing-library/react";
import type { Model } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";
import { useEditorStore } from "../src/state/editor.js";
import {
  createNode,
  nextNodeName,
  uniqueEdgeId,
  uniqueNodeId,
} from "../src/graph/nodeFactory.js";

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
 * The React Flow store captured by {@link InstanceRef} and exposed on
 * `globalThis`. Read directly so the connect test can locate the target handle
 * the way React Flow itself does.
 */
type RFStoreLike = {
  getState(): {
    nodes: Array<{
      id: string;
      positionAbsolute?: { x: number; y: number };
    }>;
    handleBounds?: {
      target?: Array<{
        nodeId: string;
        x: number;
        y: number;
        width?: number;
        height?: number;
      }>;
    };
  };
};

/** A small, well-formed model with two connected economy nodes. */
function baseModel(): Model {
  return {
    version: 1,
    name: "Canvas",
    properties: [],
    subsystems: [],
    nodes: [
      { id: "n1", kind: "source", name: "N1", rate: 1 },
      { id: "n2", kind: "drain", name: "N2", rate: 1 },
    ],
    edges: [{ id: "e1", kind: "flow", from: "n1", to: "n2", rate: "1" }],
    noInteraction: [],
    invariants: [],
  };
}

function load(model: Model = baseModel()): void {
  useEditorStore.getState().load("canvas.yaml", model, "hash-1");
}

/** A minimal fake `DataTransfer` for HTML5 drag-and-drop events. */
function fakeDataTransfer(initial: Record<string, string> = {}): DataTransfer {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    getData: (key: string) => store.get(key) ?? "",
    setData: (key: string, value: string) => void store.set(key, value),
    effectAllowed: "copy",
    dropEffect: "copy",
  } as unknown as DataTransfer;
}

/** The React Flow pane that receives drop events. */
function pane(): HTMLElement {
  const el = document.querySelector(".react-flow__pane");
  if (!el) throw new Error("react-flow__pane not found");
  return el;
}


describe("nodeFactory", () => {
  it("assigns a unique, non-colliding id per kind", () => {
    expect(uniqueNodeId([], "source")).toBe("source-1");
    expect(uniqueNodeId(["source-1"], "source")).toBe("source-2");
    expect(uniqueNodeId(["source-1", "source-2"], "source")).toBe("source-3");
    // Independent counter per kind.
    expect(uniqueNodeId(["source-1"], "drain")).toBe("drain-1");
  });

  it("builds a valid, pinned node with sensible defaults per kind", () => {
    const node = createNode("source", [], { x: 10, y: 20 });
    expect(node).toMatchObject({
      id: "source-1",
      kind: "source",
      name: "Source 1",
      rate: 1,
      position: { x: 10, y: 20, pinned: true },
    });

    const gate = createNode("gate", [], { x: 0, y: 0 });
    expect(gate).toMatchObject({ kind: "gate", mode: "random" });

    const mechanic = createNode("mechanic", [], { x: 0, y: 0 });
    expect(mechanic).toMatchObject({ kind: "mechanic", reads: [], writes: [] });
  });

  it("auto-increments names from existing nodes of the same kind", () => {
    const existing: Model["nodes"] = [
      { id: "source-1", kind: "source", name: "Source 1", rate: 1 },
      { id: "source-2", kind: "source", name: "Source 2", rate: 1 },
    ];
    const node = createNode("source", existing, { x: 0, y: 0 });
    expect(node.id).toBe("source-3");
    expect(node.name).toBe("Source 3");
    expect(nextNodeName(existing, "source")).toBe("Source 3");
  });

  it("generates non-colliding edge ids", () => {
    expect(uniqueEdgeId([])).toBe("edge-1");
    expect(uniqueEdgeId(["edge-1"])).toBe("edge-2");
  });
});

describe("GraphView canvas editing", () => {
  afterEach(() => {
    useEditorStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("adds a pinned node at the drop point when a kind is dropped", () => {
    load();
    render(<GraphView model={useEditorStore.getState().model} />);

    fireEvent.drop(pane(), {
      clientX: 120,
      clientY: 80,
      dataTransfer: fakeDataTransfer({
        "text/mechflow-node-kind": "source",
      }),
    });

    const model = useEditorStore.getState().model!;
    const added = model.nodes.find((n) => n.kind === "source" && n.name === "Source 1");
    expect(added).toBeDefined();
    // Dropped nodes are pinned so layout does not move them.
    expect(added?.position?.pinned).toBe(true);
    // The pre-existing nodes are untouched.
    expect(model.nodes.some((n) => n.id === "n1")).toBe(true);
  });

  it("removes the selected node and its edges on Delete", async () => {
    load();
    render(<GraphView model={useEditorStore.getState().model} />);

    // Establish selection as a click does (via the React Flow store), then
    // press Delete. The delete handler reads selection straight from the store.
    const store = (
      globalThis as {
        __rfStore?: {
          getState: () => { addSelectedNodes?: (ids: string[]) => void };
        };
      }
    ).__rfStore;
    await act(async () => {
      store.getState().addSelectedNodes(["n1"]);
    });

    fireEvent.keyDown(window, { key: "Delete" });

    await waitFor(() => {
      const model = useEditorStore.getState().model!;
      expect(model.nodes.some((n) => n.id === "n1")).toBe(false);
      expect(model.edges.some((e) => e.id === "e1")).toBe(false);
    });
  });

  it("opens a popover and creates a selected edge kind when a connection is made", async () => {
    load();
    render(<GraphView model={useEditorStore.getState().model} />);

    const rf = (globalThis as { __rfStore?: RFStoreLike }).__rfStore;
    const st = rf!.getState();

    // jsdom has no hit-testers. Give React Flow the same elementFromPoint /
    // elementsFromPoint it calls on the connection handler (document) so the
    // flow runs. Both point at n2's target handle.
    const n2Target = () =>
      document.querySelector(
        '.react-flow__handle-left[data-node-id="n2"][data-handlepos="left"',
      );
    (
      document as {
        elementFromPoint?: (x: number, y: number) => Element | null;
      }
    ).elementFromPoint = () => n2Target();
    (
      document as {
        elementsFromPoint?: (x: number, y: number) => Element[];
      }
    ).elementsFromPoint = () => [n2Target()];

    // Measure n2 so React Flow computes its candidate handles (handleBounds).
    // jsdom reports zero-size nodes; set the metrics and force a re-measure.
    const n2El = document.querySelector('[data-node-id="n2"]') as HTMLElement;
    Object.defineProperty(n2El, "offsetWidth", { value: 150, configurable: true });
    Object.defineProperty(n2El, "offsetHeight", { value: 50, configurable: true });
    (n2El as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect = () =>
      ({
        x: 40,
        y: 170,
        width: 150,
        height: 50,
        left: 40,
        top: 170,
        right: 190,
        bottom: 220,
      }) as DOMRect;
    // The target handle carries `data-node-id`; the wrapper carries `data-id`.
    // Query the handle directly, not as a descendant.
    const target = document.querySelector(
      '.react-flow__handle-left[data-node-id="n2"',
    ) as HTMLElement;
    (target as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect = () =>
      ({
        x: 40,
        y: 193,
        width: 12,
        height: 12,
        left: 40,
        top: 193,
        right: 52,
        bottom: 205,
      }) as DOMRect;
    // React Flow's updateNodeDimensions reads `new window.DOMMatrixReadOnly(...)`.
    // jsdom lacks it, so polyfill a minimal transform-string reader.
    (window as { DOMMatrixReadOnly?: typeof DOMMatrixReadOnly }).DOMMatrixReadOnly =
      class {
        m22 = 1;
        constructor(transform?: string) {
          if (transform) {
            const m = transform.match(/scale\(([\d.]+)\)/);
            if (m) this.m22 = Number(m[1]);
          }
        }
      } as unknown as typeof DOMMatrixReadOnly;
    await act(async () => {
      st.updateNodeDimensions([{ id: "n2", nodeElement: n2El, forceUpdate: true }]);
    });

    // Drag from n1's source handle. React Flow's connection handler listens for
    // mousedown on the source, then mousemove / mouseup on the document,
    // calling onConnect when the pointer ends near the target handle.
    const source = document.querySelector(
      '.react-flow__handle-right[data-node-id="n1"',
    )!;
    await act(async () => {
      fireEvent.mouseDown(source, { button: 0, clientX: 4, clientY: 196 });
    });

    // Land the pointer on n2's target handle (within connectionRadius).
    await act(async () => {
      fireEvent.mouseMove(document, { button: 0, clientX: 44, clientY: 196 });
      fireEvent.mouseUp(document, { button: 0 });
    });

    // The popover lets the user pick the edge kind, then the edge is added.
    await screen.findByTestId("edge-kind-popover");
    const kind = document.querySelector('[data-testid="edge-kind-flow"]')!;
    await act(async () => {
      fireEvent.click(kind);
    });

    await waitFor(() => {
      const model = useEditorStore.getState().model!;
      expect(
        model.edges.some(
          (e) => e.from === "n1" && e.to === "n2" && e.kind === "flow",
        ),
      ).toBe(true);
    });
  });

  it("pins a node's position when its drag stops", async () => {
    load();
    render(<GraphView model={useEditorStore.getState().model} />);

    // Drag n1: down on the node body (d3-drag starts there), then move / up on
    // the document, where d3-drag's move/up listeners are bound. Coordinates
    // make the position change so the handler writes it back as pinned. The
    // body carries `data-id`; the handle carries `data-node-id`.
    // jsdom MouseEvent.view defaults to null; pass `view: window` so d3-drag's
    // `nodrag(view)` reads a live document instead of crashing.
    const body = document.querySelector('.react-flow__node[data-id="n1"')!;
    // Build without `view` (jsdom rejects an injected Window in init); set it
    // after, where d3-drag merely reads the property to find its document.
    const down = createEvent.mouseDown(body, {
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    Object.defineProperty(down, "view", {
      value: window,
      configurable: true,
      enumerable: true,
    });
    // The drag's end handler reads `event.view` on mouseUp too; jsdom defaults
    // it null, so set it on the up event as well.
    const up = createEvent.mouseUp(document, { button: 0 });
    Object.defineProperty(up, "view", {
      value: window,
      configurable: true,
      enumerable: true,
    });
    await act(async () => {
      body.dispatchEvent(down);
      fireEvent.mouseMove(document, { button: 0, clientX: 160, clientY: 120 });
      body.ownerDocument.dispatchEvent(up);
    });

    await waitFor(() => {
      const model = useEditorStore.getState().model!;
      const n1 = model.nodes.find((n) => n.id === "n1")!;
      expect(n1.position).toBeTruthy();
      expect(n1.position?.pinned).toBe(true);
    });
  });
});

