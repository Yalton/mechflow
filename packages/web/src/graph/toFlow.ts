import type {
  Edge as CoreEdge,
  EdgeKind,
  Model,
  Node as CoreNode,
  Polarity,
  Strength,
  Subsystem,
  SubsystemTier,
} from "@mechflow/core";
import type { Edge as FlowEdge, Node as FlowNode } from "reactflow";

/**
 * Convert a mechflow {@link Model} into React Flow nodes and edges.
 *
 * This is the pure, side-effect-free heart of the graph view: it maps core
 * node/edge kinds onto React Flow `type` tags (so per-kind custom components
 * render them) and attaches the data each renderer needs. Positions come from
 * the model when present, otherwise a deterministic per-subsystem layout is
 * generated so the output is stable for a given model.
 */

/** The single edge type; one custom renderer styles every edge. */
export const FLOW_EDGE_TYPE = "mechflow-edge";

/** CSS class applied to nodes dimmed by {@link applyHighlight}. */
export const DIM_CLASS = "mechflow-dim";

/** Data attached to a flow node, consumed by its custom renderer. */
export interface FlowNodeData {
  node: CoreNode;
  name: string;
  subsystem?: string;
  /** Resolved subsystem tier, used for border tinting. */
  tier?: SubsystemTier;
  /** Set by applyChains (chains.ts): the colour of the node's resource chain. */
  chain?: string;
  /**
   * Set by {@link applyTrace} when an effect trace is active: `undefined` when
   * not reached, `1`, `2`, or `3` for the node's order in the trace.
   */
  traceDepth?: number;
  /**
   * Set by {@link applyTrace} when an effect trace is active: the node's
   * cumulative polarity sign along the trace path. Rendered as a marker.
   */
  tracePolarity?: "+" | "-";
  /** Set by {@link applyRun} while a run is active: the pool's current amount. */
  runAmount?: number;
}

/** Data attached to a flow edge, consumed by its renderer. */
export interface FlowEdgeData {
  edge: CoreEdge;
  kind: EdgeKind;
  polarity?: Polarity;
  strength?: Strength;
  /**
   * Set by {@link GraphView} when a finding is highlighted: `true` when the
   * edge belongs to the highlighted finding, `false` when it should be dimmed.
   * `undefined` means no highlight is active (edge fully visible).
   */
  highlighted?: boolean;
  /**
   * Set by {@link applyTrace} when an effect trace is active: `true` when the
   * edge lies on the trace path, so its renderer can emphasise it.
   */
  trace?: boolean;
  /** Set by applyChains (chains.ts): the colour of the edge's resource chain. */
  chain?: string;
  /**
   * Set by {@link applyRun} on state edges whose source changed in the run's
   * latest step: the source's new value.
   */
  signal?: number;
  /** Set by {@link applyRun}: the step that moved `movedAmount` (or sent `signal`). */
  movedStep?: number;
  /** Flow edges only: the rate shown on the badge (see {@link flowRate}). */
  rate?: string;
  /** Set by {@link applyRun}: the edge moved resources in the run's latest step. */
  moving?: boolean;
  /** Set by {@link applyRun} with `moving`: how many resources it moved. */
  movedAmount?: number;
  /**
   * Set by {@link applyRun}: the edge wanted resources in the latest step but
   * moved none, so whatever it feeds is starved.
   */
  starved?: boolean;
}

export interface FlowGraph {
  nodes: FlowNode<FlowNodeData>[];
  edges: FlowEdge<FlowEdgeData>[];
}

const COL_WIDTH = 260;
const ROW_HEIGHT = 130;
const ORIGIN = 40;

/**
 * Deterministic fallback positions: subsystems become columns (sorted by id),
 * their positionless nodes stack as rows. Stored `position`s override this.
 */
export function fallbackPositions(model: Pick<Model, "nodes">): Map<string, { x: number; y: number }> {
  const bySubsystem = new Map<string, CoreNode[]>();
  for (const node of model.nodes) {
    const key = node.subsystem ?? "\u0000uns";
    const bucket = bySubsystem.get(key);
    if (bucket) bucket.push(node);
    else bySubsystem.set(key, [node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  [...bySubsystem.keys()].sort().forEach((key, subIndex) => {
    bySubsystem
      .get(key)!
      .forEach((node, i) => {
        positions.set(node.id, {
          x: ORIGIN + subIndex * COL_WIDTH,
          y: ORIGIN + i * ROW_HEIGHT,
        });
      });
  });
  return positions;
}

/**
 * Map a core model to React Flow nodes and edges. Pure. A node without a saved
 * `position` is placed from `positions` when given, else by
 * {@link fallbackPositions}.
 */
export function toFlow(
  model: Model,
  positions?: ReadonlyMap<string, { x: number; y: number }>,
): FlowGraph {
  const subsystems = new Map<string, Subsystem>();
  for (const s of model.subsystems) subsystems.set(s.id, s);
  const fallback = fallbackPositions(model);

  const nodes: FlowNode<FlowNodeData>[] = model.nodes.map((node) => {
    const subsystem = node.subsystem;
    const tier = subsystem ? subsystems.get(subsystem)?.tier : undefined;
    const position = node.position ?? positions?.get(node.id) ?? fallback.get(node.id)!;
    return {
      id: node.id,
      type: node.kind,
      position,
      data: { node, name: node.name, subsystem, tier },
    };
  });

  const byId = new Map(model.nodes.map((node) => [node.id, node]));
  const edges: FlowEdge<FlowEdgeData>[] = model.edges.map((edge) => ({
    id: edge.id,
    type: FLOW_EDGE_TYPE,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    data: {
      edge,
      kind: edge.kind,
      polarity: edge.polarity,
      strength: edge.strength,
      ...(edge.kind === "flow" ? { rate: flowRate(edge, byId) } : {}),
    },
  }));

  return { nodes, edges };
}

/**
 * What a flow edge's badge shows: its rate formula, as the simulation resolves
 * it (the edge's own `rate`, else its source's or drain's node rate, else 1),
 * followed by `×multiplier` when it has one.
 */
export function flowRate(edge: CoreEdge, nodes: ReadonlyMap<string, CoreNode>): string {
  const from = nodes.get(edge.from);
  const to = nodes.get(edge.to);
  const nodeRate = from?.kind === "source" ? from.rate : to?.kind === "drain" ? to.rate : undefined;
  const rate = String(edge.rate ?? nodeRate ?? "1");
  return edge.multiplier ? `${rate} ×${edge.multiplier}` : rate;
}

/** Longest edge badge drawn; longer text is clipped with an ellipsis. */
export const MAX_BADGE_CHARS = 14;

/** Badge text as drawn: clipped to {@link MAX_BADGE_CHARS}. */
export function clipBadge(text: string): string {
  return text.length > MAX_BADGE_CHARS ? `${text.slice(0, MAX_BADGE_CHARS - 1)}…` : text;
}

/**
 * Overlay a finding highlight onto a flow graph. Nodes whose id is not in
 * `nodeIds` receive the {@link DIM_CLASS} (so the renderer/CSS dims them); edges
 * whose id is not in `edgeIds` get `highlighted: false`. Returns the graph
 * unchanged when no ids are supplied, preserving referential stability for the
 * caller's `useMemo`.
 */
export function applyHighlight(
  graph: FlowGraph,
  nodeIds: ReadonlySet<string>,
  edgeIds: ReadonlySet<string>,
): FlowGraph {
  const active = nodeIds.size > 0 || edgeIds.size > 0;
  if (!active) return graph;
  return {
    nodes: graph.nodes.map((node) => ({
      ...node,
      className: nodeIds.has(node.id) ? undefined : DIM_CLASS,
    })),
    edges: graph.edges.map((edge) => {
      // `edge.data` is typed optional by React Flow but always present on
      // graphs produced by `toFlow`; assert it so the spread keeps required
      // fields (`edge`, `kind`) non-undefined.
      const data = edge.data!;
      return {
        ...edge,
        data: { ...data, highlighted: edgeIds.has(edge.id) },
      };
    }),
  };
}
