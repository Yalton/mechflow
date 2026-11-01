import { create } from "zustand";
import {
  analyzeModel,
  serializeModelYaml,
  type Edge,
  type Model,
  type NoInteraction,
  type Property,
  type Subsystem,
  type Node,
  type Position,
  type Report,
} from "@mechflow/core";
import { ConflictError, saveModel } from "../api/models.js";

/**
 * The editor store: an in-memory, editable copy of the opened model with
 * immutable command-based edits, undo/redo, a dirty flag, a debounced
 * re-analysis, and save-through-the-API.
 *
 * This is the foundation the browser editor builds on (ypg.2 canvas edits,
 * ypeg.3 inspector, ypeg.4 ghost resolve). It owns no DOM: components read the
 * model and call the mutation helpers, and wire keyboard shortcuts + saving
 * themselves.
 *
 * Edits are expressed as {@link ModelCommand}s — pure `{ apply, revert }` pairs
 * that return a new immutable model. `applyCommand` pushes the command onto the
 * undo stack (clearing redo), applies it, and marks the model dirty. `undo`/`redo`
 * walk the stacks by applying `revert`/`apply` to the current model.
 */

/** A single immutable model edit: apply it forward, or revert it. */
export interface ModelCommand {
  /** Apply the edit, returning a new immutable model. */
  apply: (model: Model) => Model;
  /** Revert to the prior model, returning a new immutable model. */
  revert: (model: Model) => Model;
}

/**
 * Capture the current values of the fields a patch will change, so an
 * {@link updateNodeCommand} (etc.) can revert precisely. Generic so it works for
 * nodes, edges, properties, and subsystems alike.
 */
export function previousValues<T extends object>(
  subject: T,
  patch: Partial<T>,
): Partial<T> {
  const previous: Partial<T> = {};
  for (const key of Object.keys(patch)) {
    previous[key as keyof T] = subject[key as keyof T];
  }
  return previous;
}

// --- Command factories -----------------------------------------------------
//
// Each returns a ModelCommand. `apply` builds a new model (never mutates the
// input); `revert` restores the prior state. Remove commands capture the
// removed item so their revert is exact even if a same-id item is later added.

export function addNodeCommand(node: Node): ModelCommand {
  return {
    apply: (m) => ({ ...m, nodes: [...m.nodes, node] }),
    revert: (m) => ({ ...m, nodes: m.nodes.filter((n) => n.id !== node.id) }),
  };
}

export function removeNodeCommand(node: Node): ModelCommand {
  return {
    apply: (m) => ({ ...m, nodes: m.nodes.filter((n) => n.id !== node.id) }),
    revert: (m) => ({ ...m, nodes: [...m.nodes, node] }),
  };
}

export function updateNodeCommand(
  id: string,
  patch: Partial<Node>,
  previous: Partial<Node>,
): ModelCommand {
  return {
    apply: (m) => ({
      ...m,
      nodes: m.nodes.map((n) => (n.id === id ? ({ ...n, ...patch } as Node) : n)),
    }),
    revert: (m) => ({
      ...m,
      nodes: m.nodes.map((n) => (n.id === id ? ({ ...n, ...previous } as Node) : n)),
    }),
  };
}

export function addEdgeCommand(edge: Edge): ModelCommand {
  return {
    apply: (m) => ({ ...m, edges: [...m.edges, edge] }),
    revert: (m) => ({ ...m, edges: m.edges.filter((e) => e.id !== edge.id) }),
  };
}

export function removeEdgeCommand(edge: Edge): ModelCommand {
  return {
    apply: (m) => ({ ...m, edges: m.edges.filter((e) => e.id !== edge.id) }),
    revert: (m) => ({ ...m, edges: [...m.edges, edge] }),
  };
}

export function updateEdgeCommand(
  id: string,
  patch: Partial<Edge>,
  previous: Partial<Edge>,
): ModelCommand {
  return {
    apply: (m) => ({
      ...m,
      edges: m.edges.map((e) => (e.id === id ? ({ ...e, ...patch } as Edge) : e)),
    }),
    revert: (m) => ({
      ...m,
      edges: m.edges.map((e) => (e.id === id ? ({ ...e, ...previous } as Edge) : e)),
    }),
  };
}

export function addPropertyCommand(property: Property): ModelCommand {
  return {
    apply: (m) => ({ ...m, properties: [...m.properties, property] }),
    revert: (m) => ({
      ...m,
      properties: m.properties.filter((p) => p.id !== property.id),
    }),
  };
}

export function removePropertyCommand(property: Property): ModelCommand {
  return {
    apply: (m) => ({
      ...m,
      properties: m.properties.filter((p) => p.id !== property.id),
    }),
    revert: (m) => ({ ...m, properties: [...m.properties, property] }),
  };
}

export function updatePropertyCommand(
  id: string,
  patch: Partial<Property>,
  previous: Partial<Property>,
): ModelCommand {
  return {
    apply: (m) => ({
      ...m,
      properties: m.properties.map((p) => (p.id === id ? ({ ...p, ...patch } as Property) : p)),
    }),
    revert: (m) => ({
      ...m,
      properties: m.properties.map((p) => (p.id === id ? ({ ...p, ...previous } as Property) : p)),
    }),
  };
}

export function addSubsystemCommand(subsystem: Subsystem): ModelCommand {
  return {
    apply: (m) => ({ ...m, subsystems: [...m.subsystems, subsystem] }),
    revert: (m) => ({
      ...m,
      subsystems: m.subsystems.filter((s) => s.id !== subsystem.id),
    }),
  };
}

export function removeSubsystemCommand(subsystem: Subsystem): ModelCommand {
  return {
    apply: (m) => ({
      ...m,
      subsystems: m.subsystems.filter((s) => s.id !== subsystem.id),
    }),
    revert: (m) => ({ ...m, subsystems: [...m.subsystems, subsystem] }),
  };
}

export function updateSubsystemCommand(
  id: string,
  patch: Partial<Subsystem>,
  previous: Partial<Subsystem>,
): ModelCommand {
  return {
    apply: (m) => ({
      ...m,
      subsystems: m.subsystems.map((s) => (s.id === id ? ({ ...s, ...patch } as Subsystem) : s)),
    }),
    revert: (m) => ({
      ...m,
      subsystems: m.subsystems.map((s) => (s.id === id ? ({ ...s, ...previous } as Subsystem) : s)),
    }),
  };
}

export function addNoInteractionCommand(
  noInteraction: NoInteraction,
): ModelCommand {
  return {
    apply: (m) => ({ ...m, noInteraction: [...m.noInteraction, noInteraction] }),
    revert: (m) => ({
      ...m,
      noInteraction: m.noInteraction.filter(
        (n) => !(n.a === noInteraction.a && n.b === noInteraction.b),
      ),
    }),
  };
}

export function removeNoInteractionCommand(
  noInteraction: NoInteraction,
): ModelCommand {
  return {
    apply: (m) => ({
      ...m,
      noInteraction: m.noInteraction.filter(
        (n) => !(n.a === noInteraction.a && n.b === noInteraction.b),
      ),
    }),
    revert: (m) => ({ ...m, noInteraction: [...m.noInteraction, noInteraction] }),
  };
}

/**
 * Set several nodes' positions in one step (Re-layout). `previous` holds each
 * node's position before, undefined for a node that had none.
 */
export function moveNodesCommand(
  next: ReadonlyMap<string, Position>,
  previous: ReadonlyMap<string, Position | undefined>,
): ModelCommand {
  const place = (m: Model, positions: ReadonlyMap<string, Position | undefined>): Model => ({
    ...m,
    nodes: m.nodes.map((n) => {
      if (!positions.has(n.id)) return n;
      const position = positions.get(n.id);
      if (position) return { ...n, position } as Node;
      const rest = { ...n };
      delete rest.position;
      return rest;
    }),
  });
  return { apply: (m) => place(m, next), revert: (m) => place(m, previous) };
}

/**
 * Change model-level fields (name, description, the invariant list and so
 * on). A field patched to undefined is removed; `previous` holds each field's
 * value before, undefined for one that was absent.
 */
export function updateModelCommand(patch: Partial<Model>, previous: Partial<Model>): ModelCommand {
  const assign = (m: Model, fields: Partial<Model>): Model => {
    const next: Record<string, unknown> = { ...m };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next as unknown as Model;
  };
  return { apply: (m) => assign(m, patch), revert: (m) => assign(m, previous) };
}

// --- Editor state ----------------------------------------------------------

export interface EditorState {
  /** Repo-relative path of the model being edited, or null. */
  path: string | null;
  /** The editable model copy, or null when nothing is open. */
  model: Model | null;
  /** Server hash for If-Match on the next save, or null. */
  hash: string | null;

  /** Commands applied but not yet undone. */
  undoStack: ModelCommand[];
  /** Commands undone, awaiting redo. */
  redoStack: ModelCommand[];

  /** True when the model has unsaved edits. */
  dirty: boolean;

  /** Apply an edit: push undo, clear redo, mark dirty, schedule analyze. */
  applyCommand: (command: ModelCommand) => void;
  /** Undo the last edit. */
  undo: () => void;
  /** Redo the last undone edit. */
  redo: () => void;

  /** Change model-level fields; undefined removes a field. */
  updateModel: (patch: Partial<Model>) => void;
  /** Add a node. */
  addNode: (node: Node) => void;
  /** Update a node by id (patch computes its own revert snapshot). */
  updateNode: (id: string, patch: Partial<Node>) => void;
  /** Remove a node by id. */
  removeNode: (id: string) => void;
  /** Move several nodes as one undoable edit; a no-op when none change. */
  moveNodes: (positions: ReadonlyMap<string, Position>) => void;
  /** Add an edge. */
  addEdge: (edge: Edge) => void;
  /** Update an edge by id. */
  updateEdge: (id: string, patch: Partial<Edge>) => void;
  /** Remove an edge by id. */
  removeEdge: (id: string) => void;
  /** Add a property. */
  addProperty: (property: Property) => void;
  /** Update a property by id. */
  updateProperty: (id: string, patch: Partial<Property>) => void;
  /** Remove a property by id. */
  removeProperty: (id: string) => void;
  /** Add a subsystem. */
  addSubsystem: (subsystem: Subsystem) => void;
  /** Update a subsystem by id. */
  updateSubsystem: (id: string, patch: Partial<Subsystem>) => void;
  /** Remove a subsystem by id. */
  removeSubsystem: (id: string) => void;
  /** Add a noInteraction constraint. */
  addNoInteraction: (noInteraction: NoInteraction) => void;
  /** Remove a noInteraction constraint by its a/b pair. */
  removeNoInteraction: (a: string, b: string) => void;

  /** Load a freshly opened model; clears stacks, dirty, and pending analyze. */
  load: (path: string, model: Model, hash: string) => void;

  /**
   * Run a debounced (200 ms) re-analysis of the current model, delivering the
   * report via the sink armed by {@link setReportSink}. Coalesces rapid edits
   * into one analysis.
   */
  scheduleAnalyze: () => void;
  /** Register the callback that receives re-analysis reports. */
  setReportSink: (sink: (report: Report) => void) => void;

  /** Serialize the current model and save it via the API (with If-Match). */
  save: (fetchImpl?: typeof fetch) => Promise<void>;

  /** Clear all state (tests). */
  reset: () => void;
}

/** Pending analyze timer, shared across the store's lifetime. */
let analyzeTimer: ReturnType<typeof setTimeout> | undefined;

/** The callback that receives re-analysis reports, once armed by the App. */
let reportSink: ((report: Report) => void) | undefined;

/** Drop any pending analyze without firing it. */
function flushPendingAnalyze(): void {
  if (analyzeTimer) {
    clearTimeout(analyzeTimer);
    analyzeTimer = undefined;
  }
}

export const useEditorStore = create<EditorState>((set, get) => ({
  path: null,
  model: null,
  hash: null,
  undoStack: [],
  redoStack: [],
  dirty: false,

  applyCommand: (command) => {
    const model = get().model;
    if (!model) return;
    const next = command.apply(model);
    set({
      model: next,
      dirty: true,
      undoStack: [...get().undoStack, command],
      redoStack: [],
    });
    get().scheduleAnalyze();
  },

  undo: () => {
    const stack = get().undoStack;
    if (stack.length === 0) return;
    const command = stack[stack.length - 1]!;
    const prev = command.revert(get().model as Model);
    set({
      model: prev,
      dirty: true,
      undoStack: stack.slice(0, -1),
      redoStack: [...get().redoStack, command],
    });
    get().scheduleAnalyze();
  },

  redo: () => {
    const stack = get().redoStack;
    if (stack.length === 0) return;
    const command = stack[stack.length - 1]!;
    const next = command.apply(get().model as Model);
    set({
      model: next,
      dirty: true,
      redoStack: stack.slice(0, -1),
      undoStack: [...get().undoStack, command],
    });
    get().scheduleAnalyze();
  },

  addNode: (node) => get().applyCommand(addNodeCommand(node)),
  updateNode: (id, patch) => {
    const model = get().model;
    if (!model) return;
    const node = model.nodes.find((n) => n.id === id);
    if (!node) return;
    get().applyCommand(updateNodeCommand(id, patch, previousValues(node, patch)));
  },
  removeNode: (id) => {
    const model = get().model;
    if (!model) return;
    const node = model.nodes.find((n) => n.id === id);
    if (!node) return;
    get().applyCommand(removeNodeCommand(node));
  },
  moveNodes: (positions) => {
    const model = get().model;
    if (!model) return;
    const next = new Map<string, Position>();
    const previous = new Map<string, Position | undefined>();
    for (const node of model.nodes) {
      const position = positions.get(node.id);
      const old = node.position;
      if (!position) continue;
      if (old && old.x === position.x && old.y === position.y && old.pinned === position.pinned) continue;
      next.set(node.id, position);
      previous.set(node.id, old);
    }
    if (next.size > 0) get().applyCommand(moveNodesCommand(next, previous));
  },
  addEdge: (edge) => get().applyCommand(addEdgeCommand(edge)),
  updateEdge: (id, patch) => {
    const model = get().model;
    if (!model) return;
    const edge = model.edges.find((e) => e.id === id);
    if (!edge) return;
    get().applyCommand(updateEdgeCommand(id, patch, previousValues(edge, patch)));
  },
  removeEdge: (id) => {
    const model = get().model;
    if (!model) return;
    const edge = model.edges.find((e) => e.id === id);
    if (!edge) return;
    get().applyCommand(removeEdgeCommand(edge));
  },
  addProperty: (property) => get().applyCommand(addPropertyCommand(property)),
  updateProperty: (id, patch) => {
    const model = get().model;
    if (!model) return;
    const property = model.properties.find((p) => p.id === id);
    if (!property) return;
    get().applyCommand(
      updatePropertyCommand(id, patch, previousValues(property, patch)),
    );
  },
  removeProperty: (id) => {
    const model = get().model;
    if (!model) return;
    const property = model.properties.find((p) => p.id === id);
    if (!property) return;
    get().applyCommand(removePropertyCommand(property));
  },
  addSubsystem: (subsystem) => get().applyCommand(addSubsystemCommand(subsystem)),
  updateSubsystem: (id, patch) => {
    const model = get().model;
    if (!model) return;
    const subsystem = model.subsystems.find((s) => s.id === id);
    if (!subsystem) return;
    get().applyCommand(
      updateSubsystemCommand(id, patch, previousValues(subsystem, patch)),
    );
  },
  removeSubsystem: (id) => {
    const model = get().model;
    if (!model) return;
    const subsystem = model.subsystems.find((s) => s.id === id);
    if (!subsystem) return;
    get().applyCommand(removeSubsystemCommand(subsystem));
  },
  addNoInteraction: (noInteraction) =>
    get().applyCommand(addNoInteractionCommand(noInteraction)),
  updateModel: (patch) => {
    const model = get().model;
    if (!model) return;
    get().applyCommand(updateModelCommand(patch, previousValues(model, patch)));
  },

  removeNoInteraction: (a, b) => {
    const model = get().model;
    if (!model) return;
    const found = model.noInteraction.find((n) => n.a === a && n.b === b);
    if (!found) return;
    get().applyCommand(removeNoInteractionCommand(found));
  },

  load: (path, model, hash) => {
    flushPendingAnalyze();
    set({
      path,
      model,
      hash,
      undoStack: [],
      redoStack: [],
      dirty: false,
    });
  },

  scheduleAnalyze: () => {
    if (analyzeTimer) clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => {
      analyzeTimer = undefined;
      const model = get().model;
      if (model && reportSink) reportSink(analyzeModel(model));
    }, 200);
  },

  setReportSink: (sink) => {
    reportSink = sink;
  },

  save: async (fetchImpl?: typeof fetch) => {
    const { path, model, hash } = get();
    if (!path || !model) throw new Error("no model open");
    const yaml = serializeModelYaml(model);
    const { hash: newHash } = await saveModel(path, yaml, hash ?? undefined, fetchImpl);
    set({ hash: newHash, dirty: false });
  },

  reset: () => {
    flushPendingAnalyze();
    reportSink = undefined;
    set({
      path: null,
      model: null,
      hash: null,
      undoStack: [],
      redoStack: [],
      dirty: false,
    });
  },
}));

// Re-exported so callers can catch conflicts without importing the api module.
export { ConflictError };
