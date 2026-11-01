import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Position, ReactFlowProvider, type EdgeProps } from "reactflow";
import { applyTheme, storedTheme, useTheme } from "../src/theme.js";
import { FlowEdge, MAX_TOKENS } from "../src/graph/edges/FlowEdge.js";
import type { FlowEdgeData } from "../src/graph/toFlow.js";

function Toggle(): JSX.Element {
  const [theme, toggle] = useTheme();
  return <button type="button" onClick={toggle}>{theme}</button>;
}

describe("theme", () => {
  afterEach(() => localStorage.clear());

  it("defaults to dark", () => {
    expect(storedTheme()).toBe("dark");
    applyTheme(storedTheme());
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("toggles to light, applies it to <html> and remembers it", () => {
    render(<Toggle />);
    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(screen.getByRole("button").textContent).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(storedTheme()).toBe("light");
  });
});

describe("moving edges", () => {
  it("pulses a signalling state edge and shows the source's new value", () => {
    const props = {
      id: "s", source: "a", target: "b", sourceX: 0, sourceY: 0, targetX: 200, targetY: 0,
      sourcePosition: Position.Right, targetPosition: Position.Left, label: "roll",
      data: { kind: "state", polarity: "+", signal: 0.640625, movedStep: 3 },
    } as unknown as EdgeProps<FlowEdgeData>;
    const { container } = render(<ReactFlowProvider><FlowEdge {...props} /></ReactFlowProvider>);
    expect(container.querySelector('[data-testid="flow-edge"]')?.getAttribute("class")).toBe("signal-pulse");
    expect(container.querySelector('[data-testid="edge-moved"]')?.textContent).toBe("0.64");
  });

  const edge = (moving: boolean): EdgeProps<FlowEdgeData> => ({
    id: "e",
    source: "a",
    target: "b",
    sourceX: 0,
    sourceY: 0,
    targetX: 200,
    targetY: 0,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: { kind: "flow", moving },
  }) as unknown as EdgeProps<FlowEdgeData>;

  it("streams dots along an edge only while it moves resources", () => {
    const { container, rerender } = render(<ReactFlowProvider><FlowEdge {...edge(false)} /></ReactFlowProvider>);
    expect(container.querySelector('[data-testid="flow-pulse"]')).toBeNull();
    rerender(<ReactFlowProvider><FlowEdge {...edge(true)} /></ReactFlowProvider>);
    const pulse = container.querySelector('[data-testid="flow-pulse"]');
    expect(pulse?.getAttribute("class")).toBe("flow-pulse");
    expect(pulse?.getAttribute("d")).toBe(container.querySelector('[data-testid="flow-edge"]')?.getAttribute("d"));
  });

  it("sends one token per resource moved, capped, keyed on the step", () => {
    const moved = (amount: number, step: number) =>
      ({ ...edge(true), data: { kind: "flow", rate: "2", moving: true, movedAmount: amount, movedStep: step } }) as unknown as EdgeProps<FlowEdgeData>;
    const { container, rerender } = render(<ReactFlowProvider><FlowEdge {...edge(false)} /></ReactFlowProvider>);
    expect(container.querySelector('[data-testid="flow-tokens"]')).toBeNull();
    rerender(<ReactFlowProvider><FlowEdge {...moved(3, 1)} /></ReactFlowProvider>);
    // The rate stays on the badge; the amount moved shows beside it.
    expect(container.querySelector('[data-testid="edge-badge"] text')?.textContent).toBe("2");
    expect(container.querySelector('[data-testid="edge-moved"]')?.textContent).toBe("3");
    const first = container.querySelector('[data-testid="flow-tokens"]');
    expect(first?.querySelectorAll("circle").length).toBe(3);
    rerender(<ReactFlowProvider><FlowEdge {...moved(50, 2)} /></ReactFlowProvider>);
    const second = container.querySelector('[data-testid="flow-tokens"]');
    expect(second?.querySelectorAll("circle").length).toBe(MAX_TOKENS);
    // A new step mounts a new group, so the SVG animation starts over.
    expect(second).not.toBe(first);
  });
});

