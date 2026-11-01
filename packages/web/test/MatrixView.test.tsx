import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { analyzeModel, type Model, type Report } from "@mechflow/core";
import { MatrixView } from "../src/panels/MatrixView.js";

/**
 * MatrixView: tests the report→grid conversion and the click-to-select-pair
 * behaviour. Every assertion reads a rendered `data-testid` or the captured
 * canvas-selection calls, so it reflects what the user sees in the browser.
 */

/**
 * A model that exercises all four cell kinds:
 *  - interaction edges  → `edges` cells (m1–m2, m1–e1)
 *  - noInteraction       → `intentionalNone` cell (m2–m3)
 *  - shared property     → `ghost` cell (m1–m3, both write p1)
 *  - no relationship      → `empty` cell (m4–e1)
 */
function matrixModel(): Model {
  return {
    version: 1,
    name: "Matrix",
    properties: [{ id: "p1", kind: "number", description: "health" }],
    subsystems: [{ id: "s1", name: "Core", role: "main", tier: "core" }],
    nodes: [
      {
        id: "m1", kind: "mechanic", name: "M1",
        reads: [], writes: ["p1"], drives: [], subsystem: "s1",
      },
      {
        id: "m2", kind: "mechanic", name: "M2",
        reads: [], writes: [], subsystem: "s1",
      },
      {
        id: "m3", kind: "mechanic", name: "M3",
        reads: [], writes: ["p1"], drives: [], subsystem: "s1",
      },
      {
        id: "m4", kind: "mechanic", name: "M4",
        reads: [], writes: [], drives: [], subsystem: "s1",
      },
      { id: "e1", kind: "entity", name: "E1", has: [], subsystem: "s1" },
    ],
    edges: [
      { id: "i1", kind: "interaction", from: "m1", to: "m2", label: "feeds" },
      { id: "i2", kind: "interaction", from: "m1", to: "e1", label: "tracks" },
    ],
    noInteraction: [{ a: "m2", b: "m3", reason: "avoids duplication" }],
    invariants: [],
  };
}

/** A fresh report for the matrix model. */
function matrixReport(): Report {
  return analyzeModel(matrixModel());
}

/**
 * Canvas-selection sink the panel reaches via `globalThis.__rfStore`. Records
 * the ids passed to `addSelectedNodes`/`setEdgesSelected` so the click can be
 * asserted without a live graph.
 */
function installFakeStore(): {
  selectedNodes: string[];
  selectedEdges: string[];
} {
  const captured = { selectedNodes: [] as string[], selectedEdges: [] as string[] };
  (globalThis as { __rfStore?: unknown }).__rfStore = {
    getState: () => ({
      addSelectedNodes: (ids: string[]) => {
        captured.selectedNodes.push(...ids);
      },
      setEdgesSelected: (ids: string[], selected: boolean) => {
        if (selected) captured.selectedEdges.push(...ids);
      },
    }),
  };
  return captured;
}

async function renderMatrix(report: Report = matrixReport()): Promise<void> {
  await act(async () => {
    render(<MatrixView report={report} />);
  });
}

/** The grid cell for the ordered pair (a, b), matched by its data axes. */
function cellFor(a: string, b: string): HTMLElement {
  const cell = screen
    .getAllByTestId("matrix-cell")
    .find(
      (c) =>
        c.getAttribute("data-a") === a &&
        c.getAttribute("data-b") === b,
    );
  if (!cell) throw new Error(`no matrix cell for ${a}-${b}`);
  return cell as HTMLElement;
}

describe("MatrixView", () => {
  afterEach(() => vi.clearAllMocks());

  it("renders a grid whose rows and columns are the matrix ids", async () => {
    await renderMatrix();

    const grid = screen.getByTestId("matrix-grid");
    // Columns (header) and rows (first column) both carry the sorted ids.
    const columns = grid.querySelectorAll("thead th[data-id]");
    const rows = grid.querySelectorAll("tbody th[data-id]");
    expect(columns.length).toBe(matrixReport().matrix.ids.length);
    expect(rows.length).toBe(matrixReport().matrix.ids.length);
    expect(
      Array.from(columns)
        .map((th) => th.getAttribute("data-id"))
        .join(","),
    ).toBe("e1,m1,m2,m3,m4");
    expect(
      Array.from(rows)
        .map((th) => th.getAttribute("data-id"))
        .join(","),
    ).toBe("e1,m1,m2,m3,m4");
  });

  it("shows edge labels in interaction-edge cells", async () => {
    await renderMatrix();

    const cell = cellFor("m1", "m2");
    expect(cell.getAttribute("data-kind")).toBe("edges");
    expect(
      cell.querySelector('[data-testid="matrix-edge-labels"]')?.textContent ??
        "",
    ).toBe("i1");
  });

  it("shows a neutral mark with the hover reason on intentional-none cells", async () => {
    await renderMatrix();

    const cell = cellFor("m2", "m3");
    expect(cell.getAttribute("data-kind")).toBe("intentionalNone");
    expect(cell.getAttribute("title")).toBe("avoids duplication");
    expect(
      cell.querySelector('[data-testid="matrix-intentional"]')?.textContent ??
        "",
    ).toBe("—");
  });

  it("highlights ghost-edge cells", async () => {
    await renderMatrix();

    const cell = cellFor("m1", "m3");
    expect(cell.getAttribute("data-kind")).toBe("ghost");
    // Ghost cells are visually distinct from the plain empty cell.
    expect(cell.style.background).toBe("var(--warning-soft)");
  });

  it("leaves empty cells blank", async () => {
    await renderMatrix();

    const cell = cellFor("m4", "e1");
    expect(cell.getAttribute("data-kind")).toBe("empty");
    expect(cell.textContent).toBe("");
  });

  it("selects the pair on the graph when a cell is clicked", async () => {
    const captured = installFakeStore();
    await renderMatrix();

    await act(async () => {
      fireEvent.click(cellFor("m1", "m2"));
    });

    // The pair (both nodes) is selected; the interaction edge is selected too.
    expect(captured.selectedNodes).toContain("m1");
    expect(captured.selectedNodes).toContain("m2");
    expect(captured.selectedEdges).toContain("i1");
  });

  it("selects the pair without an edge for a ghost-cell click", async () => {
    const captured = installFakeStore();
    await renderMatrix();

    await act(async () => {
      fireEvent.click(cellFor("m1", "m3"));
    });

    expect(captured.selectedNodes).toContain("m1");
    expect(captured.selectedNodes).toContain("m3");
    // A ghost pair has no interaction edge, so nothing is edge-selected.
    expect(captured.selectedEdges).toHaveLength(0);
  });
});
