import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../src/App.js";
import { useAppStore } from "../src/state/store.js";
import { useEditorStore } from "../src/state/editor.js";
import type { Model, Report } from "@mechflow/core";

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

/** Minimal Response-like object. */
function ok(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

/** Mutable response fixtures the fetch mock reads, so tests can change them. */
const fixtures = {
  models: ["dag.yaml", "economy.yaml", "ring.yaml"],
  modelsResponse: { models: [] as string[] },
  modelsByPath: {} as Record<
    string,
    { model: unknown; errors: string[] | null; hash: string }
  >,
  reportsByPath: {} as Record<string, Report>,
};

function buildReports(): Record<string, Report> {
  return {
    "dag.yaml": {
      modelName: "DAG",
      generatedFrom: "dag-gen",
      summary: { errors: 0, warnings: 0, infos: 0, byCheck: {} },
      findings: [],
      matrix: { ids: [], cells: [] } as unknown as Report["matrix"],
      ghostEdges: [],
    },
    "ring.yaml": {
      modelName: "Ring",
      generatedFrom: "ring-gen",
      summary: { errors: 0, warnings: 2, infos: 0, byCheck: {} },
      findings: [
        {
          id: "feedback-loops:loop-1",
          check: "feedback-loops",
          severity: "warning",
          title: "Feedback loop",
          detail: "a -> b -> a",
          nodes: ["a", "b"],
          edges: ["a_to_b"],
        },
      ],
      matrix: { ids: [], cells: [] } as unknown as Report["matrix"],
      ghostEdges: [],
    },
  };
}

const modelByPath: Record<
  string,
  { model: unknown; errors: string[] | null; hash: string }
> = {
  "dag.yaml": { model: { name: "DAG" }, errors: null, hash: "dag-hash-1" },
  "ring.yaml": { model: { name: "Ring" }, errors: null, hash: "ring-hash-1" },
  "economy.yaml": {
    model: null,
    errors: ["Edge e references node 'missing' which does not exist."],
    hash: "eco-hash-1",
  },
};

/** Fake WebSocket that records instances and lets tests emit server messages. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  private listeners = new Map<string, Set<(event: { data: string }) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (event: { data: string }) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(cb);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, cb: (event: { data: string }) => void): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.closed = true;
  }

  /** Simulate the server broadcasting a message to this client. */
  emit(data: unknown): void {
    for (const cb of this.listeners.get("message") ?? []) cb({ data: JSON.stringify(data) });
  }
}

function clickModel(path: string): void {
  const el = screen
    .getAllByTestId("model-item")
    .find((node) => node.getAttribute("aria-label") === path);
  expect(el).toBeDefined();
  (el as HTMLButtonElement).click();
}

let currentFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fixtures.modelsResponse = { models: fixtures.models };
  fixtures.modelsByPath = modelByPath;
  fixtures.reportsByPath = buildReports();
  FakeWebSocket.instances = [];
  useAppStore.getState().reset();
  useEditorStore.getState().reset();
  vi.unstubAllGlobals();
  currentFetch = vi.fn((url: string) => {
    if (url === "/api/models") return Promise.resolve(ok(fixtures.modelsResponse));
    if (url.endsWith("/report")) {
      const path = url.slice("/api/models/".length, -"/report".length);
      return Promise.resolve(ok(fixtures.reportsByPath[path]));
    }
    const path = url.slice("/api/models/".length);
    return Promise.resolve(ok(fixtures.modelsByPath[path]));
  });
  vi.stubGlobal("fetch", currentFetch);
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  useAppStore.getState().reset();
  useEditorStore.getState().reset();
  vi.unstubAllGlobals();
});

describe("App shell", () => {
  it("lists models from GET /api/models in the sidebar", async () => {
    render(<App />);
    await waitForList();
    const paths = screen.getAllByTestId("model-item").map((el) => el.getAttribute("aria-label"));
    expect(paths).toEqual(["dag.yaml", "economy.yaml", "ring.yaml"]);
  });

  it("opens a model: shows its name, summary, and findings", async () => {
    render(<App />);
    await waitForList();
    clickModel("ring.yaml");

    await waitForName("Ring");
    screen.getByTestId("report-summary");
    expect(screen.getByTestId("summary-warnings").textContent).toBe("! 2");
    await waitFor(() => expect(screen.getAllByTestId("finding")).toHaveLength(1));
    expect(screen.getByTestId("finding").textContent).toContain("Feedback loop");
  });

  it("opens the findings filtered to a severity from its summary badge", async () => {
    render(<App />);
    await waitForList();
    clickModel("ring.yaml");
    await waitForName("Ring");
    expect(screen.getByTestId("dock").getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByTestId("summary-warnings"));
    expect(screen.getByTestId("dock").getAttribute("data-open")).toBe("true");
    expect((screen.getByTestId("filter-severity") as HTMLSelectElement).value).toBe("warning");
    fireEvent.click(screen.getByTestId("summary-infos"));
    expect((screen.getByTestId("filter-severity") as HTMLSelectElement).value).toBe("info");
  });

  it("shows validation errors for an invalid model instead of crashing", async () => {
    render(<App />);
    await waitForList();
    clickModel("economy.yaml");

    await waitFor(() =>
      expect(screen.getByTestId("validation-error")).toBeTruthy(),
    );
    expect(screen.getByTestId("validation-error").textContent).toContain(
      "references node 'missing'",
    );
    screen.getByTestId("open-model");
  });

  it("reloads the open model when a model-changed event arrives over /ws", async () => {
    render(<App />);
    await waitForList();
    clickModel("ring.yaml");
    await waitForName("Ring");

    const sockets = FakeWebSocket.instances.length;
    expect(sockets).toBeGreaterThan(0);

    FakeWebSocket.instances[0]!.emit({
      type: "model-changed",
      path: "ring.yaml",
      hash: "ring-hash-2",
    });

    // The store re-opens the selected model after the change.
    await waitForName("Ring");
    expect(FakeWebSocket.instances.length).toBe(sockets);
  });

  it("ignores a model-changed event for a different model", async () => {
    render(<App />);
    await waitForList();
    clickModel("dag.yaml");
    await waitForName("DAG");

    const callsBefore = currentFetch.mock.calls.length;
    FakeWebSocket.instances[0]!.emit({
      type: "model-changed",
      path: "ring.yaml",
      hash: "ring-hash-2",
    });
    await new Promise((r) => setTimeout(r, 20));
    // The sidebar refreshes, but the open dag model is not reloaded.
    expect(currentFetch.mock.calls.length).toBe(callsBefore + 1);
    expect(currentFetch.mock.calls.at(-1)?.[0]).toBe("/api/models");
  });

  it("loads the opened model into the editor store", async () => {
    render(<App />);
    await waitForList();
    clickModel("ring.yaml");
    await waitForName("Ring");

    const editor = useEditorStore.getState();
    expect(editor.path).toBe("ring.yaml");
    expect(editor.model).toMatchObject({ name: "Ring" });
    expect(editor.dirty).toBe(false);
    expect(editor.undoStack).toHaveLength(0);
  });

  it("shows the inspector in the app and updates the graph after an edit", async () => {
    const model: Model = {
      version: 1, name: "Graph", properties: [], subsystems: [],
      nodes: [{ id: "n1", kind: "source", name: "Old name", rate: 1 }],
      edges: [], noInteraction: [], invariants: [],
    };
    fixtures.modelsByPath = {
      ...fixtures.modelsByPath,
      "dag.yaml": { model, errors: null, hash: "dag-hash-1" },
    };
    render(<App />);
    await waitForList();
    clickModel("dag.yaml");
    await waitFor(() => expect(screen.getByTestId("rf__node-n1")).toBeTruthy());
    expect(screen.getByTestId("inspector")).toBeTruthy();
    const flowStore = (globalThis as {
      __rfStore?: { getState: () => {
        addSelectedNodes: (ids: string[]) => void;
        resetSelectedElements: () => void;
        getNodes: () => { id: string; selected?: boolean }[];
      } };
    }).__rfStore;
    expect(flowStore).toBeDefined();
    await act(async () => flowStore?.getState().addSelectedNodes(["n1"]));
    await waitFor(() => expect(screen.getByTestId("node-name")).toBeTruthy());
    await act(async () => fireEvent.change(screen.getByTestId("node-name"), { target: { value: "New name" } }));
    await waitFor(() => {
      expect(screen.getByTestId("flow-node-source").textContent).toContain("New name");
      expect((screen.getByTestId("node-name") as HTMLInputElement).value).toBe("New name");
      expect(flowStore?.getState().getNodes().find((n) => n.id === "n1")?.selected).toBe(true);
    });
    await act(async () => flowStore?.getState().resetSelectedElements());
    await waitFor(() => expect(screen.getByTestId("library")).toBeTruthy());
  });

  it("can delete the last node and undo without crashing", async () => {
    const model: Model = {
      version: 1, name: "Graph", properties: [], subsystems: [],
      nodes: [{ id: "n1", kind: "source", name: "Only node", rate: 1 }],
      edges: [], noInteraction: [], invariants: [],
    };
    fixtures.modelsByPath = {
      ...fixtures.modelsByPath,
      "dag.yaml": { model, errors: null, hash: "dag-hash-1" },
    };
    render(<App />);
    await waitForList();
    clickModel("dag.yaml");
    await waitFor(() => expect(screen.getByTestId("rf__node-n1")).toBeTruthy());
    const flowStore = (globalThis as {
      __rfStore?: { getState: () => { addSelectedNodes: (ids: string[]) => void } };
    }).__rfStore;
    await act(async () => flowStore?.getState().addSelectedNodes(["n1"]));
    await act(async () => fireEvent.keyDown(window, { key: "Delete" }));
    await waitFor(() => expect(screen.getByTestId("graph-empty")).toBeTruthy());
    expect(screen.getByTestId("palette")).toBeTruthy();
    expect(screen.getByTestId("graph-container")).toBeTruthy();
    expect(useEditorStore.getState().model?.nodes).toHaveLength(0);
    await act(async () => fireEvent.keyDown(window, { key: "z", ctrlKey: true }));
    await waitFor(() => expect(screen.getByTestId("rf__node-n1")).toBeTruthy());
  });

  it("preserves multi-selection through an edit and deletes both nodes", async () => {
    const model: Model = {
      version: 1, name: "Graph", properties: [], subsystems: [],
      nodes: [
        { id: "n1", kind: "source", name: "First", rate: 1 },
        { id: "n2", kind: "source", name: "Second", rate: 2 },
      ],
      edges: [], noInteraction: [], invariants: [],
    };
    fixtures.modelsByPath = {
      ...fixtures.modelsByPath,
      "dag.yaml": { model, errors: null, hash: "dag-hash-1" },
    };
    render(<App />);
    await waitForList();
    clickModel("dag.yaml");
    await waitFor(() => expect(screen.getByTestId("rf__node-n2")).toBeTruthy());
    const flowStore = (globalThis as {
      __rfStore?: {
        setState: (patch: { multiSelectionActive: boolean }) => void;
        getState: () => {
          addSelectedNodes: (ids: string[]) => void;
          getNodes: () => { id: string; selected?: boolean }[];
        };
      };
    }).__rfStore;
    await act(async () => {
      flowStore?.getState().addSelectedNodes(["n1"]);
      flowStore?.setState({ multiSelectionActive: true });
      flowStore?.getState().addSelectedNodes(["n2"]);
    });
    await waitFor(() => expect(flowStore?.getState().getNodes().filter((n) => n.selected).map((n) => n.id)).toEqual(["n1", "n2"]));
    await act(async () => useEditorStore.getState().updateNode("n1", { name: "Renamed" }));
    await waitFor(() => expect(flowStore?.getState().getNodes().filter((n) => n.selected).map((n) => n.id)).toEqual(["n1", "n2"]));
    await act(async () => fireEvent.keyDown(window, { key: "Delete" }));
    expect(useEditorStore.getState().model?.nodes).toHaveLength(0);
  });

  it("keeps an edited edge selected and clears it on deselection", async () => {
    const model: Model = {
      version: 1, name: "Graph", properties: [], subsystems: [],
      nodes: [
        { id: "n1", kind: "source", name: "First", rate: 1 },
        { id: "n2", kind: "drain", name: "Second", rate: 1 },
      ],
      edges: [{ id: "e1", kind: "flow", from: "n1", to: "n2", rate: "1" }],
      noInteraction: [], invariants: [],
    };
    fixtures.modelsByPath = {
      ...fixtures.modelsByPath,
      "dag.yaml": { model, errors: null, hash: "dag-hash-1" },
    };
    render(<App />);
    await waitForList();
    clickModel("dag.yaml");
    await waitFor(() => expect(screen.getByTestId("rf__node-n2")).toBeTruthy());
    const flowStore = (globalThis as {
      __rfStore?: { getState: () => {
        addSelectedEdges: (ids: string[]) => void;
        resetSelectedElements: () => void;
        edges: { id: string; selected?: boolean }[];
      } };
    }).__rfStore;
    await act(async () => flowStore?.getState().addSelectedEdges(["e1"]));
    await waitFor(() => expect(screen.getByTestId("edge-label")).toBeTruthy());
    await act(async () => fireEvent.change(screen.getByTestId("edge-label"), { target: { value: "Transfer" } }));
    await waitFor(() => expect(flowStore?.getState().edges.find((edge) => edge.id === "e1")?.selected).toBe(true));
    await act(async () => flowStore?.getState().resetSelectedElements());
    await waitFor(() => expect(screen.getByTestId("library")).toBeTruthy());
  });

  it("reflects position edits, undo, and redo on the canvas", async () => {
    const model: Model = {
      version: 1, name: "Graph", properties: [], subsystems: [],
      nodes: [{ id: "n1", kind: "source", name: "First", rate: 1,
        position: { x: 10, y: 20, pinned: true } }],
      edges: [], noInteraction: [], invariants: [],
    };
    fixtures.modelsByPath = {
      ...fixtures.modelsByPath,
      "dag.yaml": { model, errors: null, hash: "dag-hash-1" },
    };
    render(<App />);
    await waitForList();
    clickModel("dag.yaml");
    await waitFor(() => expect(screen.getByTestId("rf__node-n1")).toBeTruthy());
    const flowStore = (globalThis as {
      __rfStore?: { getState: () => { getNodes: () => { id: string; position: { x: number; y: number } }[] } };
    }).__rfStore;
    const position = () => flowStore?.getState().getNodes().find((node) => node.id === "n1")?.position;
    await act(async () => useEditorStore.getState().updateNode("n1", { position: { x: 50, y: 60, pinned: true } }));
    await waitFor(() => expect(position()).toEqual({ x: 50, y: 60, pinned: true }));
    await act(async () => useEditorStore.getState().undo());
    await waitFor(() => expect(position()).toEqual({ x: 10, y: 20, pinned: true }));
    await act(async () => useEditorStore.getState().redo());
    await waitFor(() => expect(position()).toEqual({ x: 50, y: 60, pinned: true }));
  });

  it("adds the first node by dragging from the palette onto an empty model", async () => {
    const model: Model = {
      version: 1, name: "Blank", properties: [], subsystems: [],
      nodes: [], edges: [], noInteraction: [], invariants: [],
    };
    fixtures.modelsByPath = {
      ...fixtures.modelsByPath,
      "dag.yaml": { model, errors: null, hash: "dag-hash-1" },
    };
    render(<App />);
    await waitForList();
    clickModel("dag.yaml");
    await waitFor(() => expect(screen.getByTestId("graph-container")).toBeTruthy());
    expect(screen.getByTestId("palette-item-source")).toBeTruthy();
    expect(screen.getByTestId("graph-empty").textContent).toContain("Drag");

    const values = new Map<string, string>();
    const dataTransfer = {
      getData: (kind: string) => values.get(kind) ?? "",
      setData: (kind: string, value: string) => void values.set(kind, value),
      effectAllowed: "copy",
      dropEffect: "copy",
    } as DataTransfer;
    fireEvent.dragStart(screen.getByTestId("palette-item-source"), { dataTransfer });
    const pane = document.querySelector(".react-flow__pane");
    expect(pane).toBeTruthy();
    const dragOver = fireEvent.dragOver(pane!, { dataTransfer });
    expect(dragOver).toBe(false);
    await act(async () => {
      fireEvent.drop(pane!, { dataTransfer, clientX: 120, clientY: 80 });
    });
    await waitFor(() => expect(useEditorStore.getState().model?.nodes).toHaveLength(1));
    const created = useEditorStore.getState().model!.nodes[0]!;
    expect(created).toMatchObject({ kind: "source", position: { pinned: true } });
    await waitFor(() => expect(screen.getByTestId(`rf__node-${created.id}`)).toBeTruthy());
    expect(screen.queryByTestId("graph-empty")).toBeNull();
  });
});

describe("watch reload with unsaved graph edits", () => {
  function graphModel(name: string): Model {
    return {
      version: 1, name, properties: [], subsystems: [],
      nodes: [{ id: "n1", kind: "source", name: "First", rate: 1 }],
      edges: [], noInteraction: [], invariants: [],
    };
  }

  /** Open dag.yaml, rename its node locally, then have the file change on disk. */
  async function editThenRemoteChange(remoteHash: string): Promise<void> {
    fixtures.modelsByPath = {
      ...fixtures.modelsByPath,
      "dag.yaml": { model: graphModel("Local base"), errors: null, hash: "dag-hash-1" },
    };
    render(<App />);
    await waitForList();
    clickModel("dag.yaml");
    await waitFor(() => expect(useEditorStore.getState().hash).toBe("dag-hash-1"));
    await act(async () => useEditorStore.getState().updateNode("n1", { name: "Edited" }));
    fixtures.modelsByPath = {
      ...fixtures.modelsByPath,
      "dag.yaml": { model: graphModel("Remote"), errors: null, hash: remoteHash },
    };
    await act(async () => FakeWebSocket.instances[0]!.emit({
      type: "model-changed", path: "dag.yaml", hash: remoteHash,
    }));
    await waitFor(() => expect(screen.getByTestId("model-name").textContent).toBe("Remote"));
  }

  it("keeps local edits and the loaded hash, and offers Reload", async () => {
    await editThenRemoteChange("dag-hash-2");
    const editor = useEditorStore.getState();
    expect(editor.model?.nodes[0]?.name).toBe("Edited");
    expect(editor.dirty).toBe(true);
    expect(editor.hash).toBe("dag-hash-1");
    expect(screen.getByTestId("graph-conflict")).toBeTruthy();

    await act(async () => fireEvent.click(screen.getByTestId("graph-conflict-reload")));
    expect(useEditorStore.getState().model?.name).toBe("Remote");
    expect(useEditorStore.getState().hash).toBe("dag-hash-2");
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(screen.queryByTestId("graph-conflict")).toBeNull();
  });

  it("Overwrite saves the local edits against the remote hash", async () => {
    await editThenRemoteChange("dag-hash-2");
    const puts: { ifMatch?: string; body: string }[] = [];
    const get = currentFetch.getMockImplementation()!;
    currentFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return get(url, init);
      const headers = init.headers as Record<string, string>;
      puts.push({ ifMatch: headers["if-match"], body: String(init.body) });
      return Promise.resolve(ok({ hash: "dag-hash-3" }));
    });

    await act(async () => fireEvent.click(screen.getByTestId("graph-conflict-overwrite")));
    expect(puts).toHaveLength(1);
    expect(puts[0]!.ifMatch).toBe("dag-hash-2");
    expect(puts[0]!.body).toContain("Edited");
    expect(useEditorStore.getState().hash).toBe("dag-hash-3");
    expect(useEditorStore.getState().dirty).toBe(false);
    expect(screen.queryByTestId("graph-conflict")).toBeNull();
  });

  it("keeps local edits without a banner when the change is our own save", async () => {
    await editThenRemoteChange("dag-hash-1");
    expect(useEditorStore.getState().model?.nodes[0]?.name).toBe("Edited");
    expect(screen.queryByTestId("graph-conflict")).toBeNull();
  });
});

/** Wait until the sidebar has three model items. */
async function waitForList(): Promise<void> {
  await waitFor(() =>
    expect(screen.getAllByTestId("model-item")).toHaveLength(3),
  );
}

/** Wait until the opened model's heading shows `name`. */
async function waitForName(name: string): Promise<void> {
  await waitFor(() =>
    expect(screen.getByTestId("model-name").textContent).toBe(name),
  );
}
