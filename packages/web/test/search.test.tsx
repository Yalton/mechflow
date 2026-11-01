import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { parseModelYaml, type Model } from "@mechflow/core";
import { RunControls } from "../src/graph/RunControls.js";
import { freshStrategyId, SearchPanel } from "../src/panels/SearchPanel.js";
import { useEditorStore } from "../src/state/editor.js";
import { runSearch, type SearchRequest } from "../src/search/analyses.js";
import { useRunStore } from "../src/state/run.js";
import { useSearchFindings, useSearchStore } from "../src/state/search.js";

function example(name: string): Model {
  const parsed = parseModelYaml(
    readFileSync(`${process.cwd()}/../../fixtures/examples/${name}.yaml`, "utf8"),
  );
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.model;
}

const request: SearchRequest = {
  analysis: "dominant",
  objective: "wealth",
  seed: 1,
  steps: 30,
  runs: 2,
  maxEvaluations: 200,
};

beforeEach(() => {
  useRunStore.setState(useRunStore.getInitialState(), true);
  useSearchStore.setState(useSearchStore.getInitialState(), true);
});
afterEach(cleanup);

describe("runSearch", () => {
  it("runs an analysis and tags the report with it", () => {
    const response = runSearch(example("combo"), request);
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.analysis).toBe("dominant");
    expect(response.findings.map((f) => f.id)).toEqual(["search-dominant:drill+pray+sharpen"]);
    expect(response.evaluationsUsed).toBeGreaterThan(0);
  });

  it("returns problems as a message", () => {
    expect(runSearch(example("combo"), { ...request, objective: "nope" })).toEqual({
      ok: false,
      error: 'options.objective: unknown objective "nope"',
    });
  });
});

describe("search panel", () => {
  it("runs the chosen analysis and shows its ranked table", async () => {
    const model = example("combo");
    render(<SearchPanel model={model} />);
    fireEvent.change(screen.getByTestId("search-runs"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("search-run"));
    expect(screen.getByTestId("search-running").textContent).toContain("dominant combinations");
    await screen.findByTestId("search-results");
    expect(screen.getByTestId("search-summary").textContent).toContain("1 finding");
    expect(screen.getAllByTestId("search-row")[0]!.textContent).toContain("drill + pray + sharpen");
  });

  it("adds its findings to the findings list for the same model only", async () => {
    const model = example("combo");
    await act(() => useSearchStore.getState().run(model, request));
    const { result, rerender } = renderHook(({ m }) => useSearchFindings(m), {
      initialProps: { m: model },
    });
    expect(result.current.map((f) => f.id)).toEqual(["search-dominant:drill+pray+sharpen"]);
    rerender({ m: { ...model } });
    expect(result.current).toEqual([]);
  });

  it("loads a found strategy into the run controls, which step it", async () => {
    const model = example("combo");
    await act(() => useSearchStore.getState().run(model, request));
    render(
      <>
        <RunControls model={model} />
        <SearchPanel model={model} />
      </>,
    );
    fireEvent.click(screen.getAllByTestId("search-load")[0]!);
    expect(screen.getByTestId("run-strategy").textContent).toContain("focus:drill+pray+sharpen");
    fireEvent.click(screen.getByTestId("run-step-once"));
    expect(useRunStore.getState().record!.firedByStrategy).toEqual(["drill", "pray", "sharpen"]);
    fireEvent.click(screen.getByTestId("run-strategy-clear"));
    expect(useRunStore.getState().strategy).toBeNull();
    expect(screen.queryByTestId("run-strategy")).toBeNull();
  });

  it("takes a typed objective when the model has none", async () => {
    const model = example("combo");
    delete model.objectives;
    render(<SearchPanel model={model} />);
    expect(screen.getByTestId("search-empty").textContent).toContain("no objectives");
    expect((screen.getByTestId("search-run") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("search-expr"), { target: { value: "gold" } });
    fireEvent.change(screen.getByTestId("search-runs"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("search-run"));
    await screen.findByTestId("search-results");
    expect(screen.getAllByTestId("search-row")[0]!.textContent).toContain("drill + pray + sharpen");
  });

  it("shows an analysis's error", async () => {
    render(<SearchPanel model={example("exploit")} />);
    fireEvent.click(screen.getByTestId("search-tab-optimizer"));
    fireEvent.change(screen.getByTestId("search-budget"), { target: { value: "5" } });
    fireEvent.click(screen.getByTestId("search-run"));
    expect((await screen.findByTestId("search-error")).textContent).toContain(
      "options.maxEvaluations",
    );
  });

  it("cancels a running search", async () => {
    const model = example("combo");
    render(<SearchPanel model={model} />);
    fireEvent.click(screen.getByTestId("search-run"));
    fireEvent.click(screen.getByTestId("search-cancel"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    // The Cancel click must not also submit the form and start over.
    expect(screen.queryByTestId("search-running")).toBeNull();
    expect(screen.queryByTestId("search-results")).toBeNull();
    expect(screen.getByTestId("search-empty")).toBeTruthy();
    expect(screen.getByTestId("search-run")).toBeTruthy();
  });

  it("has a table for every analysis", async () => {
    const model = example("narrow");
    for (const analysis of ["systems", "optimizer", "space", "boundary"] as const) {
      await act(() =>
        useSearchStore
          .getState()
          .run(model, { ...request, analysis, steps: 5, runs: 1, maxEvaluations: 300 }),
      );
      expect(useSearchStore.getState().error).toBeNull();
    }
    render(<SearchPanel model={model} />);
    for (const analysis of ["systems", "optimizer", "space", "boundary"] as const) {
      fireEvent.click(screen.getByTestId(`search-tab-${analysis}`));
      expect(screen.getAllByTestId("search-table").length).toBeGreaterThan(0);
    }
  });

  it("loads a boundary setting's parameters into the run controls", async () => {
    const model = example("boundary");
    await act(() =>
      useSearchStore
        .getState()
        .run(model, { ...request, analysis: "boundary", objective: "strength", steps: 10, runs: 1 }),
    );
    expect(useSearchStore.getState().error).toBeNull();
    render(<SearchPanel model={model} />);
    fireEvent.click(screen.getByTestId("search-tab-boundary"));
    const row = screen
      .getAllByTestId("search-row")
      .find((r) => r.textContent?.startsWith("all max"));
    expect(row).toBeTruthy();
    fireEvent.click(within(row!).getByTestId("search-load-setting"));
    expect(useRunStore.getState()).toMatchObject({
      strategy: null,
      parameters: { recruits: 5, training: 5 },
      overrides: {},
    });
  });

  it("saves a found strategy into the model under a fresh id", async () => {
    const model = example("combo");
    useEditorStore.getState().load("combo.yaml", model, "hash");
    await act(() => useSearchStore.getState().run(model, { ...request, runs: 2 }));
    render(<SearchPanel model={model} />);
    fireEvent.click(screen.getAllByTestId("search-save-strategy")[0]!);
    const saved = useEditorStore.getState().model!.strategies!;
    expect(saved.map((s) => s.id)).toEqual(["focus_drill_pray_sharpen"]);
    expect(saved[0]!.rules.map((r) => r.fire).sort()).toEqual(["drill", "pray", "sharpen"]);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
  });

  it("numbers a saved strategy's id when the model already has it", () => {
    const model = { ...example("combo"), strategies: [{ id: "focus_a", description: "x", rules: [] }] };
    expect(freshStrategyId({ id: "focus:a", description: "", rules: [] }, model)).toBe("focus_a_2");
    expect(freshStrategyId({ id: "9lives", description: "", rules: [] }, model)).toBe("s_9lives");
  });
});
