import { describe, expect, it } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from "@testing-library/react";
import type { Model } from "@mechflow/core";
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

/** A well-formed model with a property, subsystem, source, register node, and flow edge. */
function richModel(): Model {
  return {
    version: 1,
    name: "Canvas",
    properties: [{ id: "p1", kind: "number", description: "flow" }],
    subsystems: [{ id: "s1", name: "Core", role: "main", tier: "core" }],
    nodes: [
      { id: "n1", kind: "source", name: "N1", rate: 1, subsystem: "s1" },
      { id: "n2", kind: "register", name: "Reg", formula: "0" },
    ],
    edges: [{ id: "e1", kind: "flow", from: "n1", to: "n2", rate: "1" }],
    noInteraction: [],
    invariants: [],
  };
}

/** A model with a malformed node (a source missing its `rate`). */
function modelWithBadNode(): Model {
  const model = richModel();
  model.nodes.push({ id: "bad", kind: "source", name: "Bad" } as Model["nodes"][number]);
  return model;
}

function load(model: Model = richModel()): void {
  useEditorStore.getState().load("inspector.yaml", model, "hash-1");
}

/**
 * Render the graph (which owns the React Flow store) alongside the Inspector.
 * The Inspector subscribes to that store, so selecting on the graph shows its
 * form. The store is captured on `globalThis` by {@link GraphView}'s InstanceRef.
 */
function renderInspector(model: Model = richModel()): ReturnType<typeof render> {
  load(model);
  return render(
    <>
      <GraphView model={model} />
      <Inspector model={model} />
    </>,
  );
}

async function selectNode(id: string): Promise<void> {
  const store = (
    globalThis as {
      __rfStore?: { getState: () => { addSelectedNodes?: (ids: string[]) => void } };
    }
  ).__rfStore;
  await act(async () => {
    store?.getState().addSelectedNodes([id]);
  });
}

async function selectEdge(id: string): Promise<void> {
  const store = (
    globalThis as {
      __rfStore?: {
        getState: () => { addSelectedEdges?: (ids: string[]) => void };
      };
    }
  ).__rfStore;
  await act(async () => {
    store?.getState().addSelectedEdges([id]);
  });
}

describe("Inspector", () => {
  it("shows a name form for the selected node", async () => {
    renderInspector();
    await selectNode("n1");

    await waitFor(() => {
      expect(screen.getByTestId("node-inspector")).toBeTruthy();
      const input = screen.getByTestId("node-name") as HTMLInputElement;
      expect(input.value).toBe("N1");
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("node-name"), {
        target: { value: "Source Prime" },
      });
    });

    await waitFor(() => {
      const n1 = useEditorStore.getState().model!.nodes.find((n) => n.id === "n1");
      expect(n1?.name).toBe("Source Prime");
    });
  });

  it("edits the subsystem via the picker", async () => {
    renderInspector();
    await selectNode("n1");

    // n1 already has subsystem s1; switch it to a different one. React's
    // controlled `<select>` reports the *current* controlled value as
    // `event.target.value`, so set the option first — the change then reads
    // "s2" rather than being coerced back to the present value.
    const select = screen.getByTestId("node-subsystem") as HTMLSelectElement;
    Object.defineProperty(select, 'value', {
      configurable: true,
      writable: true,
    });
    select.value = "s2";

    await act(async () => {
      fireEvent.change(select, { target: { value: "s2" } });
    });

    await waitFor(() => {
      const n1 = useEditorStore.getState().model!.nodes.find((n) => n.id === "n1");
      expect(n1?.subsystem).toBe("s2");
    });
  });

  it("shows a live parse error on a formula field", async () => {
    const model = richModel();
    // Give the register node a broken formula up front.
    model.nodes.push({
      id: "n3",
      kind: "register",
      name: "Broken",
      formula: "1 +",
    } as Model["nodes"][number]);
    renderInspector(model);
    await selectNode("n3");

    await waitFor(() => {
      const input = screen.getByTestId("node-formula") as HTMLInputElement;
      expect(input.value).toBe("1 +");
      expect(screen.getByTestId("formula-error")).toBeTruthy();
    });

    // Repair the formula; the error clears.
    await act(async () => {
      fireEvent.change(screen.getByTestId("node-formula"), {
        target: { value: "2*3" },
      });
    });

    await waitFor(() => {
      expect(screen.queryByTestId("formula-error")).toBeNull();
    });
  });

  it("creates a property inline via the reads picker", async () => {
    const model = richModel();
    model.nodes.push({
      id: "m1",
      kind: "mechanic",
      name: "M",
      reads: [],
      writes: [],
    } as Model["nodes"][number]);
    renderInspector(model);
    await selectNode("m1");

    await waitFor(() => expect(screen.getByTestId("node-reads-new")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByTestId("node-reads-new"));
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("node-reads-id"), {
        target: { value: "pNew" },
      });
      fireEvent.change(screen.getByTestId("node-reads-kind"), {
        target: { value: "flag" },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("node-reads-create"));
    });

    await waitFor(() => {
      const p = useEditorStore.getState().model!.properties.find(
        (pr) => pr.id === "pNew",
      );
      expect(p?.kind).toBe("flag");
    });
  });

  it("shows polarity and strength toggles for a flow edge", async () => {
    renderInspector();
    await selectEdge("e1");

    await waitFor(() => {
      expect(screen.getByTestId("edge-inspector")).toBeTruthy();
      const select = screen.getByTestId("edge-polarity") as HTMLSelectElement;
      expect(select.value).toBe("");
    });

    await act(async () => {
      fireEvent.change(screen.getByTestId("edge-polarity"), {
        target: { value: "+" },
      });
      fireEvent.change(screen.getByTestId("edge-strength"), {
        target: { value: "gate" },
      });
    });

    await waitFor(() => {
      const e1 = useEditorStore.getState().model!.edges.find((e) => e.id === "e1");
      expect(e1?.polarity).toBe("+");
      expect(e1?.strength).toBe("gate");
    });
  });

  it("shows validation errors inline for a not-yet-valid model", async () => {
    renderInspector(modelWithBadNode());

    await waitFor(() => {
      const list = screen.getByTestId("validation-errors");
      expect(list).toBeTruthy();
    });

    await waitFor(() => {
      const text = screen.getByTestId("validation-errors").textContent ?? "";
      // The malformed source node is appended after n1/n2, so it is index 2.
      expect(text).toContain("nodes.2.rate: Required");
    });
  });

  it("falls back to a library list when nothing is selected", async () => {
    renderInspector();
    // No selection yet.
    await waitFor(() => {
      expect(screen.getByTestId("library")).toBeTruthy();
      expect(screen.getByTestId("property-list")).toBeTruthy();
      expect(screen.getByTestId("subsystem-list")).toBeTruthy();
    });
  });

  it("edits property and subsystem details in the library", async () => {
    renderInspector();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("p1 description"), { target: { value: "health" } });
      fireEvent.change(screen.getByLabelText("s1 role"), { target: { value: "combat" } });
    });
    const model = useEditorStore.getState().model!;
    expect(model.properties[0]?.description).toBe("health");
    expect(model.subsystems[0]?.role).toBe("combat");
  });

  it("keeps existing property selections when another is checked", async () => {
    const model = richModel();
    model.properties.push({ id: "p2", kind: "flag" });
    model.nodes.push({ id: "m1", kind: "mechanic", name: "M", reads: ["p1"], writes: [] });
    renderInspector(model);
    await selectNode("m1");
    await waitFor(() => expect(screen.getByTestId("node-reads")).toBeTruthy());
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("node-reads")).getByLabelText("p2 · flag"));
    });
    const node = useEditorStore.getState().model!.nodes.find((n) => n.id === "m1");
    expect(node?.kind === "mechanic" && node.reads).toEqual(["p1", "p2"]);
  });

  it("rejects duplicate property creation without changing the model or undo history", async () => {
    const model = richModel();
    model.nodes.push({ id: "m1", kind: "mechanic", name: "M", reads: [], writes: [] });
    renderInspector(model);
    await selectNode("m1");
    await waitFor(() => expect(screen.getByTestId("node-reads-new")).toBeTruthy());
    await act(async () => fireEvent.click(screen.getByTestId("node-reads-new")));
    await act(async () => fireEvent.change(screen.getByTestId("node-reads-id"), { target: { value: "p1" } }));
    await act(async () => fireEvent.click(screen.getByTestId("node-reads-create")));
    expect(useEditorStore.getState().model?.properties).toEqual(model.properties);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
  });

  it("clears an optional pool capacity back to undefined", async () => {
    const model = richModel();
    model.nodes.push({ id: "pool1", kind: "pool", name: "Pool", capacity: 10, start: 1 });
    renderInspector(model);
    await selectNode("pool1");
    await waitFor(() => expect(screen.getByTestId("node-capacity")).toBeTruthy());
    await act(async () => fireEvent.change(screen.getByTestId("node-capacity"), { target: { value: "" } }));
    expect(useEditorStore.getState().model?.nodes.find((n) => n.id === "pool1")).toMatchObject({ capacity: undefined });
  });

  it("clears an optional converter activation limit back to undefined", async () => {
    const model = richModel();
    model.nodes.push({ id: "conv1", kind: "converter", name: "Converter", inputs: [], outputs: [], maxActivationsPerStep: 2 });
    renderInspector(model);
    await selectNode("conv1");
    await waitFor(() => expect(screen.getByTestId("node-max-activations")).toBeTruthy());
    await act(async () => fireEvent.change(screen.getByTestId("node-max-activations"), { target: { value: "" } }));
    expect(useEditorStore.getState().model?.nodes.find((n) => n.id === "conv1")).toMatchObject({ maxActivationsPerStep: undefined });
  });
});

/** richModel plus a pool, a drain and a state edge, for the simulation fields. */
function simModel(): Model {
  const model = richModel();
  model.nodes.push(
    { id: "bank", kind: "pool", name: "Bank", start: 0 },
    { id: "tax", kind: "drain", name: "Tax", rate: 1 },
  );
  model.edges.push({ id: "e2", kind: "state", from: "bank", to: "n1", strength: "gate" });
  return model;
}

const nodeIn = (id: string) => useEditorStore.getState().model!.nodes.find((n) => n.id === id)!;
const edgeIn = (id: string) => useEditorStore.getState().model!.edges.find((e) => e.id === id)!;

async function change(testId: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId(testId), { target: { value } });
  });
}

describe("Inspector simulation fields", () => {
  it("edits a pool's activation, act and flow mode, and clears them back to the default", async () => {
    renderInspector(simModel());
    await selectNode("bank");
    await waitFor(() => expect(screen.getByTestId("node-activation")).toBeTruthy());
    await change("node-activation", "interactive");
    await change("node-act", "push");
    await change("node-flow-mode", "all");
    expect(nodeIn("bank")).toMatchObject({ activation: "interactive", act: "push", flowMode: "all" });
    await change("node-activation", "");
    expect(nodeIn("bank").kind === "pool" && nodeIn("bank").activation).toBeUndefined();
    useEditorStore.getState().undo();
    expect(nodeIn("bank")).toMatchObject({ activation: "interactive" });
  });

  it("offers only the choices the schema allows for each kind", async () => {
    renderInspector(simModel());
    await selectNode("n1");
    await waitFor(() => expect(screen.getByTestId("node-activation")).toBeTruthy());
    // A source always pushes all of its rate.
    expect(screen.queryByTestId("node-act")).toBeNull();
    expect(screen.queryByTestId("node-flow-mode")).toBeNull();
    await selectNode("tax");
    await waitFor(() => expect(screen.getByTestId("node-flow-mode")).toBeTruthy());
    expect(screen.queryByTestId("node-act")).toBeNull();
    await selectNode("n2");
    await waitFor(() => expect(screen.queryByTestId("node-activation")).toBeNull());
  });

  it("edits a flow edge's rate, multiplier and delay, and removes them when cleared", async () => {
    renderInspector(simModel());
    await selectEdge("e1");
    await waitFor(() => expect(screen.getByTestId("edge-delay")).toBeTruthy());
    await change("edge-rate", "dice(1, 6)");
    await change("edge-multiplier", "2");
    await change("edge-delay", "3");
    expect(edgeIn("e1")).toMatchObject({ rate: "dice(1, 6)", multiplier: "2", delay: 3 });
    await change("edge-rate", "");
    await change("edge-multiplier", "");
    await change("edge-delay", "");
    expect(edgeIn("e1").rate).toBeUndefined();
    expect(edgeIn("e1").multiplier).toBeUndefined();
    expect(edgeIn("e1").delay).toBeUndefined();
  });

  it("shows a parse error for a bad rate formula", async () => {
    renderInspector(simModel());
    await selectEdge("e1");
    await waitFor(() => expect(screen.getByTestId("edge-rate")).toBeTruthy());
    await change("edge-rate", "1 +");
    expect(screen.getByTestId("formula-error")).toBeTruthy();
  });

  it("gives a state edge a condition formula and a trigger strength, but no delay", async () => {
    renderInspector(simModel());
    await selectEdge("e2");
    await waitFor(() => expect(screen.getByTestId("edge-rate")).toBeTruthy());
    expect(screen.queryByTestId("edge-delay")).toBeNull();
    await change("edge-rate", "self > 5");
    expect(edgeIn("e2").rate).toBe("self > 5");
    await change("edge-strength", "trigger");
    expect(edgeIn("e2").strength).toBe("trigger");
  });
});

describe("Inspector library: model fields", () => {
  const model = (): Model => useEditorStore.getState().model!;

  function libraryModel(): Model {
    return {
      ...richModel(),
      description: "A test model.",
      invariants: [{ id: "solvent", description: "Never broke", expr: "n1 >= 0" }],
      endConditions: [{ id: "rich", description: "Rich enough", expr: "n2 > 10" }],
    };
  }

  it("edits the model name and description, and clearing the description removes it", async () => {
    renderInspector(libraryModel());
    await change("library-model-name", "Renamed");
    expect(model().name).toBe("Renamed");
    await change("library-model-description", "");
    expect("description" in model()).toBe(false);
    act(() => useEditorStore.getState().undo());
    expect(model().description).toBe("A test model.");
  });

  it("edits an invariant's description and formula, removes the optional formula, and removes the invariant", async () => {
    renderInspector(libraryModel());
    await change("invariant-description-solvent", "Stays solvent");
    await change("invariant-expr-solvent", "n1 >");
    expect(within(screen.getByTestId("invariant-list")).getByTestId("formula-error")).toBeTruthy();
    await change("invariant-expr-solvent", "");
    expect(model().invariants).toEqual([{ id: "solvent", description: "Stays solvent" }]);
    await act(async () => fireEvent.click(screen.getByTestId("invariant-remove-solvent")));
    expect(model().invariants).toEqual([]);
    act(() => useEditorStore.getState().undo());
    expect(model().invariants).toHaveLength(1);
  });

  it("creates an invariant only with a valid, unused id and a description", async () => {
    renderInspector(libraryModel());
    await act(async () => fireEvent.click(screen.getByTestId("new-invariant")));
    await change("new-invariant-id", "no-debt");
    await change("new-invariant-description", "No debt");
    await act(async () => fireEvent.click(screen.getByTestId("new-invariant-create")));
    expect(screen.getByTestId("new-invariant-error").textContent).toContain("letters, digits and underscores");
    await change("new-invariant-id", "solvent");
    expect(screen.getByTestId("new-invariant-error").textContent).toContain("taken");
    await change("new-invariant-id", "no_debt");
    await change("new-invariant-expr", "n1 >= 0");
    await act(async () => fireEvent.click(screen.getByTestId("new-invariant-create")));
    expect(model().invariants.map((i) => i.id)).toEqual(["solvent", "no_debt"]);
    expect(model().invariants[1]).toEqual({ id: "no_debt", description: "No debt", expr: "n1 >= 0" });
  });

  it("creates an end condition, which needs a formula, and removing the last one drops the list", async () => {
    renderInspector(libraryModel());
    await act(async () => fireEvent.click(screen.getByTestId("new-end")));
    await change("new-end-id", "done");
    await change("new-end-description", "Done");
    await act(async () => fireEvent.click(screen.getByTestId("new-end-create")));
    expect(screen.getByTestId("new-end-error").textContent).toContain("formula");
    await change("new-end-expr", "n2 > 100");
    await act(async () => fireEvent.click(screen.getByTestId("new-end-create")));
    expect(model().endConditions?.map((e) => e.id)).toEqual(["rich", "done"]);
    await act(async () => fireEvent.click(screen.getByTestId("end-remove-rich")));
    await act(async () => fireEvent.click(screen.getByTestId("end-remove-done")));
    expect("endConditions" in model()).toBe(false);
  });
});

describe("Inspector library: parameters and objectives", () => {
  const model = (): Model => useEditorStore.getState().model!;

  function searchModel(): Model {
    return {
      ...richModel(),
      parameters: [{ id: "pay", description: "Pay per step", value: 2, min: 1, max: 5, integer: true }],
      objectives: [
        { id: "wealth", description: "End wealth", expr: "n2", measure: "final", sense: "max" },
      ],
    };
  }

  it("edits a parameter's fields and shows the schema error next to it", async () => {
    renderInspector(searchModel());
    await change("parameter-description-pay", "Wage");
    await change("parameter-max-pay", "8");
    await act(async () => fireEvent.click(screen.getByTestId("parameter-integer-pay")));
    expect(model().parameters).toEqual([{ id: "pay", description: "Wage", value: 2, min: 1, max: 8 }]);
    expect(screen.queryByTestId("parameter-errors-pay")).toBeNull();
    await change("parameter-value-pay", "9");
    expect(screen.getByTestId("parameter-errors-pay").textContent).toContain("outside [1, 8]");
    act(() => useEditorStore.getState().undo());
    expect(model().parameters?.[0]?.value).toBe(2);
  });

  it("creates a parameter only with an id no node or parameter uses, and removes it", async () => {
    renderInspector(searchModel());
    await act(async () => fireEvent.click(screen.getByTestId("new-parameter")));
    await change("new-parameter-id", "n1");
    await change("new-parameter-description", "Tax");
    await act(async () => fireEvent.click(screen.getByTestId("new-parameter-create")));
    expect(screen.getByTestId("new-parameter-error").textContent).toContain("taken");
    await change("new-parameter-id", "tax");
    await change("new-parameter-value", "20");
    await act(async () => fireEvent.click(screen.getByTestId("new-parameter-create")));
    expect(screen.getByTestId("new-parameter-error").textContent).toContain("between min and max");
    await change("new-parameter-value", "3");
    await act(async () => fireEvent.click(screen.getByTestId("new-parameter-create")));
    expect(model().parameters?.map((p) => p.id)).toEqual(["pay", "tax"]);
    expect(model().parameters?.[1]).toEqual({ id: "tax", description: "Tax", value: 3, min: 0, max: 10 });
    await act(async () => fireEvent.click(screen.getByTestId("parameter-remove-pay")));
    await act(async () => fireEvent.click(screen.getByTestId("parameter-remove-tax")));
    expect("parameters" in model()).toBe(false);
  });

  it("edits an objective's formula, sense and measure, and hides the formula for endStep", async () => {
    renderInspector(searchModel());
    await change("objective-expr-wealth", "n2 +");
    expect(screen.getByTestId("objective-errors-wealth").textContent).toContain("invalid formula");
    await change("objective-expr-wealth", "n2 * 2");
    await change("objective-sense-wealth", "min");
    await change("objective-measure-wealth", "endStep");
    expect(model().objectives).toEqual([
      { id: "wealth", description: "End wealth", expr: "n2 * 2", measure: "endStep", sense: "min" },
    ]);
    expect(screen.queryByTestId("objective-expr-wealth")).toBeNull();
  });

  it("creates objectives, an endStep one without a formula", async () => {
    renderInspector(searchModel());
    await act(async () => fireEvent.click(screen.getByTestId("new-objective")));
    await change("new-objective-id", "steady");
    await change("new-objective-description", "Average wealth");
    await act(async () => fireEvent.click(screen.getByTestId("new-objective-create")));
    expect(screen.getByTestId("new-objective-error").textContent).toContain("formula");
    await change("new-objective-expr", "n2");
    await change("new-objective-measure", "mean");
    await act(async () => fireEvent.click(screen.getByTestId("new-objective-create")));
    await act(async () => fireEvent.click(screen.getByTestId("new-objective")));
    await change("new-objective-id", "quick");
    await change("new-objective-description", "End early");
    await change("new-objective-measure", "endStep");
    await change("new-objective-sense", "min");
    await act(async () => fireEvent.click(screen.getByTestId("new-objective-create")));
    expect(model().objectives?.slice(1)).toEqual([
      { id: "steady", description: "Average wealth", expr: "n2", measure: "mean", sense: "max" },
      { id: "quick", description: "End early", expr: "0", measure: "endStep", sense: "min" },
    ]);
    expect(screen.queryByTestId("validation-errors")).toBeNull();
  });
});

describe("Inspector library: strategies", () => {
  const model = (): Model => useEditorStore.getState().model!;

  function strategyModel(): Model {
    const base = richModel();
    return {
      ...base,
      nodes: [
        ...base.nodes,
        { id: "buy", kind: "source", name: "Buy", rate: 1, activation: "interactive" },
        { id: "sell", kind: "source", name: "Sell", rate: 1, activation: "interactive" },
      ],
      strategies: [
        { id: "trader", description: "Buy low", rules: [{ fire: "buy", when: "n2 < 5" }, { fire: "sell" }] },
      ],
    };
  }

  it("edits a strategy's description, intended flag and actions per step", async () => {
    renderInspector(strategyModel());
    await change("strategy-description-trader", "Buy low, sell high");
    await act(async () => fireEvent.click(screen.getByTestId("strategy-intended-trader")));
    await change("strategy-actions-trader", "2");
    expect(model().strategies?.[0]).toMatchObject({
      description: "Buy low, sell high",
      intended: true,
      actionsPerStep: 2,
    });
    await change("strategy-actions-trader", "0");
    expect(model().strategies?.[0]?.actionsPerStep).toBe(2);
    await change("strategy-actions-trader", "");
    await act(async () => fireEvent.click(screen.getByTestId("strategy-intended-trader")));
    expect(model().strategies?.[0]).toEqual({
      id: "trader",
      description: "Buy low, sell high",
      rules: [{ fire: "buy", when: "n2 < 5" }, { fire: "sell" }],
    });
  });

  it("edits, reorders, adds and removes rules", async () => {
    renderInspector(strategyModel());
    await change("strategy-rule-fire-trader-1", "buy");
    await change("strategy-rule-when-trader-0", "");
    expect(model().strategies?.[0]?.rules).toEqual([{ fire: "buy" }, { fire: "buy" }]);
    await change("strategy-rule-when-trader-1", "n2 >");
    expect(within(screen.getByTestId("strategy-list")).getByTestId("formula-error")).toBeTruthy();
    await change("strategy-rule-when-trader-1", "n2 > 9");
    await act(async () => fireEvent.click(screen.getByTestId("strategy-rule-up-trader-1")));
    expect(model().strategies?.[0]?.rules).toEqual([{ fire: "buy", when: "n2 > 9" }, { fire: "buy" }]);
    await act(async () => fireEvent.click(screen.getByTestId("strategy-rule-add-trader")));
    expect(model().strategies?.[0]?.rules).toHaveLength(3);
    await act(async () => fireEvent.click(screen.getByTestId("strategy-rule-remove-trader-0")));
    expect(model().strategies?.[0]?.rules).toEqual([{ fire: "buy" }, { fire: "buy" }]);
    act(() => useEditorStore.getState().undo());
    expect(model().strategies?.[0]?.rules).toHaveLength(3);
  });

  it("shows a rule's schema error and creates and removes strategies", async () => {
    const withBadRule = strategyModel();
    withBadRule.strategies![0]!.rules.push({ fire: "n1" });
    renderInspector(withBadRule);
    expect(screen.getByTestId("strategy-errors-trader").textContent).toContain("not an interactive node");
    await act(async () => fireEvent.click(screen.getByTestId("new-strategy")));
    await change("new-strategy-id", "trader");
    await change("new-strategy-description", "Another");
    await act(async () => fireEvent.click(screen.getByTestId("new-strategy-create")));
    expect(screen.getByTestId("new-strategy-error").textContent).toContain("taken");
    await change("new-strategy-id", "hoarder");
    await act(async () => fireEvent.click(screen.getByTestId("new-strategy-create")));
    expect(model().strategies?.[1]).toEqual({ id: "hoarder", description: "Another", rules: [] });
    await act(async () => fireEvent.click(screen.getByTestId("strategy-remove-trader")));
    await act(async () => fireEvent.click(screen.getByTestId("strategy-remove-hoarder")));
    expect("strategies" in model()).toBe(false);
  });
});
