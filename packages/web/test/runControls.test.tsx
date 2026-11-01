import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { readFileSync } from "node:fs";
import { parseModelYaml, type Model } from "@mechflow/core";
import { GraphView } from "../src/graph/GraphView.js";
import { applyRun } from "../src/graph/runLayer.js";
import { toFlow } from "../src/graph/toFlow.js";
import { PLAY_INTERVAL_MS, RunControls } from "../src/graph/RunControls.js";
import { useRunStore } from "../src/state/run.js";

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

/** A mint paying 3 a step into a vault, and a button that adds 10 when fired. */
const model: Model = {
  version: 1,
  name: "Run",
  properties: [],
  subsystems: [],
  nodes: [
    { id: "mint", kind: "source", name: "Mint", rate: 3 },
    { id: "vault", kind: "pool", name: "Vault", start: 5, activation: "passive" },
    { id: "bonus", kind: "source", name: "Bonus", rate: 10, activation: "interactive" },
  ],
  edges: [
    { id: "pay", kind: "flow", from: "mint", to: "vault" },
    { id: "gift", kind: "flow", from: "bonus", to: "vault" },
  ],
  noInteraction: [],
  invariants: [],
};

const stepLabel = (): string => screen.getByTestId("run-step").textContent ?? "";
const vaultAmount = (): string =>
  screen
    .getAllByTestId("pool-amount")
    .map((el) => el.textContent)
    .join();

beforeEach(() => useRunStore.setState(useRunStore.getInitialState(), true));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("run controls", () => {
  it("steps the model in the browser and shows current pool amounts", () => {
    render(<GraphView model={model} />);
    expect(stepLabel()).toBe("Not started");
    expect(vaultAmount()).toBe("5");
    fireEvent.click(screen.getByTestId("run-step-once"));
    expect(stepLabel()).toBe("Step 1");
    expect(vaultAmount()).toBe("8");
    expect(screen.getByTestId("pool-amount").dataset.running).toBe("true");
  });

  it("leaves the run bar off a mechanics-only map, which has nothing to simulate", () => {
    const mechanics = parseModelYaml(
      readFileSync(`${process.cwd()}/../../fixtures/examples/elements.yaml`, "utf8"),
    );
    if (!mechanics.ok) throw new Error("elements.yaml does not parse");
    render(<GraphView model={mechanics.model} />);
    expect(screen.queryByTestId("run-controls")).toBeNull();
  });

  it("runs N steps at once", () => {
    render(<GraphView model={model} />);
    fireEvent.change(screen.getByTestId("run-batch-size"), { target: { value: "4" } });
    fireEvent.click(screen.getByTestId("run-batch"));
    expect(stepLabel()).toBe("Step 4");
    expect(vaultAmount()).toBe("17");
  });

  it("fires an interactive node by hand", () => {
    render(<GraphView model={model} />);
    fireEvent.click(screen.getByTestId("run-fire-bonus"));
    expect(stepLabel()).toBe("Step 1");
    expect(vaultAmount()).toBe("18");
    expect(useRunStore.getState().record?.firedByHand).toEqual(["bonus"]);
  });

  it("plays and pauses", () => {
    vi.useFakeTimers();
    render(<GraphView model={model} />);
    fireEvent.click(screen.getByTestId("run-play"));
    for (let i = 0; i < 3; i++) {
      act(() => {
        vi.advanceTimersByTime(PLAY_INTERVAL_MS);
      });
    }
    expect(stepLabel()).toBe("Step 3");
    fireEvent.click(screen.getByTestId("run-play"));
    act(() => {
      vi.advanceTimersByTime(PLAY_INTERVAL_MS * 3);
    });
    expect(stepLabel()).toBe("Step 3");
  });

  it("resets to the start amounts", () => {
    render(<GraphView model={model} />);
    fireEvent.click(screen.getByTestId("run-step-once"));
    fireEvent.click(screen.getByTestId("run-reset"));
    expect(stepLabel()).toBe("Not started");
    expect(vaultAmount()).toBe("5");
  });

  it("uses the seed and starts over when it changes", () => {
    render(<GraphView model={model} />);
    fireEvent.click(screen.getByTestId("run-step-once"));
    fireEvent.change(screen.getByTestId("run-seed"), { target: { value: "42" } });
    expect(useRunStore.getState().seed).toBe(42);
    expect(stepLabel()).toBe("Not started");
    fireEvent.click(screen.getByTestId("run-step-once"));
    expect(useRunStore.getState().run?.trace.seed).toBe(42);
  });

  it("resets the run when the model is edited", () => {
    function Editable() {
      const [current, setCurrent] = useState(model);
      return (
        <>
          <GraphView model={current} />
          <button
            data-testid="edit-for-test"
            onClick={() =>
              setCurrent({
                ...current,
                nodes: current.nodes.map((n) => (n.id === "vault" ? { ...n, start: 50 } : n)),
              })
            }
          />
        </>
      );
    }
    render(<Editable />);
    fireEvent.click(screen.getByTestId("run-step-once"));
    expect(stepLabel()).toBe("Step 1");
    fireEvent.click(screen.getByTestId("edit-for-test"));
    expect(stepLabel()).toBe("Not started");
    expect(vaultAmount()).toBe("50");
  });

  it("shows why a model cannot run", () => {
    const broken: Model = {
      ...model,
      nodes: [
        ...model.nodes,
        { id: "r1", kind: "register", name: "R1", formula: "r2" },
        { id: "r2", kind: "register", name: "R2", formula: "r1" },
      ],
    };
    render(<GraphView model={broken} />);
    fireEvent.click(screen.getByTestId("run-step-once"));
    expect(screen.getByTestId("run-error").textContent).toContain("registers form a cycle");
  });

  it("shows how a run ended and stops stepping", () => {
    const ending: Model = {
      ...model,
      endConditions: [{ id: "rich", description: "Vault is full", expr: "vault >= 10" }],
    };
    render(<GraphView model={ending} />);
    fireEvent.click(screen.getByTestId("run-step-once"));
    fireEvent.click(screen.getByTestId("run-step-once"));
    expect(screen.getByTestId("run-end").textContent).toBe("Ended at step 2: rich");
    expect((screen.getByTestId("run-step-once") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("applyRun", () => {
  it("marks pool amounts and the edges that moved in the latest step", () => {
    const graph = toFlow(model);
    expect(applyRun(graph, null, null)).toBe(graph);
    const overlaid = applyRun(graph, { vault: 8 }, {
      moved: { pay: 3, gift: 0 },
    } as never);
    expect(overlaid.nodes.find((n) => n.id === "vault")!.data.runAmount).toBe(8);
    expect(overlaid.nodes.find((n) => n.id === "mint")!.data.runAmount).toBeUndefined();
    expect(overlaid.edges.find((e) => e.id === "pay")!.data!.moving).toBe(true);
    expect(overlaid.edges.find((e) => e.id === "gift")!.data!.moving).toBeUndefined();
    expect(overlaid.edges.find((e) => e.id === "pay")!.data!.movedAmount).toBe(3);
  });

  it("marks an edge that wanted resources but moved none as starved", () => {
    const overlaid = applyRun(toFlow(model), { vault: 0 }, {
      moved: { pay: 0 },
      wanted: { pay: 2, gift: 0 },
    } as never);
    expect(overlaid.edges.find((e) => e.id === "pay")!.data!.starved).toBe(true);
    expect(overlaid.edges.find((e) => e.id === "pay")!.data!.moving).toBeUndefined();
    expect(overlaid.edges.find((e) => e.id === "gift")!.data!.starved).toBeUndefined();
  });
});

describe("applyRun state edges", () => {
  const signalling: Model = {
    ...model,
    nodes: [
      { id: "tap", kind: "source", name: "Tap", rate: 1 },
      { id: "tank", kind: "pool", name: "Tank", start: 0 },
      { id: "level", kind: "register", name: "Level", formula: "tank / 2" },
      { id: "spare", kind: "pool", name: "Spare", start: 5 },
    ],
    edges: [
      { id: "fill", kind: "flow", from: "tap", to: "tank" },
      { id: "reads_tank", kind: "state", from: "tank", to: "level", polarity: "+" },
      { id: "reads_spare", kind: "state", from: "spare", to: "level", polarity: "+" },
    ],
  } as Model;

  it("pulses a state edge whose source changed, with the new value", () => {
    const record = { step: 2, amounts: { tank: 2, spare: 5 }, registers: { level: 0.5 }, moved: {}, wanted: {} };
    const previous = { amounts: { tank: 1, spare: 5 }, registers: { level: 0 } };
    const overlaid = applyRun(toFlow(signalling), record.amounts, record as never, previous);
    expect(overlaid.edges.find((e) => e.id === "reads_tank")!.data!.signal).toBe(2);
    expect(overlaid.edges.find((e) => e.id === "reads_spare")!.data!.signal).toBeUndefined();
  });

  it("leaves state edges still before the first step", () => {
    const overlaid = applyRun(toFlow(signalling), { tank: 0, spare: 5 }, null, null);
    expect(overlaid.edges.find((e) => e.id === "reads_tank")!.data!.signal).toBeUndefined();
  });
});

describe("run controls: parameters and overrides", () => {
  it("folds many parameters behind a toggle that counts the changed ones", () => {
    const many: Model = {
      ...model,
      parameters: ["a", "b", "c", "d"].map((id) => ({ id, value: 1, min: 0, max: 5 })),
    } as Model;
    render(<RunControls model={many} />);
    expect(screen.queryByTestId("run-parameters")).toBeNull();
    fireEvent.click(screen.getByTestId("run-parameters-toggle"));
    fireEvent.change(screen.getByTestId("run-param-b"), { target: { value: "3" } });
    expect(screen.getByTestId("run-parameters-toggle").textContent).toContain("1 changed");
    fireEvent.click(screen.getByTestId("run-parameters-toggle"));
    expect(screen.queryByTestId("run-parameters")).toBeNull();
  });

  const boundary = (): Model => {
    const parsed = parseModelYaml(
      readFileSync(`${process.cwd()}/../../fixtures/examples/boundary.yaml`, "utf8"),
    );
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    return parsed.model;
  };
  const army = (): string => screen.getByTestId("pool-amount").textContent ?? "";

  it("runs with the parameter values typed into the controls", () => {
    render(<GraphView model={boundary()} />);
    const recruits = screen.getByTestId("run-param-recruits") as HTMLInputElement;
    expect(recruits.value).toBe("2");
    fireEvent.click(screen.getByTestId("run-step-once"));
    expect(army()).toBe("40");
    fireEvent.change(recruits, { target: { value: "5" } });
    fireEvent.change(screen.getByTestId("run-param-training"), { target: { value: "5" } });
    // Changing a parameter starts the run over.
    expect(stepLabel()).toBe("Not started");
    fireEvent.click(screen.getByTestId("run-step-once"));
    // 25 recruited, 16 paid in upkeep.
    expect(army()).toBe("49");
    expect(useRunStore.getState().parameters).toEqual({ recruits: 5, training: 5 });
  });

  it("ignores values outside the parameter's range or not whole", () => {
    render(<GraphView model={boundary()} />);
    fireEvent.change(screen.getByTestId("run-param-recruits"), { target: { value: "9" } });
    fireEvent.change(screen.getByTestId("run-param-recruits"), { target: { value: "2.5" } });
    expect(useRunStore.getState().parameters).toEqual({});
    // Typing the model's own value back stores no change.
    fireEvent.change(screen.getByTestId("run-param-recruits"), { target: { value: "3" } });
    fireEvent.change(screen.getByTestId("run-param-recruits"), { target: { value: "2" } });
    expect(useRunStore.getState().parameters).toEqual({});
  });

  it("shows loaded overrides, runs with them, and clears them", () => {
    render(<GraphView model={boundary()} />);
    expect(screen.queryByTestId("run-overrides")).toBeNull();
    act(() =>
      useRunStore.getState().loadSetting({
        strategy: null,
        parameters: { recruits: 4 },
        overrides: { "nodes.army.start": 100 },
      }),
    );
    expect(screen.getByTestId("run-overrides").textContent).toContain("nodes.army.start = 100");
    expect((screen.getByTestId("run-param-recruits") as HTMLInputElement).value).toBe("4");
    fireEvent.click(screen.getByTestId("run-step-once"));
    // 8 recruited, 8 paid: the army stays at its overridden start.
    expect(army()).toBe("100");
    fireEvent.click(screen.getByTestId("run-overrides-clear"));
    expect(screen.queryByTestId("run-overrides")).toBeNull();
    fireEvent.click(screen.getByTestId("run-step-once"));
    expect(army()).toBe("40");
  });
});

describe("run tokens and pool dots", () => {
  it("draws a small pool as dots and a large one as a number", () => {
    render(<GraphView model={model} />);
    const pool = screen.getByTestId("pool-amount");
    expect(pool.dataset.dots).toBe("5");
    expect(pool.querySelectorAll("[aria-hidden]").length).toBe(5);
    fireEvent.change(screen.getByTestId("run-batch-size"), { target: { value: "4" } });
    fireEvent.click(screen.getByTestId("run-batch"));
    expect(screen.getByTestId("pool-amount").dataset.dots).toBeUndefined();
    expect(screen.getByTestId("pool-amount").textContent).toBe("17");
  });
});
