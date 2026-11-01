import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useEditorStore,
  ConflictError,
  addNodeCommand,
  addEdgeCommand,
  addPropertyCommand,
  addSubsystemCommand,
  addNoInteractionCommand,
  removeNodeCommand,
  previousValues,
  updateNodeCommand,
  type ModelCommand,
} from "../src/state/editor.js";
import { serializeModelYaml } from "@mechflow/core";
import type { Edge, Model, Node, Property } from "@mechflow/core";

/** A minimal, well-formed model the analysis runs over without crashing. */
function makeModel(): Model {
  return {
    version: 1,
    name: "Test",
    description: "A test model",
    properties: [{ id: "p1", kind: "number" }],
    subsystems: [{ id: "s1", name: "Sub", tier: "core" }],
    nodes: [
      { id: "n1", kind: "source", name: "N1", rate: 1 },
      { id: "n2", kind: "drain", name: "N2", rate: 1 },
    ],
    edges: [{ id: "e1", kind: "flow", from: "n1", to: "n2", rate: "1" }],
    noInteraction: [],
    invariants: [],
  };
}

function gate(id: string, name: string): Node {
  return { id, kind: "gate", name, mode: "random" };
}

interface FakeResponse {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function fakeResponse(status: number, body: unknown): FakeResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/** Record calls and return a queue of canned responses. */
function fakeFetch(...responses: FakeResponse[]): typeof fetch {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let i = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[i++] ?? fakeResponse(500, { error: "no canned response" });
    next.url = String(url);
    next.init = init ?? {};
    return next;
  }) as unknown as typeof fetch;
  (fn as unknown as { calls: Array<{ url: string; init: RequestInit }> }).calls = calls;
  return fn as typeof fetch & {
    calls: Array<{ url: string; init: RequestInit }>;
  };
}

function loadTestModel(): void {
  useEditorStore.getState().load("m.yaml", makeModel(), "hash-1");
}

afterEach(() => {
  useEditorStore.getState().reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("command factories", () => {
  it("addNodeCommand applies immutably and reverts exactly", () => {
    const model = makeModel();
    const before = model.nodes;
    const cmd: ModelCommand = addNodeCommand(gate("g1", "G1"));
    const next = cmd.apply(model);

    expect(next).not.toBe(model);
    expect(next.nodes).toHaveLength(before.length + 1);
    expect(next.nodes[next.nodes.length - 1]).toEqual(gate("g1", "G1"));
    // Original untouched.
    expect(model.nodes).toBe(before);

    // Undo restores the prior content (filter preserves order for an add).
    expect(cmd.revert(next).nodes).toEqual(model.nodes);
    // Redo re-applies.
    expect(cmd.apply(cmd.revert(next)).nodes).toEqual(next.nodes);
  });

  it("removeNodeCommand captures the removed node for exact revert", () => {
    const model = makeModel();
    const removed = model.nodes[0]!;
    const cmd = removeNodeCommand(removed);
    const next = cmd.apply(model);
    expect(next.nodes).toHaveLength(1);
    // Revert re-adds the removed node; content is restored regardless of order.
    expect(cmd.revert(next).nodes.map((n) => n.id).sort()).toEqual(
      model.nodes.map((n) => n.id).sort(),
    );
  });

  it("updateNodeCommand applies a patch and reverts to previous values", () => {
    const model = makeModel();
    const previous = { name: "N1" };
    const cmd = updateNodeCommand("n1", { name: "Renamed" }, previous);
    const next = cmd.apply(model);
    expect(next.nodes[0]).toMatchObject({ name: "Renamed", kind: "source" });
    const reverted = cmd.revert(next);
    expect(reverted.nodes[0]).toMatchObject({ name: "N1", kind: "source" });
  });

  it("addEdgeCommand / removeEdgeCommand round-trip", () => {
    const model = makeModel();
    const edge: Edge = { id: "e2", kind: "state", from: "n2", to: "n1", rate: "1" };
    const added = addEdgeCommand(edge).apply(model);
    expect(added.edges).toHaveLength(2);
    expect(addEdgeCommand(edge).revert(added).edges).toEqual(model.edges);
  });

  it("addPropertyCommand / removePropertyCommand round-trip", () => {
    const model = makeModel();
    const property: Property = { id: "p2", kind: "flag" };
    const cmd = addPropertyCommand(property);
    const added = cmd.apply(model);
    expect(added.properties).toHaveLength(2);
    expect(cmd.revert(added).properties).toEqual(model.properties);
  });

  it("addSubsystemCommand / removeSubsystemCommand round-trip", () => {
    const model = makeModel();
    const subsystem = { id: "s2", name: "More", tier: "flavor" as const };
    const added = addSubsystemCommand(subsystem).apply(model);
    expect(added.subsystems).toHaveLength(2);
    expect(addSubsystemCommand(subsystem).revert(added).subsystems).toEqual(
      model.subsystems,
    );
  });

  it("addNoInteractionCommand / removeNoInteractionCommand round-trip", () => {
    const model = makeModel();
    const ni = { a: "n1", b: "n2", reason: "intentional" };
    const added = addNoInteractionCommand(ni).apply(model);
    expect(added.noInteraction).toEqual([ni]);
    expect(addNoInteractionCommand(ni).revert(added).noInteraction).toEqual(
      model.noInteraction,
    );
  });

  it("previousValues captures only the patched fields", () => {
    const node = makeModel().nodes[0]!;
    const previous = previousValues(node, { name: "X", rate: 9 });
    expect(previous).toEqual({ name: "N1", rate: 1 });
    expect(previous).not.toHaveProperty("kind");
  });
});

describe("editor store", () => {
  it("applyCommand marks dirty, pushes undo, clears redo", () => {
    loadTestModel();
    expect(useEditorStore.getState().dirty).toBe(false);

    useEditorStore.getState().addNode(gate("g1", "G1"));
    expect(useEditorStore.getState().dirty).toBe(true);
    expect(useEditorStore.getState().model?.nodes).toHaveLength(3);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
  });

  it("undo and redo walk the stacks", () => {
    loadTestModel();
    useEditorStore.getState().addNode(gate("g1", "G1"));
    useEditorStore.getState().addNode(gate("g2", "G2"));
    expect(useEditorStore.getState().model?.nodes).toHaveLength(4);

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model?.nodes).toHaveLength(3);
    expect(useEditorStore.getState().undoStack).toHaveLength(1);
    expect(useEditorStore.getState().redoStack).toHaveLength(1);

    useEditorStore.getState().redo();
    expect(useEditorStore.getState().model?.nodes).toHaveLength(4);
    expect(useEditorStore.getState().undoStack).toHaveLength(2);
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
  });

  it("a new edit after undo clears the redo stack", () => {
    loadTestModel();
    useEditorStore.getState().addNode(gate("g1", "G1"));
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().redoStack).toHaveLength(1);

    useEditorStore.getState().addNode(gate("g2", "G2"));
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
  });

  it("load resets stacks, dirty, and hash", () => {
    loadTestModel();
    useEditorStore.getState().addNode(gate("g1", "G1"));
    expect(useEditorStore.getState().dirty).toBe(true);

    useEditorStore.getState().load("other.yaml", makeModel(), "hash-2");
    expect(useEditorStore.getState().path).toBe("other.yaml");
    expect(useEditorStore.getState().hash).toBe("hash-2");
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().undoStack).toHaveLength(0);
    expect(useEditorStore.getState().redoStack).toHaveLength(0);
  });

  it("updateNode computes its own previous snapshot and reverts correctly", () => {
    loadTestModel();
    useEditorStore.getState().updateNode("n1", { name: "Renamed" });
    expect(useEditorStore.getState().model?.nodes[0]).toMatchObject({
      name: "Renamed",
      kind: "source",
    });

    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model?.nodes[0]).toMatchObject({
      name: "N1",
      kind: "source",
    });
  });

  it("removeNode by id removes and undo restores it", () => {
    loadTestModel();
    useEditorStore.getState().removeNode("n2");
    expect(useEditorStore.getState().model?.nodes).toHaveLength(1);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().model?.nodes).toHaveLength(2);
  });
});

describe("debounced re-analysis", () => {
  it("analyzes once, 200 ms after edits, on the latest model", () => {
    vi.useFakeTimers();
    const deliver = vi.fn(() => {});
    useEditorStore.getState().setReportSink((report) => {
      deliver(report);
    });
    loadTestModel();

    // Edits schedule (but do not yet run) an analysis.
    useEditorStore.getState().addNode(gate("g1", "G1"));
    useEditorStore.getState().addNode(gate("g2", "G2"));
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(199);
    expect(deliver).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].modelName).toBe("Test");
  });

  it("load cancels a pending analysis", () => {
    vi.useFakeTimers();
    const deliver = vi.fn(() => {});
    useEditorStore.getState().setReportSink(deliver);
    loadTestModel();
    useEditorStore.getState().addNode(gate("g1", "G1"));
    // A new load before the timer fires cancels it.
    useEditorStore.getState().load("other.yaml", makeModel(), "h2");
    vi.advanceTimersByTime(500);
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("save", () => {
  it("serializes the model and PUTs it with the loaded If-Match hash", async () => {
    const fetchImpl = fakeFetch(
      fakeResponse(200, { ok: true, model: {}, hash: "hash-2" }),
    ) as unknown as typeof fetch;
    const calls = (fetchImpl as unknown as { calls: Array<{ url: string; init: RequestInit }> })
      .calls;

    loadTestModel();
    useEditorStore.getState().addNode(gate("g1", "G1"));
    await useEditorStore.getState().save(fetchImpl);

    expect(calls[0].url).toBe("/api/models/m.yaml");
    expect(calls[0].init.method).toBe("PUT");
    expect((calls[0].init.headers as Record<string, string>)["if-match"]).toBe(
      "hash-1",
    );
    expect(calls[0].init.body).toBe(serializeModelYaml(useEditorStore.getState().model!));

    // Success clears dirty and refreshes the hash.
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(useEditorStore.getState().hash).toBe("hash-2");
  });

  it("propagates ConflictError and leaves the model dirty on a 409", async () => {
    const fetchImpl = fakeFetch(
      fakeResponse(409, {
        conflict: true,
        loaded: "hash-1",
        hash: "hash-remote",
        yaml: "name: Remote",
      }),
    ) as unknown as typeof fetch;

    loadTestModel();
    useEditorStore.getState().addNode(gate("g1", "G1"));

    await expect(useEditorStore.getState().save(fetchImpl)).rejects.toBeInstanceOf(
      ConflictError,
    );
    expect(useEditorStore.getState().dirty).toBe(true);
    expect(useEditorStore.getState().hash).toBe("hash-1");
  });

  it("throws when there is no model open", async () => {
    const fetchImpl = fakeFetch(fakeResponse(200, { ok: true, hash: "h" }));
    await expect(useEditorStore.getState().save(fetchImpl)).rejects.toThrow(
      /no model open/,
    );
  });
});
