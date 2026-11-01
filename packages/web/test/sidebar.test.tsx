import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { parseModelYaml, serializeModelYaml, type Model } from "@mechflow/core";
import { App } from "../src/App.js";
import { useAppStore } from "../src/state/store.js";
import { useEditorStore } from "../src/state/editor.js";

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

class FakeWebSocket {
  static instance: FakeWebSocket;
  private listener?: (event: { data: string }) => void;
  constructor() { FakeWebSocket.instance = this; }
  addEventListener(_type: string, listener: (event: { data: string }) => void): void { this.listener = listener; }
  removeEventListener(): void { this.listener = undefined; }
  close(): void {}
  emit(data: unknown): void { this.listener?.({ data: JSON.stringify(data) }); }
}

const initial: Model = {
  version: 1, name: "Existing", properties: [], subsystems: [], nodes: [],
  edges: [], noInteraction: [], invariants: [],
};
let files: Map<string, string>;
let calls: { path: string; method: string; headers: Headers }[];
let failNextModelFetch = false;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  files = new Map([["existing.yaml", serializeModelYaml(initial)]]);
  calls = [];
  failNextModelFetch = false;
  useAppStore.getState().reset();
  useEditorStore.getState().reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ path: url, method, headers });
    if (url.startsWith("/api/archive")) {
      if (method === "GET") return { ok: true, status: 200, blob: async () => new Blob(["zip"]) } as Response;
      files.set("Other/Economy/imported.yaml", serializeModelYaml(initial));
      return json({ path: "Other/Economy" }, 201);
    }
    if (url === "/api/models") return json({ models: [...files.keys()].sort() });
    const rest = decodeURIComponent(url.slice("/api/models/".length));
    if (method === "GET" && failNextModelFetch && !rest.endsWith("/report")) {
      failNextModelFetch = false;
      return json({ error: "temporary failure" }, 503);
    }
    if (rest.endsWith("/report")) {
      return json({ modelName: "Test", generatedFrom: "test", findings: [],
        summary: { errors: 0, warnings: 0, infos: 0, byCheck: {} },
        matrix: { ids: [], cells: [] }, ghostEdges: [] });
    }
    if (rest.endsWith("/rename") && method === "POST") {
      const source = rest.slice(0, -"/rename".length);
      const destination = (JSON.parse(String(init?.body)) as { path: string }).path;
      const yaml = files.get(source);
      if (!yaml || files.has(destination)) return json({ error: "conflict" }, 409);
      files.delete(source);
      files.set(destination, yaml);
      return json({ ok: true, path: destination });
    }
    if (method === "DELETE") {
      files.delete(rest);
      return json({ ok: true });
    }
    if (method === "PUT") {
      if (headers.get("if-none-match") === "*" && files.has(rest)) return json({ error: "exists" }, 409);
      const yaml = String(init?.body);
      const parsed = parseModelYaml(yaml);
      if (!parsed.ok) return json({ errors: parsed.errors }, 422);
      const current = files.get(rest);
      const expected = headers.get("if-match");
      if (current && expected && expected !== `hash-${current.length}`) {
        return json({ conflict: true, loaded: expected, hash: `hash-${current.length}`, yaml: current }, 409);
      }
      files.set(rest, yaml);
      return json({ ok: true, model: parsed.model, hash: `hash-${yaml.length}` });
    }
    const yaml = files.get(rest);
    if (!yaml) return json({ error: "not found" }, 404);
    const parsed = parseModelYaml(yaml);
    return json({ yaml, model: parsed.ok ? parsed.model : null,
      errors: parsed.ok ? null : parsed.errors, hash: `hash-${yaml.length}` });
  }));
});

afterEach(() => {
  useAppStore.getState().reset();
  useEditorStore.getState().reset();
  vi.unstubAllGlobals();
});

describe("model sidebar", () => {
  it("exports a game or folder and imports a folder ZIP into the chosen game", async () => {
    files.set("ChainShot/Economy/gold.yaml", serializeModelYaml(initial));
    files.set("Other/base.yaml", serializeModelYaml(initial));
    const previousHash = window.location.hash;
    window.location.hash = "#/ChainShot";
    const previousCreate = URL.createObjectURL;
    const previousRevoke = URL.revokeObjectURL;
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:archive"), revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<App />);
      await screen.findByLabelText("ChainShot/Economy/gold.yaml");
      fireEvent.click(screen.getByLabelText("Export game ChainShot"));
      await waitFor(() => expect(calls.some((call) => call.path === "/api/archive?path=ChainShot&kind=game")).toBe(true));
      fireEvent.click(screen.getByLabelText("Export folder ChainShot/Economy"));
      await waitFor(() => expect(calls.some((call) => call.path === "/api/archive?path=ChainShot%2FEconomy&kind=folder")).toBe(true));
      fireEvent.click(screen.getByText("Import ZIP"));
      fireEvent.change(screen.getByLabelText("Choose ZIP archive"), { target: { files: [new File(["zip"], "Economy.zip", { type: "application/zip" })] } });
      fireEvent.change(screen.getByLabelText("Import destination"), { target: { value: "Other" } });
      fireEvent.click(screen.getByText("Import"));
      await screen.findByLabelText("Other/Economy/imported.yaml");
      expect(calls.some((call) => call.path === "/api/archive?game=Other" && call.method === "POST")).toBe(true);
      expect((screen.getByTestId("game-picker") as HTMLSelectElement).value).toBe("Other");
    } finally {
      click.mockRestore();
      window.location.hash = previousHash;
      if (previousCreate) URL.createObjectURL = previousCreate;
      else delete (URL as { createObjectURL?: typeof URL.createObjectURL }).createObjectURL;
      if (previousRevoke) URL.revokeObjectURL = previousRevoke;
      else delete (URL as { revokeObjectURL?: typeof URL.revokeObjectURL }).revokeObjectURL;
    }
  });

  it("creates a valid empty model and opens its canvas", async () => {
    render(<App />);
    await screen.findByLabelText("existing.yaml");
    fireEvent.change(screen.getByTestId("new-model-name"), { target: { value: "My New Model" } });
    fireEvent.click(screen.getByTestId("create-model"));
    await waitFor(() => expect(screen.getByTestId("model-path").textContent).toBe("my-new-model.yaml"));
    expect(screen.getByTestId("graph-empty")).toBeTruthy();
    expect(parseModelYaml(files.get("my-new-model.yaml")!).ok).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/my-new-model.yaml") &&
      call.headers.get("if-none-match") === "*")).toBe(true);
  });

  it("renames and deletes a model using its loaded hash", async () => {
    vi.stubGlobal("confirm", vi.fn(() => true));
    render(<App />);
    await screen.findByLabelText("existing.yaml");
    fireEvent.click(screen.getByLabelText("Rename existing.yaml"));
    fireEvent.change(screen.getByLabelText("New name for existing.yaml"),
      { target: { value: "renamed" } });
    fireEvent.click(screen.getByText("Save name"));
    await screen.findByLabelText("renamed.yaml");
    expect(files.has("existing.yaml")).toBe(false);
    fireEvent.click(screen.getByLabelText("Delete renamed.yaml"));
    await waitFor(() => expect(files.has("renamed.yaml")).toBe(false));
    expect(calls.filter((call) => ["POST", "DELETE"].includes(call.method))
      .every((call) => call.headers.has("if-match"))).toBe(true);
  });

  it("validates YAML, saves valid edits, and opens invalid source files", async () => {
    files.set("broken.yaml", "version: 1\nname: Broken\n");
    render(<App />);
    await screen.findByLabelText("broken.yaml");
    fireEvent.click(screen.getByLabelText("broken.yaml"));
    await screen.findByTestId("open-model");
    expect(screen.getByTestId("validation-errors")).toBeTruthy();
    fireEvent.click(screen.getByTestId("yaml-tab"));
    expect((screen.getByTestId("yaml-source") as HTMLTextAreaElement).value).toContain("Broken");
    fireEvent.change(screen.getByTestId("yaml-source"), { target: { value: "not: a model" } });
    fireEvent.click(screen.getByTestId("save-yaml"));
    await screen.findByTestId("yaml-errors");
    expect(files.get("broken.yaml")).toContain("Broken");
    fireEvent.change(screen.getByTestId("yaml-source"),
      { target: { value: serializeModelYaml({ ...initial, name: "Repaired" }) } });
    fireEvent.click(screen.getByTestId("save-yaml"));
    await waitFor(() => expect(screen.getByTestId("model-name").textContent).toBe("Repaired"));
    expect(screen.getByTestId("graph-empty")).toBeTruthy();
  });

  it("preserves an edited YAML draft on a concurrent change until overwrite is chosen", async () => {
    render(<App />);
    await screen.findByLabelText("existing.yaml");
    fireEvent.click(screen.getByLabelText("existing.yaml"));
    await screen.findByTestId("open-model");
    fireEvent.click(screen.getByTestId("yaml-tab"));
    const draft = serializeModelYaml({ ...initial, name: "Local" });
    fireEvent.change(screen.getByTestId("yaml-source"), { target: { value: draft } });
    files.set("existing.yaml", serializeModelYaml({ ...initial, name: "Remote change" }));
    FakeWebSocket.instance.emit({ type: "model-changed", path: "existing.yaml", hash: "remote" });
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/models/existing.yaml" && call.method === "GET").length).toBeGreaterThan(1));
    expect((screen.getByTestId("yaml-source") as HTMLTextAreaElement).value).toBe(draft);
    fireEvent.click(screen.getByTestId("save-yaml"));
    await screen.findByTestId("yaml-conflict");
    expect((screen.getByTestId("yaml-source") as HTMLTextAreaElement).value).toBe(draft);
    expect(files.get("existing.yaml")).toContain("Remote change");
    fireEvent.click(screen.getByText("Overwrite"));
    await waitFor(() => expect(files.get("existing.yaml")).toBe(draft));
  });

  it("keeps inherited graph edits on a YAML conflict and blocks model management", async () => {
    render(<App />);
    await screen.findByLabelText("existing.yaml");
    fireEvent.click(screen.getByLabelText("existing.yaml"));
    await screen.findByTestId("open-model");
    await act(async () => useEditorStore.getState().applyCommand({
      apply: (model) => ({ ...model, name: "Graph edit" }),
      revert: (model) => ({ ...model, name: "Existing" }),
    }));
    fireEvent.click(screen.getByTestId("yaml-tab"));
    expect((screen.getByTestId("yaml-source") as HTMLTextAreaElement).value).toContain("Graph edit");
    fireEvent.click(screen.getByLabelText("Rename existing.yaml"));
    fireEvent.change(screen.getByLabelText("New name for existing.yaml"),
      { target: { value: "lost" } });
    fireEvent.click(screen.getByText("Save name"));
    await screen.findByTestId("management-error");
    expect(files.has("existing.yaml")).toBe(true);
    files.set("existing.yaml", serializeModelYaml({ ...initial, name: "Remote change" }));
    fireEvent.click(screen.getByTestId("save-yaml"));
    await screen.findByTestId("yaml-conflict");
    expect((screen.getByTestId("yaml-source") as HTMLTextAreaElement).value).toContain("Graph edit");
  });

  it("keeps the original hash when returning to YAML after a watch event", async () => {
    render(<App />);
    await screen.findByLabelText("existing.yaml");
    fireEvent.click(screen.getByLabelText("existing.yaml"));
    await screen.findByTestId("open-model");
    await act(async () => useEditorStore.getState().applyCommand({
      apply: (model) => ({ ...model, name: "Local graph" }),
      revert: (model) => ({ ...model, name: "Existing" }),
    }));
    fireEvent.click(screen.getByTestId("yaml-tab"));
    files.set("existing.yaml", serializeModelYaml({ ...initial, name: "Remote graph" }));
    FakeWebSocket.instance.emit({ type: "model-changed", path: "existing.yaml", hash: "remote" });
    await waitFor(() => expect(calls.filter((call) => call.path === "/api/models/existing.yaml" && call.method === "GET").length).toBeGreaterThan(1));
    fireEvent.click(screen.getByTestId("graph-tab"));
    fireEvent.click(screen.getByTestId("yaml-tab"));
    fireEvent.click(screen.getByTestId("save-yaml"));
    await screen.findByTestId("yaml-conflict");
    expect(files.get("existing.yaml")).toContain("Remote graph");
  });

  it("allows creation after the watched model is removed", async () => {
    render(<App />);
    await screen.findByLabelText("existing.yaml");
    fireEvent.click(screen.getByLabelText("existing.yaml"));
    await screen.findByTestId("open-model");
    fireEvent.click(screen.getByTestId("yaml-tab"));
    fireEvent.change(screen.getByTestId("yaml-source"), { target: { value: "changed" } });
    files.delete("existing.yaml");
    FakeWebSocket.instance.emit({ type: "model-removed", path: "existing.yaml" });
    await screen.findByTestId("no-model");
    fireEvent.change(screen.getByTestId("new-model-name"), { target: { value: "Replacement" } });
    fireEvent.click(screen.getByTestId("create-model"));
    await waitFor(() => expect(files.has("replacement.yaml")).toBe(true));
  });

  it("keeps a YAML draft when a background reload fails", async () => {
    render(<App />);
    await screen.findByLabelText("existing.yaml");
    fireEvent.click(screen.getByLabelText("existing.yaml"));
    await screen.findByTestId("open-model");
    fireEvent.click(screen.getByTestId("yaml-tab"));
    const draft = serializeModelYaml({ ...initial, name: "Unsent" });
    fireEvent.change(screen.getByTestId("yaml-source"), { target: { value: draft } });
    failNextModelFetch = true;
    FakeWebSocket.instance.emit({ type: "model-changed", path: "existing.yaml", hash: "remote" });
    await screen.findByTestId("load-error");
    expect((screen.getByTestId("yaml-source") as HTMLTextAreaElement).value).toBe(draft);
    expect(screen.getByTestId("open-model")).toBeTruthy();
  });
});
