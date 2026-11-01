import type { Model, Node, Position } from "@mechflow/core";

/**
 * Palette node kinds and the rules for creating a new node of each kind.
 *
 * Dragging a kind from the {@link Palette} onto the canvas calls {@link createNode},
 * which fills in the required fields with sensible defaults and derives a
 * unique id + auto-incrementing name. The goal is a valid model in one drop;
 * the inspector (ypg.3) refines the details.
 */

export type NodeKind =
  | "pool"
  | "source"
  | "drain"
  | "converter"
  | "gate"
  | "register"
  | "mechanic"
  | "entity";

/** A palette entry: what the user sees and drags. */
export interface NodeKindInfo {
  kind: NodeKind;
  label: string;
  group: "Economy" | "Mechanics";
}

/** Ordered palette, grouped for display. */
export const NODE_KINDS: NodeKindInfo[] = [
  { kind: "source", label: "Source", group: "Economy" },
  { kind: "pool", label: "Pool", group: "Economy" },
  { kind: "drain", label: "Drain", group: "Economy" },
  { kind: "converter", label: "Converter", group: "Economy" },
  { kind: "gate", label: "Gate", group: "Economy" },
  { kind: "register", label: "Register", group: "Economy" },
  { kind: "mechanic", label: "Mechanic", group: "Mechanics" },
  { kind: "entity", label: "Entity", group: "Mechanics" },
];

/** Capitalize the first letter for a human-facing name. */
function humanize(kind: NodeKind): string {
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * A unique id of the form `<kind>-<n>` that does not collide with any existing
 * id. `existingIds` is the current set of node ids in the model.
 */
export function uniqueNodeId(existingIds: Iterable<string>, kind: NodeKind): string {
  const taken = new Set(existingIds);
  let n = 1;
  while (taken.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

/**
 * Build the body of a new node of `kind` at `position` (pinned), with a unique
 * id and an auto-incrementing name derived from that id ("Source 1", "Gate 2").
 *
 * Each kind is constructed explicitly so the required fields are present and
 * correctly typed, and so the node validates against the core schema (empty
 * arrays satisfy the `min(1)` string constraints).
 */
export function createNode(
  kind: NodeKind,
  nodes: readonly Node[],
  position: Position,
): Node {
  const id = uniqueNodeId(nodes.map((n) => n.id), kind);
  const suffix = id.slice(kind.length + 1); // strip "<kind>-"
  const name = `${humanize(kind)} ${suffix}`;
  const pinned = { ...position, pinned: true };

  switch (kind) {
    case "source":
      return { id, kind: "source", name, rate: 1, position: pinned };
    case "drain":
      return { id, kind: "drain", name, rate: 1, position: pinned };
    case "pool":
      return { id, kind: "pool", name, start: 0, position: pinned };
    case "converter":
      return { id, kind: "converter", name, inputs: [], outputs: [], position: pinned };
    case "gate":
      return { id, kind: "gate", name, mode: "random", position: pinned };
    case "register":
      return { id, kind: "register", name, formula: "0", position: pinned };
    case "mechanic":
      return { id, kind: "mechanic", name, reads: [], writes: [], position: pinned };
    case "entity":
      return { id, kind: "entity", name, has: [], position: pinned };
  }
}

/**
 * Given the nodes currently in the model, return the next auto-incrementing
 * name for a kind ("Source 3") — used by tests and any caller that needs a
 * name without committing a node.
 */
export function nextNodeName(nodes: readonly Node[], kind: NodeKind): string {
  const id = uniqueNodeId(nodes.map((n) => n.id), kind);
  return `${humanize(kind)} ${id.slice(kind.length + 1)}`;
}

/** Convenience: the ids of nodes currently in a model. */
export function nodeIds(model: Pick<Model, "nodes">): string[] {
  return model.nodes.map((n) => n.id);
}

/**
 * A unique edge id of the form `edge-<n>` that does not collide with any
 * existing edge id. Used when creating an edge from a palette connection.
 */
export function uniqueEdgeId(existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  let n = 1;
  while (taken.has(`edge-${n}`)) n++;
  return `edge-${n}`;
}
