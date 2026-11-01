import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { parseModelYaml, type Model } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";
import { ChartPanel } from "../src/panels/ChartPanel.js";
import { LineChart, SERIES_COLORS } from "../src/panels/LineChart.js";
import { chartedPools, useRunStore, useSimulationFindings } from "../src/state/run.js";

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

/** A mint paying 3 a step into a vault, and a die roll filling a hoard. */
const model: Model = {
  version: 1,
  name: "Charts",
  properties: [],
  subsystems: [],
  nodes: [
    { id: "mint", kind: "source", name: "Mint", rate: 3 },
    { id: "vault", kind: "pool", name: "Vault", start: 5, activation: "passive" },
    { id: "luck", kind: "source", name: "Luck", rate: 6 },
    { id: "hoard", kind: "pool", name: "Hoard", start: 0, activation: "passive" },
  ],
  edges: [
    { id: "pay", kind: "flow", from: "mint", to: "vault" },
    { id: "roll", kind: "flow", from: "luck", to: "hoard", rate: "dice(1, 6)" },
  ],
  noInteraction: [],
  invariants: [],
};

beforeEach(() => useRunStore.setState(useRunStore.getInitialState(), true));
afterEach(cleanup);

describe("chart panel", () => {
  it("asks for a run before charting one", () => {
    render(<ChartPanel model={model} />);
    expect(screen.getByTestId("chart-run-empty")).toBeDefined();
  });

  it("plots pool amounts per step for the active run", () => {
    render(<ChartPanel model={model} />);
    act(() => useRunStore.getState().step(model, 4));
    expect(screen.getByTestId("chart-line-vault")).toBeDefined();
    expect(screen.getByTestId("chart-line-hoard")).toBeDefined();
    // Two series get a legend; the table view lists every step's amounts.
    expect(screen.getByTestId("chart-legend").textContent).toContain("Vault");
    fireEvent.click(screen.getByTestId("chart-table-toggle"));
    const rows = screen.getByTestId("chart-table").querySelectorAll("tbody tr");
    expect(rows).toHaveLength(5);
    expect(rows[4]!.textContent).toContain("17");
  });

  it("runs a Monte Carlo batch and draws median lines with p5-p95 bands", () => {
    render(<ChartPanel model={model} />);
    fireEvent.click(screen.getByTestId("chart-view-batch"));
    fireEvent.change(screen.getByTestId("batch-runs"), { target: { value: "20" } });
    fireEvent.change(screen.getByTestId("batch-steps"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("batch-run"));
    const batch = useRunStore.getState().batch!;
    expect(batch.runs).toHaveLength(20);
    expect(screen.getByTestId("chart-band-hoard")).toBeDefined();
    expect(screen.getByTestId("chart-line-vault")).toBeDefined();
  });

  it("refuses a batch too big for the browser", () => {
    render(<ChartPanel model={model} />);
    fireEvent.click(screen.getByTestId("chart-view-batch"));
    fireEvent.change(screen.getByTestId("batch-runs"), { target: { value: "10000" } });
    fireEvent.change(screen.getByTestId("batch-steps"), { target: { value: "1000" } });
    fireEvent.click(screen.getByTestId("batch-run"));
    expect(screen.getByTestId("batch-error").textContent).toContain("too much");
  });

  it("toggles a pool's series when the pool is clicked on the graph", () => {
    render(
      <>
        <GraphView model={model} />
        <ChartPanel model={model} />
      </>,
    );
    act(() => useRunStore.getState().step(model, 2));
    const vaultNode = document.querySelector('.react-flow__node[data-id="vault"]')!;
    fireEvent.click(vaultNode);
    expect(screen.queryByTestId("chart-line-vault")).toBeNull();
    expect(screen.getByTestId("chart-line-hoard")).toBeDefined();
    fireEvent.click(vaultNode);
    expect(screen.getByTestId("chart-line-vault")).toBeDefined();
  });
});

describe("line chart", () => {
  it("shows a crosshair tooltip with every series' value at the hovered step", () => {
    render(
      <LineChart
        title="Test"
        series={[
          { id: "a", label: "A", color: SERIES_COLORS[0]!, values: [0, 10, 20] },
          { id: "b", label: "B", color: SERIES_COLORS[1]!, values: [5, 5, 5] },
        ]}
      />,
    );
    const svg = screen.getByRole("img");
    svg.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 640, height: 220, right: 640, bottom: 220 }) as DOMRect;
    // The right edge of the plot is the last step.
    fireEvent.mouseMove(svg, { clientX: 624, clientY: 100 });
    const tooltip = screen.getByTestId("chart-tooltip").textContent;
    expect(tooltip).toContain("Step 2");
    expect(tooltip).toContain("A: 20");
    expect(tooltip).toContain("B: 5");
    fireEvent.mouseLeave(svg);
    expect(screen.queryByTestId("chart-tooltip")).toBeNull();
  });

  it("names a single series in the title without a legend", () => {
    render(
      <LineChart title="Solo" series={[{ id: "a", label: "A", color: "#000", values: [1, 2] }]} />,
    );
    expect(screen.queryByTestId("chart-legend")).toBeNull();
  });
});

describe("chartedPools", () => {
  it("defaults to the first few pools by id and keeps toggles in id order", () => {
    expect(chartedPools(null, ["e", "d", "c", "b", "a"])).toEqual(["a", "b", "c", "d"]);
    expect(chartedPools(["d", "a"], ["a", "b", "d"])).toEqual(["a", "d"]);
  });
});

describe("simulation findings", () => {
  it("reports checks over the active run and the latest batch", () => {
    const parsed = parseModelYaml(
      // Vitest runs from packages/web; jsdom gives no file: import.meta.url.
      readFileSync(`${process.cwd()}/../../fixtures/examples/starvation.yaml`, "utf8"),
    );
    if (!parsed.ok) throw new Error("starvation.yaml does not parse");
    const starving = parsed.model;
    const { result } = renderHook(() => useSimulationFindings(starving));
    expect(result.current).toEqual([]);
    act(() => useRunStore.getState().step(starving, 30));
    expect(result.current.map((f) => f.check)).toContain("sim-starvation");
    const before = result.current.length;
    act(() => useRunStore.getState().runBatch(starving, { seed: 1, runs: 10, steps: 30 }));
    // The batch's streak check adds findings of its own.
    expect(result.current.length).toBeGreaterThan(before);
  });
});
