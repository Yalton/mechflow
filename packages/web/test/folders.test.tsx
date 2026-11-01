import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { serializeModelYaml, type Model } from "@mechflow/core";
import { App } from "../src/App.js";
import { useAppStore } from "../src/state/store.js";
import { useEditorStore } from "../src/state/editor.js";
import { allFolders, cleanFolderName, gameFromHash, gamesOf, hashForGame, treeOf } from "../src/folders.js";

describe("folder helpers", () => {
  const models = ["GameA/Economy/graph.yaml", "GameA/loose.yaml", "GameB/Economy/graph.yaml", "root.yaml"];

  it("lists each top-level folder as a game, the top level first when models sit there", () => {
    expect(gamesOf(models, ["GameC"])).toEqual(["", "GameA", "GameB", "GameC"]);
    expect(gamesOf(["GameA/x.yaml"])).toEqual(["GameA"]);
  });

  it("derives folders from model paths as well as from the server's list", () => {
    expect(allFolders(["A/B/C/m.yaml"], ["Z"])).toEqual(["A", "A/B", "A/B/C", "Z"]);
  });

  it("builds one game's tree, keeping same-named models in other games out", () => {
    const tree = treeOf("GameA", models, ["GameA/Empty"]);
    expect(tree.models).toEqual(["GameA/loose.yaml"]);
    expect(tree.folders.map((f) => f.path)).toEqual(["GameA/Economy", "GameA/Empty"]);
    expect(tree.folders[0]!.models).toEqual(["GameA/Economy/graph.yaml"]);
    expect(treeOf("", models).models).toEqual(["root.yaml"]);
    expect(treeOf("", models).folders).toEqual([]);
  });

  it("round-trips a game through the location hash", () => {
    expect(gameFromHash(hashForGame("My Game"))).toBe("My Game");
    expect(gameFromHash("")).toBeNull();
  });

  it("rejects folder names with slashes or a leading dot", () => {
    expect(cleanFolderName("  Economy ")).toBe("Economy");
    expect(cleanFolderName("a/b")).toBeNull();
    expect(cleanFolderName(".hidden")).toBeNull();
    expect(cleanFolderName("  ")).toBeNull();
  });
});

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= ResizeObserverPolyfill;

class FakeWebSocket {
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

const empty: Model = {
  version: 1, name: "Graph", properties: [], subsystems: [], nodes: [],
  edges: [], noInteraction: [], invariants: [],
};
let files: Map<string, string>;
let folders: Set<string>;

function json(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  window.location.hash = "";
  const yaml = serializeModelYaml(empty);
  files = new Map([
    ["GameA/Economy/graph.yaml", yaml],
    ["GameB/Economy/graph.yaml", yaml],
    ["GameB/Combat/fight.yaml", yaml],
  ]);
  folders = new Set(["GameA", "GameA/Economy", "GameB", "GameB/Economy", "GameB/Combat"]);
  useAppStore.getState().reset();
  useEditorStore.getState().reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/models") return json({ models: [...files.keys()].sort(), folders: [...folders].sort() });
    if (url === "/api/folders/rename") {
      const { path, to } = JSON.parse(String(init?.body)) as { path: string; to: string };
      if (folders.has(to)) return json({ error: "destination already exists" }, 409);
      const moved = (p: string) => (p === path || p.startsWith(`${path}/`) ? `${to}${p.slice(path.length)}` : p);
      folders = new Set([...folders].map(moved));
      files = new Map([...files].map(([k, v]) => [moved(k), v]));
      return json({ ok: true, path: to });
    }
    if (url === "/api/folders/delete") {
      const { path } = JSON.parse(String(init?.body)) as { path: string };
      if ([...files.keys()].some((k) => k.startsWith(`${path}/`))) return json({ error: "folder not empty" }, 409);
      folders = new Set([...folders].filter((f) => f !== path && !f.startsWith(`${path}/`)));
      return json({ ok: true });
    }
    if (url === "/api/folders") {
      const path = (JSON.parse(String(init?.body)) as { path: string }).path;
      if (folders.has(path)) return json({ error: "folder already exists" }, 409);
      folders.add(path);
      return json({ ok: true, path }, 201);
    }
    const rest = decodeURIComponent(url.slice("/api/models/".length));
    if (rest.endsWith("/rename") && method === "POST") {
      const source = rest.slice(0, -"/rename".length);
      const destination = (JSON.parse(String(init?.body)) as { path: string }).path;
      files.set(destination, files.get(source)!);
      files.delete(source);
      return json({ ok: true, path: destination });
    }
    if (rest.endsWith("/report")) {
      return json({ modelName: "Test", generatedFrom: "test", findings: [],
        summary: { errors: 0, warnings: 0, infos: 0, byCheck: {} },
        matrix: { ids: [], cells: [] }, ghostEdges: [] });
    }
    if (method === "PUT") {
      files.set(rest, String(init?.body));
      return json({ ok: true, model: empty, hash: "h" });
    }
    const yaml = files.get(rest);
    if (!yaml) return json({ error: "not found" }, 404);
    return json({ yaml, model: empty, errors: null, hash: "h" });
  }));
});

afterEach(() => {
  useAppStore.getState().reset();
  useEditorStore.getState().reset();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

const shown = (): string[] => screen.queryAllByTestId("model-item").map((b) => b.getAttribute("aria-label")!);

describe("game folders in the sidebar", () => {
  it("shows only the picked game's models and keeps the game in the URL", async () => {
    render(<App />);
    await waitFor(() => expect(shown()).toEqual(["GameA/Economy/graph.yaml"]));
    fireEvent.change(screen.getByTestId("game-picker"), { target: { value: "GameB" } });
    await waitFor(() => expect(shown()).toEqual(["GameB/Combat/fight.yaml", "GameB/Economy/graph.yaml"]));
    expect(window.location.hash).toBe("#/GameB");
  });

  it("opens the game named in the URL", async () => {
    window.location.hash = "#/GameB";
    render(<App />);
    await waitFor(() => expect(shown()).toContain("GameB/Combat/fight.yaml"));
  });

  it("creates a model in the selected folder", async () => {
    window.location.hash = "#/GameB";
    render(<App />);
    fireEvent.click(await screen.findByText("Combat"));
    fireEvent.change(screen.getByTestId("new-model-name"), { target: { value: "Boss Fight" } });
    fireEvent.click(screen.getByTestId("create-model"));
    await waitFor(() => expect(files.has("GameB/Combat/boss-fight.yaml")).toBe(true));
    await waitFor(() => expect(shown()).toContain("GameB/Combat/boss-fight.yaml"));
  });

  it("adds a game and a folder inside it, and lists them while empty", async () => {
    render(<App />);
    await waitFor(() => expect(shown()).toHaveLength(1));
    fireEvent.click(screen.getByTestId("new-game"));
    fireEvent.change(screen.getByTestId("new-folder-name"), { target: { value: "GameC" } });
    fireEvent.click(screen.getByTestId("add-folder"));
    await waitFor(() => expect(window.location.hash).toBe("#/GameC"));
    expect(screen.getByTestId("game-empty")).toBeTruthy();

    fireEvent.click(screen.getByTestId("new-folder"));
    fireEvent.change(screen.getByTestId("new-folder-name"), { target: { value: "Economy" } });
    fireEvent.click(screen.getByTestId("add-folder"));
    await waitFor(() => expect(folders.has("GameC/Economy")).toBe(true));
    await waitFor(() =>
      expect(screen.getAllByTestId("folder").map((f) => f.dataset.path)).toEqual(["GameC/Economy"]));
    expect(shown()).toEqual([]);
  });

  it("moves a model into another game's folder", async () => {
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Move GameA/Economy/graph.yaml"));
    fireEvent.change(screen.getByTestId("move-target"), { target: { value: "GameB/Combat" } });
    fireEvent.click(screen.getByTestId("move-confirm"));
    await waitFor(() => expect(files.has("GameB/Combat/graph.yaml")).toBe(true));
    expect(files.has("GameA/Economy/graph.yaml")).toBe(false);
    await waitFor(() => expect(shown()).toEqual([]));
  });

  it("renames a folder and keeps its open model open at the new path", async () => {
    window.location.hash = "#/GameB";
    render(<App />);
    fireEvent.click(await screen.findByLabelText("GameB/Combat/fight.yaml"));
    await waitFor(() => expect(screen.getByTestId("model-path").textContent).toBe("GameB/Combat/fight.yaml"));
    fireEvent.click(screen.getByLabelText("Rename folder GameB/Combat"));
    fireEvent.change(screen.getByLabelText("New name for folder GameB/Combat"), { target: { value: "Battles" } });
    fireEvent.click(screen.getByText("Save name"));
    await waitFor(() => expect(screen.getByTestId("model-path").textContent).toBe("GameB/Battles/fight.yaml"));
    expect(shown()).toContain("GameB/Battles/fight.yaml");
  });

  it("renames the current game and follows it in the URL", async () => {
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Rename folder GameA"));
    fireEvent.change(screen.getByLabelText("New name for folder GameA"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByText("Save name"));
    await waitFor(() => expect(window.location.hash).toBe("#/Alpha"));
    await waitFor(() => expect(shown()).toEqual(["Alpha/Economy/graph.yaml"]));
  });

  it("deletes an empty folder and explains why a full one stays", async () => {
    folders.add("GameA/Spare");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Delete folder GameA/Spare"));
    await waitFor(() => expect(folders.has("GameA/Spare")).toBe(false));
    fireEvent.click(screen.getByLabelText("Delete folder GameA/Economy"));
    await waitFor(() => expect(screen.getByTestId("management-error").textContent).toContain("not empty"));
    expect(folders.has("GameA/Economy")).toBe(true);
  });

  it("groups the move menu by game, each game's top first", async () => {
    render(<App />);
    fireEvent.click(await screen.findByLabelText("Move GameA/Economy/graph.yaml"));
    const groups = [...screen.getByTestId("move-target").querySelectorAll("optgroup")];
    expect(groups.map((g) => g.label)).toEqual(["GameA", "GameB"]);
    expect([...groups[1]!.querySelectorAll("option")].map((o) => [o.value, o.textContent])).toEqual([
      ["GameB", "GameB (top)"],
      ["GameB/Combat", "Combat"],
      ["GameB/Economy", "Economy"],
    ]);
  });

  it("drags a model into another folder", async () => {
    window.location.hash = "#/GameB";
    render(<App />);
    const row = (await screen.findByLabelText("GameB/Economy/graph.yaml")).closest("li")!;
    const combat = screen.getAllByTestId("folder").find((f) => f.dataset.path === "GameB/Combat")!;
    fireEvent.dragStart(row);
    fireEvent.dragOver(combat);
    expect(combat.dataset.drop).toBe("true");
    fireEvent.drop(combat);
    await waitFor(() => expect(files.has("GameB/Combat/graph.yaml")).toBe(true));
    expect(files.has("GameB/Economy/graph.yaml")).toBe(false);
  });

  it("drags a folder into another game, and never into itself", async () => {
    window.location.hash = "#/GameB";
    render(<App />);
    await screen.findByLabelText("GameB/Combat/fight.yaml");
    const combat = () => screen.getAllByTestId("folder").find((f) => f.dataset.path === "GameB/Combat")!;
    fireEvent.dragStart(combat().querySelector("summary")!);
    fireEvent.dragOver(combat());
    expect(combat().dataset.drop).toBeUndefined();
    const gameA = screen.getByTestId("game-drop-GameA");
    fireEvent.dragOver(gameA);
    fireEvent.drop(gameA);
    await waitFor(() => expect(files.has("GameA/Combat/fight.yaml")).toBe(true));
    expect(folders.has("GameB/Combat")).toBe(false);
  });
});
