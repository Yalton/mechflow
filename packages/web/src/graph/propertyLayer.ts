import type { Model, Position } from "@mechflow/core";
import { fallbackPositions } from "./toFlow.js";

/**
 * The property layer: properties rendered as small hub nodes, each linked to the
 * nodes that read, write, or have them. This is a viewer concern (turning the
 * model's property graph into nodes + edges), so it lives in the web package and
 * reads only the model shape.
 */

/** React Flow node type tag for a property hub. */
export const PROPERTY_NODE_TYPE = "mechflow-property";
/** React Flow edge type tag for a property link. */
export const PROPERTY_EDGE_TYPE = "mechflow-property-edge";

/** A property rendered as a hub node. */
export interface PropertyHub {
  id: string;
  name: string;
}

/** A link from a node to a property hub by relation. */
export interface PropertyLink {
  id: string;
  property: string;
  node: string;
  relation: "reads" | "writes" | "has";
}

/** The property layer: hubs and the links to the nodes that touch them. */
export interface PropertyLayer {
  nodes: PropertyHub[];
  edges: PropertyLink[];
}

/** A property hub with a flow position, as produced by {@link propertyLayerToFlow}. */
export interface PropertyFlowNode extends PropertyHub {
  position: Position;
}

/**
 * Build the property layer: one hub per declared property (sorted by id for
 * stability), and a link per node that reads, writes, or has it. Deterministic.
 */
export function propertyLayer(model: Pick<Model, "properties" | "nodes">): PropertyLayer {
  const nodes: PropertyHub[] = (model.properties ?? [])
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((p) => ({ id: `prop:${p.id}`, name: p.id }));
  const byId = new Map(nodes.map((h) => [h.name, h.id]));

  const edges: PropertyLink[] = [];
  for (const node of model.nodes) {
    const add = (property: string, relation: "reads" | "writes" | "has"): void => {
      if (!byId.has(property)) return;
      edges.push({
        id: `${node.id}:${property}:${relation}`,
        property,
        node: node.id,
        relation,
      });
    };
    // `reads`/`writes` on mechanic nodes, `has` on entity nodes. Read them off
    // the union without narrowing every kind.
    const refs = node as { reads?: string[]; writes?: string[]; has?: string[] };
    for (const p of refs.reads ?? []) add(p, "reads");
    for (const p of refs.writes ?? []) add(p, "writes");
    if (node.kind === "entity") for (const p of refs.has ?? []) add(p, "has");
  }
  return { nodes, edges };
}

/**
 * Turn the property layer into React Flow nodes + edges with positions. Property
 * hubs sit at the centroid of their linked nodes, spread radially so they do not
 * stack. Uses the model's stored positions when present, otherwise a
 * deterministic fallback layout — so hiding the layer leaves the main layout
 * unchanged.
 */
export function propertyLayerToFlow(
  model: Pick<Model, "properties" | "nodes">,
  positions?: Map<string, Position>,
): { nodes: PropertyFlowNode[]; edges: PropertyLink[] } {
  const layer = propertyLayer(model);
  const base = positions ?? fallbackPositions(model);

  const centroid = new Map<string, { x: number; y: number }>();
  const count = new Map<string, number>();
  for (const e of layer.edges) {
    const p = base.get(e.node);
    if (!p) continue;
    const c = centroid.get(e.property) ?? { x: 0, y: 0 };
    c.x += p.x;
    c.y += p.y;
    count.set(e.property, (count.get(e.property) ?? 0) + 1);
    centroid.set(e.property, c);
  }

  const nodes = layer.nodes.map((hub, i) => {
    const c = centroid.get(hub.name);
    const n = count.get(hub.name) ?? 1;
    const cx = c ? c.x / n : 0;
    const cy = c ? c.y / n : 0;
    // Radial spread around the centroid so hubs do not stack.
    const angle = (i / (layer.nodes.length || 1)) * Math.PI * 2;
    const spread = 48;
    return {
      ...hub,
      position: { x: cx + Math.cos(angle) * spread, y: cy + Math.sin(angle) * spread },
    };
  });

  return { nodes, edges: layer.edges };
}
