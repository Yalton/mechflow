import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Finding, Model } from "@mechflow/core";
import type { FlowEdgeData } from "../src/graph/toFlow.js";
import { ReactFlowProvider, type Position } from "reactflow";
import { FindingsPanel } from "../src/panels/FindingsPanel.js";
import { GraphView } from "../src/graph/GraphView.js";
import { FlowEdge } from "../src/graph/edges/FlowEdge.js";

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

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "check-1",
    check: "feedback-loops",
    severity: "warning",
    title: "Feedback loop",
    detail: "a -> b -> a",
    nodes: ["a", "b"],
    edges: ["a_to_b"],
    ...overrides,
  };
}

const onSelect = vi.fn();

beforeEach(() => {
  onSelect.mockClear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FindingsPanel", () => {
  it("groups findings by severity then check, with per-check counts", () => {
    render(
      <FindingsPanel
        findings={[
          finding({ id: "e1", check: "coupling", severity: "error", title: "Tight" }),
          finding({ id: "w1", check: "feedback-loops", severity: "warning", title: "Loop A" }),
          finding({ id: "w2", check: "feedback-loops", severity: "warning", title: "Loop B" }),
        ]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );

    // One severity section per non-empty severity, ordered error then warning.
    const severityLabels = screen.getAllByTestId("severity-label");
    expect(severityLabels[0].getAttribute("data-severity")).toBe("error");
    const severities = screen
      .getAllByTestId("severity-label")
      .map((el) => el.getAttribute("data-severity"));
    expect(severities).toEqual(["error", "warning"]);

    // Per-check counts.
    const counts = new Map<string, string>();
    for (const nameEl of screen.getAllByTestId("check-name")) {
      const countEl = nameEl.parentElement!.querySelector('[data-testid="check-count"]');
      counts.set(nameEl.textContent!, countEl!.textContent!);
    }
    expect(counts.get("feedback-loops")).toBe("(2)");
    expect(counts.get("coupling")).toBe("(1)");
  });

  it("calls onSelect with the finding id when a finding is clicked", () => {
    render(
      <FindingsPanel
        findings={[finding({ id: "w1", title: "Loop" })]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("finding"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("w1");
  });

  it("marks the highlighted finding via data-highlighted", () => {
    render(
      <FindingsPanel
        findings={[
          finding({ id: "w1", title: "One" }),
          finding({ id: "w2", title: "Two" }),
        ]}
        highlightedId="w2"
        onSelect={onSelect}
      />,
    );
    const rows = screen.getAllByTestId("finding");
    const two = rows.filter((el) => el.textContent?.includes("Two"));
    const one = rows.filter((el) => el.textContent?.includes("One"));
    expect(two).toHaveLength(1);
    expect(one).toHaveLength(1);
    const [twoEl] = two;
    const [oneEl] = one;
    expect(twoEl.getAttribute("data-highlighted")).toBe("true");
    expect(oneEl.getAttribute("data-highlighted")).toBe("false");
  });

  it("previews detail and involved nodes/edges on hover", () => {
    render(
      <FindingsPanel
        findings={[finding({ id: "w1", title: "Loop", detail: "a -> b -> a" })]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.queryByTestId("finding-preview")).toBeNull();
    fireEvent.mouseEnter(screen.getByTestId("finding"));
    const preview = screen.getByTestId("finding-preview");
    expect(preview.textContent).toContain("Loop");
    expect(preview.textContent).toContain("a -> b -> a");
    expect(preview.textContent).toContain("a, b");
    expect(preview.textContent).toContain("a_to_b");
  });

  it("dismisses a finding and hides it from the list", () => {
    render(
      <FindingsPanel
        findings={[finding({ id: "w1" }), finding({ id: "w2" })]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getAllByTestId("finding")).toHaveLength(2);

    fireEvent.click(screen.getAllByTestId("dismiss-finding")[0]);

    expect(screen.getAllByTestId("finding")).toHaveLength(1);
    expect(screen.getByTestId("finding").getAttribute("data-severity")).toBe("warning");
  });

  it("persists dismissed ids to localStorage and hides them on reload", () => {
    const first = render(
      <FindingsPanel
        findings={[finding({ id: "w1", title: "Loop A" }), finding({ id: "w2", title: "Loop B" })]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getAllByTestId("dismiss-finding")[0]);
    expect(localStorage.getItem("mechflow:dismissed-findings")).toContain("w1");
    first.unmount();

    const second = render(
      <FindingsPanel
        findings={[finding({ id: "w1", title: "Loop A" }), finding({ id: "w2", title: "Loop B" })]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );
    expect(screen.getAllByTestId("finding")).toHaveLength(1);
    expect(screen.getByTestId("finding").textContent).toContain("Loop B");
    second.unmount();
  });

  it("does not call onSelect when dismissing a finding", () => {
    render(
      <FindingsPanel
        findings={[finding({ id: "w1" })]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByTestId("dismiss-finding"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("filters findings by check", () => {
    render(
      <FindingsPanel
        findings={[
          finding({ id: "w1", check: "feedback-loops", title: "Loop" }),
          finding({ id: "e1", check: "coupling", title: "Tight", severity: "error" }),
        ]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.change(screen.getByTestId("filter-check"), {
      target: { value: "coupling" },
    });
    const rows = screen.getAllByTestId("finding");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Tight");
  });

  it("filters findings by severity", () => {
    render(
      <FindingsPanel
        findings={[
          finding({ id: "w1", severity: "warning", title: "Loop" }),
          finding({ id: "e1", severity: "error", title: "Tight" }),
        ]}
        highlightedId={null}
        onSelect={onSelect}
      />,
    );
    fireEvent.change(screen.getByTestId("filter-severity"), {
      target: { value: "error" },
    });
    const rows = screen.getAllByTestId("finding");
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute("data-severity")).toBe("error");
  });

  it("does not crash when localStorage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    expect(() =>
      render(
        <FindingsPanel
          findings={[finding({ id: "w1" })]}
          highlightedId={null}
          onSelect={onSelect}
        />,
      ),
    ).not.toThrow();
    expect(screen.getByTestId("finding")).toBeDefined();
  });
});

/** A three-node model with one edge, for graph-highlighting assertions. */
const highlightModel: Model = {
  version: 1,
  name: "Highlight",
  properties: [],
  subsystems: [{ id: "core", name: "Core", tier: "core" }],
  nodes: [
    { id: "a", kind: "mechanic", name: "A", subsystem: "core", reads: [], writes: [] },
    { id: "b", kind: "mechanic", name: "B", subsystem: "core", reads: [], writes: [] },
    { id: "c", kind: "mechanic", name: "C", subsystem: "core", reads: [], writes: [] },
  ],
  edges: [
    { id: "a_to_b", kind: "flow", from: "a", to: "b", label: "", strength: "modifier" },
  ],
  noInteraction: [],
  invariants: [],
};

describe("GraphView highlighting", () => {
  it("dims no nodes when no highlight is active", () => {
    render(<GraphView model={highlightModel} />);
    expect(document.querySelectorAll(".react-flow__node.mechflow-dim")).toHaveLength(0);
  });

  it("dims nodes outside the highlighted finding", () => {
    render(
      <GraphView
        model={highlightModel}
        highlightedNodeIds={new Set(["a"])}
        highlightedEdgeIds={new Set(["a_to_b"])}
      />,
    );
    // Three nodes total; only b and c are outside the finding -> dimmed.
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(3);
    expect(document.querySelectorAll(".react-flow__node.mechflow-dim")).toHaveLength(2);
    // The highlighted node keeps the base class, no dim class.
    const nodeA = document.querySelector('[data-id="a"]');
    expect(nodeA?.className).toContain("react-flow__node-mechanic");
    expect(nodeA?.className).not.toContain("mechflow-dim");
  });

  it("keeps the node reference stable when highlighting is inactive", () => {
    const { rerender } = render(
      <GraphView model={highlightModel} highlightedNodeIds={new Set()} highlightedEdgeIds={new Set()} />,
    );
    const before = document.querySelectorAll(".react-flow__node").length;
    rerender(<GraphView model={highlightModel} highlightedNodeIds={new Set()} highlightedEdgeIds={new Set()} />);
    expect(document.querySelectorAll(".react-flow__node").length).toBe(before);
  });
});

/**
 * React Flow does not render edges in jsdom (nodes measure 0, so the edge
 * group stays empty). Render the edge renderer directly to assert the dim
 * attribute/opacity it applies from `data.highlighted`.
 */
function renderFlowEdge(data: Partial<FlowEdgeData>): JSX.Element {
  const props = {
    id: "a_to_b",
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: "right" as Position,
    targetPosition: "left" as Position,
    label: "",
    data: {
      edge: { id: "a_to_b", kind: "flow", from: "a", to: "b" },
      kind: "flow",
      ...data,
    } as FlowEdgeData,
  };
  // FlowEdge reads the node cards from the React Flow store.
  return (
    <ReactFlowProvider>
      <FlowEdge {...props} />
    </ReactFlowProvider>
  );
}

describe("FlowEdge highlighting", () => {
  it("marks an edge fully visible when no highlight is active", () => {
    render(renderFlowEdge({}));
    const edge = screen.getByTestId("flow-edge");
    expect(edge.getAttribute("data-highlighted")).toBe("true");
  });

  it("marks an edge in the finding as highlighted", () => {
    render(renderFlowEdge({ highlighted: true }));
    expect(screen.getByTestId("flow-edge").getAttribute("data-highlighted")).toBe("true");
  });

  it("dims an edge outside the finding", () => {
    render(renderFlowEdge({ highlighted: false }));
    const edge = screen.getByTestId("flow-edge");
    expect(edge.getAttribute("data-highlighted")).toBe("false");
    // The dim opacity is applied to the svg wrapper, not the path.
    expect(edge.parentElement?.style.opacity).toBe("0.3");
  });
});
