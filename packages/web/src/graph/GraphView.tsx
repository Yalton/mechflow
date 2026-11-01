import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactFlow, {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  useReactFlow,
  useStoreApi,
} from "reactflow";
import type {
  Connection,
  Edge,
  EdgeProps,
  Node,
  NodeProps,
  ReactFlowInstance,
} from "reactflow";
import type { Model, TraceResult } from "@mechflow/core";
import { traceEffects } from "@mechflow/core";
import { runLayout } from "../layout/forceLayout.js";
import { FLOW_EDGE_TYPE, DIM_CLASS, applyHighlight, toFlow } from "./toFlow.js";
import { applyTrace } from "./traceLayer.js";
import { applyRun } from "./runLayer.js";
import { applyChains, findChains } from "./chains.js";
import { RunControls } from "./RunControls.js";
import { ECONOMY_KINDS } from "../layout/layered.js";
import { MechanicRunControls } from "./MechanicRunControls.js";
import type { Wave } from "./mechanicRun.js";
import { WaveEdge, WAVE_EDGE_TYPE } from "./edges/WaveEdge.js";
import { useRunStore } from "../state/run.js";
import { FlowEdge } from "./edges/FlowEdge.js";
import { PoolNode } from "./nodes/PoolNode.js";
import { SourceNode } from "./nodes/SourceNode.js";
import { DrainNode } from "./nodes/DrainNode.js";
import { ConverterNode } from "./nodes/ConverterNode.js";
import { GateNode } from "./nodes/GateNode.js";
import { RegisterNode } from "./nodes/RegisterNode.js";
import { MechanicNode } from "./nodes/MechanicNode.js";
import { EntityNode } from "./nodes/EntityNode.js";
import { connectable } from "./nodes/connectable.js";
import { Palette } from "./Palette.js";
import { EdgeKindPopover } from "./EdgeKindPopover.js";
import { GhostResolvePopover } from "./GhostResolvePopover.js";
import { createNode, uniqueEdgeId, type NodeKind } from "./nodeFactory.js";
import { useEditorStore } from "../state/editor.js";
import type { Report } from "@mechflow/core";
import {
  ghostEdgesToDescriptors,
  filterGhostEdges,
  GHOST_EDGE_TYPE,
  type GhostEdgeDescriptor,
} from "./ghostEdges.js";
import {
  propertyLayerToFlow,
  PROPERTY_NODE_TYPE,
  PROPERTY_EDGE_TYPE,
} from "./propertyLayer.js";
import { GhostEdge } from "./edges/GhostEdge.js";
import { PropertyLink } from "./edges/PropertyLink.js";
import { PropertyNode } from "./nodes/PropertyNode.js";
import { Toolbar } from "./Toolbar.js";

type FlowStoreLike = ReturnType<typeof useStoreApi>;

/** Map each core node `kind` to its custom React Flow renderer (with handles). */
const nodeTypes: Record<string, React.ComponentType<NodeProps>> = {
  pool: connectable(PoolNode, { symbol: true }),
  source: connectable(SourceNode, { symbol: true }),
  drain: connectable(DrainNode, { symbol: true }),
  converter: connectable(ConverterNode, { symbol: true }),
  gate: connectable(GateNode, { symbol: true }),
  register: connectable(RegisterNode, { symbol: true }),
  mechanic: connectable(MechanicNode),
  entity: connectable(EntityNode),
  [PROPERTY_NODE_TYPE]: PropertyNode,
};

const edgeTypes: Record<string, React.ComponentType<EdgeProps>> = {
  [FLOW_EDGE_TYPE]: FlowEdge,
  [GHOST_EDGE_TYPE]: GhostEdge,
  [WAVE_EDGE_TYPE]: WaveEdge,
  [PROPERTY_EDGE_TYPE]: PropertyLink,
};

/**
 * Renders a model as a React Flow graph and drives canvas editing.
 *
 * Editing flows through the editor store commands (ypg.1):
 * - **Add** — drag a kind from {@link Palette} onto the canvas (`onDrop`).
 * - **Connect** — drag a node handle to another (`onConnect`); a popover picks
 *   the edge kind, then the edge is added via the store.
 * - **Move/pin** — dragging a node pins its position (`onNodeDragStop`).
 * - **Delete** — Delete/Backspace removes the selected node(s) plus their edges,
 *   and any selected edge (`useOnSelectionChange` + a keydown handler).
 * - **Resolve ghost** — clicking a ghost edge opens {@link GhostResolvePopover}:
 *   Connect adds an interaction edge and selects it (so the inspector opens on
 *   it); Intentionally none records a `noInteraction` with the given reason.
 *
 * `highlightedNodeIds`/`highlightedEdgeIds`, when non-empty, dim everything but
 * the set so a selected finding stands out.
 */
export function GraphView({
  model,
  report,
  highlightedNodeIds = EMPTY_NODE_IDS,
  highlightedEdgeIds = EMPTY_EDGE_IDS,
  onSelectionChange,
}: {
  model: Model | null;
  /** Analysis report; its `ghostEdges` are drawn as faint dashed arcs. */
  report?: Pick<Report, "ghostEdges"> | null;
  highlightedNodeIds?: Set<string>;
  highlightedEdgeIds?: Set<string>;
  onSelectionChange?: (selection: { nodeId?: string; edgeId?: string }) => void;
}): JSX.Element {
  const wellFormed =
    !!model && Array.isArray(model.nodes) && Array.isArray(model.edges);
  const openPath = useEditorStore((s) => s.path);
  const [flowGraph, setFlowGraph] = useState(() => wellFormed && model
    ? toFlow(model, layoutNewNodes(model, new Map())) : { nodes: [], edges: [] });
  const previousModel = useRef<Model | null>(model);
  // An edge just added from a ghost edge's Connect; the next model sync marks it
  // selected so the canvas agrees with the inspector.
  const selectOnSync = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousModel.current;
    // Read now: the updater below runs later, after the ref is cleared.
    const selectId = selectOnSync.current;
    setFlowGraph((current) => {
      const onCanvas = new Map(current.nodes.map((node) => [node.id, node.position]));
      const next = wellFormed && model
        ? toFlow(model, layoutNewNodes(model, onCanvas))
        : { nodes: [], edges: [] };
      const nodesById = new Map(current.nodes.map((node) => [node.id, node]));
      const edgesById = new Map(current.edges.map((edge) => [edge.id, edge]));
      const previousPositions = new Map(previous?.nodes?.map((node) => [node.id, node.position]));
      return {
        nodes: next.nodes.map((node) => {
          const existing = nodesById.get(node.id);
          if (!existing) return node;
          const oldPosition = previousPositions.get(node.id);
          const newPosition = model?.nodes.find((item) => item.id === node.id)?.position;
          // A position removed (by undoing a Re-layout) leaves the node where it is.
          const positionChanged =
            !!newPosition && (oldPosition?.x !== newPosition.x || oldPosition?.y !== newPosition.y);
          return {
            ...node,
            position: positionChanged ? node.position : existing.position,
            selected: existing.selected,
          };
        }),
        edges: next.edges.map((edge) => ({
          ...edge,
          selected: edge.id === selectId || edgesById.get(edge.id)?.selected,
        })),
      };
    });
    previousModel.current = model;
    selectOnSync.current = null;
  }, [model, wellFormed]);

  // Memoize so the `nodes`/`edges` props keep a stable reference across
  // relayout re-renders; otherwise React Flow would reset the positions set by
  // the Re-layout button on the next render.
  // `applyHighlight` returns the same graph when no highlight is active,
  // preserving that stability.
  const { nodes, edges } = useMemo(
    () => applyHighlight(flowGraph, highlightedNodeIds, highlightedEdgeIds),
    [flowGraph, highlightedNodeIds, highlightedEdgeIds],
  );

  // Append ghost edges and the property layer on top of the highlighted graph,
  // so neither is dimmed by a finding highlight. Ghost edges are filtered by the
  // score-threshold slider; the property layer appears only when toggled on.
  // Declared before this memo reads them: rules of hooks, and no TDZ.
  const [ghostThreshold, setGhostThreshold] = useState(1);
  const [showPropertyLayer, setShowPropertyLayer] = useState(false);
  const [chainColours, setChainColours] = useState(true);
  const chains = useMemo(
    () => (model && wellFormed && chainColours ? findChains(model) : null),
    [model, wellFormed, chainColours],
  );
  // The active effect trace. Declared before the memo reads it: rules of hooks,
  // and no TDZ. `null` means no trace overlay; a trace is applied only while it
  // is non-null.
  const [trace, setTrace] = useState<TraceResult | null>(null);
  // The active simulation run, if any, for this model.
  const runModel = useRunStore((s) => s.model);
  const runAmounts = useRunStore((s) => s.amounts);
  const runRecord = useRunStore((s) => s.record);
  const runTrace = useRunStore((s) => s.run?.trace ?? null);
  const runActive = runModel === model;
  // The mechanic run's current wave (mechanicRun.ts), for maps with no economy.
  // Kept with the model it ran on, so an edit drops it.
  const [waveRun, setWaveRun] = useState<{ model: Model | null; wave: Wave } | null>(null);
  const wave = waveRun !== null && waveRun.model === model ? waveRun.wave : null;
  const layered = useMemo(() => {
    // Apply the effect trace and the run first; ghost edges and the property
    // layer are appended so neither is dimmed by a finding or a trace.
    const coloured = chains ? applyChains({ nodes, edges }, chains) : { nodes, edges };
    const traced = applyRun(
      applyTrace(coloured, trace),
      runActive ? runAmounts : null,
      runActive ? runRecord : null,
      // What the latest step changed from: the step before it, or the start.
      runActive && runRecord && runTrace
        ? (runTrace.steps[runRecord.step - 2] ?? runTrace.initial)
        : null,
    );
    const graph: { nodes: Node[]; edges: Edge[] } = {
      nodes: traced.nodes,
      edges: traced.edges,
    };
    if (report) {
      const descs: GhostEdgeDescriptor[] = filterGhostEdges(
        ghostEdgesToDescriptors(report),
        ghostThreshold,
      );
      graph.edges = [
        ...graph.edges,
        ...descs.map((d) => ({
          id: d.id,
          type: GHOST_EDGE_TYPE,
          source: d.a,
          target: d.b,
          data: { reason: d.reason, short: d.short, reasons: d.reasons, score: d.score },
        })),
      ];
    }
    if (wave) {
      const fired = new Set(wave.fired);
      graph.nodes = graph.nodes.map((n) => (fired.has(n.id) ? { ...n, data: { ...n.data, firing: true } } : n));
      graph.edges = [
        ...graph.edges,
        ...wave.links.map((l) => ({
          id: `wave:${l.from}->${l.to}`,
          type: WAVE_EDGE_TYPE,
          source: l.from,
          target: l.to,
          data: { properties: l.properties, step: wave.step },
        })),
      ];
    }
    if (showPropertyLayer && model) {
      const pl = propertyLayerToFlow(model);
      graph.nodes = [
        ...graph.nodes,
        ...pl.nodes.map((hub) => ({
          id: hub.id,
          type: PROPERTY_NODE_TYPE,
          position: hub.position,
          data: { name: hub.name, kind: hub.name },
        })),
      ];
      graph.edges = [
        ...graph.edges,
        ...pl.edges.map((e) => ({
          id: e.id,
          type: PROPERTY_EDGE_TYPE,
          source: e.node,
          target: `prop:${e.property}`,
          data: { relation: e.relation },
        })),
      ];
    }
    return graph;
  }, [
    nodes,
    edges,
    report,
    ghostThreshold,
    showPropertyLayer,
    model,
    trace,
    chains,
    runActive,
    runAmounts,
    runRecord,
    runTrace,
    wave,
  ]);

  // The React Flow instance is captured so `onDrop` can project the drop point
  // into flow coordinates. `useReactFlow` cannot be called in this component
  // (it is the provider's parent), so a child inside the provider grabs it via
  // `useReactFlow`; that is immediate, unlike the library's deferred `onInit`.
  const rfRef = useRef<ReactFlowInstance | null>(null);

  // A pending connection awaiting its kind from the popover.
  const [pending, setPending] = useState<{ source: string; target: string } | null>(
    null,
  );

  // The ghost edge whose resolve popover is open, if any.
  const [ghost, setGhost] = useState<
    { a: string; b: string; reasons: string[] } | null
  >(null);

  const onEdgeClick = (_event: React.MouseEvent, edge: Edge): void => {
    if (edge.type !== GHOST_EDGE_TYPE) return;
    setPending(null);
    setGhost({ a: edge.source, b: edge.target, reasons: edge.data?.reasons ?? [] });
  };

  const connectGhost = (): void => {
    const { model: open, addEdge } = useEditorStore.getState();
    if (!open || !ghost) return;
    const id = uniqueEdgeId(open.edges.map((e) => e.id));
    selectOnSync.current = id;
    addEdge({ id, kind: "interaction", from: ghost.a, to: ghost.b });
    setGhost(null);
    onSelectionChange?.({ edgeId: id });
  };

  const markNoInteraction = (reason: string): void => {
    const { model: open, addNoInteraction } = useEditorStore.getState();
    if (!open || !ghost) return;
    addNoInteraction({ a: ghost.a, b: ghost.b, reason });
    setGhost(null);
  };

  // The active effect trace. Declared above, before the memo reads it. `null`
  // means no trace overlay; a trace is applied only while it is non-null.

  // Trace the currently selected node's effects. Reads the live selection from
  // the React Flow store (below) so it never lags a React snapshot tick.
  const traceSelected = useCallback(() => {
    if (!model) return;
    const state = (globalThis as { __rfStore?: FlowStoreLike }).__rfStore?.getState();
    const selectedNode = state?.getNodes().find((node) => node.selected);
    if (!selectedNode) return;
    setTrace(traceEffects(model, selectedNode.id));
  }, [model]);

  // Viewer display controls. Ghost-edge threshold hides pairs at or below it;
  // the property layer appears only when toggled on (hiding it leaves the layout
  // unchanged). Both are local so the graph can react to them.
  const handleSelectionChange = useCallback(({ nodes, edges }: { nodes: Node[]; edges: Edge[] }) => {
    if (nodes[0]) onSelectionChange?.({ nodeId: nodes[0].id });
    else if (edges[0]) onSelectionChange?.({ edgeId: edges[0].id });
    else onSelectionChange?.({});
  }, [onSelectionChange]);
  // The current flow selection, for the delete handler. Read straight from the
  // React Flow store (below) so it never lags a React snapshot tick.

  const onDrop = (event: React.DragEvent): void => {
    const kind = event.dataTransfer.getData(
      "text/mechflow-node-kind",
    ) as NodeKind | undefined;
    if (!kind || !rfRef.current) return;
    const { model: open, addNode } = useEditorStore.getState();
    if (!open) return;
    const position = rfRef.current.project({
      x: event.clientX,
      y: event.clientY,
    });
    addNode(createNode(kind, open.nodes, position));
  };

  const onConnect = (connection: Connection): void => {
    // Reject self-loops and connections missing a source/target node; otherwise
    // open the popover to pick the edge kind.
    if (
      !connection.source ||
      !connection.target ||
      connection.source === connection.target
    )
      return;
    setPending({
      source: connection.source,
      target: connection.target,
    });
  };

  const onNodeDragStop = (
    _event: React.MouseEvent,
    node: Node,
  ): void => {
    if (!node.position) return;
    const { model: open, updateNode } = useEditorStore.getState();
    if (!open) return;
    const previous = open.nodes.find((n) => n.id === node.id)?.position;
    // Skip a no-op drag (position unchanged) so it does not push an undo step.
    if (previous && previous.x === node.position.x && previous.y === node.position.y)
      return;
    updateNode(node.id, {
      position: { x: node.position.x, y: node.position.y, pinned: true },
    });
  };

  // Keep deletion in the editor command history. React Flow's built-in
  // deletion is disabled below so it cannot race these model updates.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { model: open, removeNode, removeEdge } = useEditorStore.getState();
      if (!open) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // The current flow selection, read straight from the React Flow store so it
      // never lags a React snapshot tick.
      const state = (globalThis as { __rfStore?: FlowStoreLike }).__rfStore?.getState();
      // **Esc** clears the effect trace overlay and closes the ghost popover.
      if (event.key === "Escape") {
        setTrace((current) => (current ? null : current));
        setGhost(null);
        return;
      }
      // **T** traces the selected node's effects.
      if (event.key === "T" || event.key === "t") {
        event.preventDefault();
        const selectedNode = state?.getNodes().find((node) => node.selected);
        if (selectedNode) setTrace(traceEffects(open, selectedNode.id));
        return;
      }
      // **Delete/Backspace** removes the selected node(s) and their edges.
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      const nodeIds = state?.getNodes().filter((node) => node.selected).map((node) => node.id) ?? [];
      const edgeIds = state?.edges.filter((edge) => edge.selected).map((edge) => edge.id) ?? [];
      if (!nodeIds.length && !edgeIds.length) return;
      event.preventDefault();
      const deletedNodes = new Set(nodeIds);
      for (const edge of open.edges) {
        if (deletedNodes.has(edge.from) || deletedNodes.has(edge.to)) removeEdge(edge.id);
      }
      for (const id of edgeIds) removeEdge(id);
      for (const id of nodeIds) removeNode(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!model || !wellFormed) {
    return <div data-testid="graph-empty" style={empty}>No graph to display.</div>;
  }
  return (
    <div data-testid="graph-container" style={container}>
      {/* The palette has the top-left corner to itself. */}
      <div style={leftStack}>
        {/* Keyed on the open file, so opening a model picks the start state afresh
            while adding the first node to an empty one leaves the palette open. */}
        <Palette key={openPath ?? ""} startCollapsed={(model?.nodes.length ?? 0) > 0} />
      </div>
      {/* The simulation moves resources; a mechanics-only map has none to move. */}
      {model.nodes.some((n) => ECONOMY_KINDS.has(n.kind)) ? (
        <RunControls model={model} />
      ) : model.nodes.some((n) => n.kind === "mechanic") ? (
        // A mechanics-only map runs as waves through shared properties instead.
        <MechanicRunControls model={model} wave={wave} onWave={(next) => setWaveRun(next && { model, wave: next })} />
      ) : null}
      <ReactFlow
        nodes={layered.nodes}
        edges={layered.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable
        elementsSelectable
        deleteKeyCode={null}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDrop={onDrop}
        onConnect={onConnect}
        onEdgeClick={onEdgeClick}
        onNodeClick={(_event, node) => {
          // Clicking a pool shows or hides its series in the simulation charts.
          if (model.nodes.find((n) => n.id === node.id)?.kind !== "pool") return;
          const pools = model.nodes.filter((n) => n.kind === "pool").map((n) => n.id);
          useRunStore.getState().togglePool(node.id, pools);
        }}
        onNodeDragStop={onNodeDragStop}
        onNodesChange={(changes) => setFlowGraph((current) => ({
          ...current,
          nodes: applyNodeChanges(changes, current.nodes),
        }))}
        onEdgesChange={(changes) => setFlowGraph((current) => ({
          ...current,
          edges: applyEdgeChanges(changes, current.edges),
        }))}
        onSelectionChange={onSelectionChange ? handleSelectionChange : undefined}
      >
        <InstanceRef onReady={(rf) => {
          rfRef.current = rf;
        }} />
        <style>{TRACE_CSS}</style>
        <Background color="var(--grid-dot)" gap={20} />
        <Controls />
        {nodes.length > 0 && <div style={buttonBar}>
          <TraceButton onTrace={traceSelected} />
          <Toolbar
            ghostThreshold={ghostThreshold}
            showPropertyLayer={showPropertyLayer}
            chainColours={chainColours}
            onThresholdChange={setGhostThreshold}
            onPropertyLayerChange={setShowPropertyLayer}
            onChainColoursChange={setChainColours}
          />
          <RelayoutButton onRelayout={() => {
            // Only dragged (pinned) nodes hold their place; positions an earlier
            // layout stored are recomputed.
            const positions = runLayout({
              ...model,
              nodes: model.nodes.map((node) => {
                if (!node.position || node.position.pinned) return node;
                const rest = { ...node };
                delete rest.position;
                return rest;
              }),
            });
            // Store the new positions, unpinned, as one undoable edit so Save
            // keeps them. Undo restores the model's positions; a node that had
            // none keeps its place on the canvas.
            useEditorStore.getState().moveNodes(
              new Map(
                model.nodes
                  .filter((node) => !node.position?.pinned && positions.has(node.id))
                  .map((node) => {
                    const { x, y } = positions.get(node.id)!;
                    return [node.id, { x, y }];
                  }),
              ),
            );
            setFlowGraph((current) => ({
              ...current,
              nodes: current.nodes.map((node) => {
                const position = positions.get(node.id);
                return position ? { ...node, position } : node;
              }),
            }));
          }} />
        </div>}
      </ReactFlow>
      {nodes.length === 0 && (
        <div data-testid="graph-empty" style={emptyHint}>
          Drag a node from the palette onto the canvas.
        </div>
      )}
      {pending && (
        <EdgeKindPopover
          onSelect={(kind) => {
            const { model: open, addEdge } = useEditorStore.getState();
            if (!open || !pending) return;
            addEdge({
              id: uniqueEdgeId(open.edges.map((e) => e.id)),
              kind,
              from: pending.source,
              to: pending.target,
            });
            setPending(null);
          }}
        />
      )}
      {ghost && (
        <GhostResolvePopover
          aName={model.nodes.find((n) => n.id === ghost.a)?.name ?? ghost.a}
          bName={model.nodes.find((n) => n.id === ghost.b)?.name ?? ghost.b}
          reasons={ghost.reasons}
          onConnect={connectGhost}
          onNoInteraction={markNoInteraction}
          onClose={() => setGhost(null)}
        />
      )}
    </div>
  );
}

/**
 * Child of {@link GraphView}'s React Flow so {@link useReactFlow} can capture the
 * instance. The library's own `onInit` is deferred until the viewport
 * initializes (and fires on a timer), so we grab the instance here on mount
 * instead — making `onDrop`'s coordinate projection available immediately.
 */
function InstanceRef({
  onReady,
}: {
  onReady: (rf: ReactFlowInstance) => void;
}): null {
  const rf = useReactFlow();
  const store = useStoreApi();
  useEffect(() => {
    (globalThis as { __rfStore?: FlowStoreLike }).__rfStore = store;
    onReady(rf);
  }, [onReady]);
  return null;
}

/**
 * Positions for the nodes about to appear on the canvas without a saved
 * position (a model just opened, or nodes an agent added): the
 * property-clustering layout, with saved positions and nodes already on the
 * canvas held where they are. Undefined when there are no such nodes, so an
 * edit never re-runs the layout or moves what the user can see.
 */
function layoutNewNodes(
  model: Model,
  onCanvas: ReadonlyMap<string, { x: number; y: number }>,
): ReadonlyMap<string, { x: number; y: number }> | undefined {
  if (!model.nodes.some((node) => !node.position && !onCanvas.has(node.id))) return undefined;
  const held = onCanvas.size === 0 ? model : {
    ...model,
    nodes: model.nodes.map((node) => {
      const position = onCanvas.get(node.id);
      return node.position || !position ? node : { ...node, position: { ...position, pinned: true } };
    }),
  };
  return runLayout(held);
}

const EMPTY_NODE_IDS = new Set<string>();
const EMPTY_EDGE_IDS = new Set<string>();

/**
 * Re-layout button. Re-runs the property-clustering layout on click through
 * the parent callback. Positions stay in canvas state until a node is moved.
 */
function RelayoutButton({ onRelayout }: { onRelayout: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="relayout"
      onClick={onRelayout}
      style={button}
    >
      Re-layout
    </button>
  );
}

/**
 * Trace button. Clicking it traces the currently selected node's effects: the
 * graph colours reached nodes by depth and marks their polarity. Esc clears it.
 */
function TraceButton({ onTrace }: { onTrace: () => void }): JSX.Element {
  return (
    <button
      type="button"
      data-testid="trace"
      onClick={onTrace}
      style={button}
    >
      Trace
    </button>
  );
}

const leftStack: React.CSSProperties = {
  position: "absolute",
  top: "8px",
  left: "8px",
  zIndex: 10,
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "6px",
};

const container: React.CSSProperties = {
  position: "relative",
  height: "100%",
  minHeight: "240px",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  overflow: "hidden",
  background: "var(--surface-2)",
};

const empty: React.CSSProperties = {
  padding: "16px",
  color: "var(--text-2)",
  border: "1px dashed var(--border-strong)",
  borderRadius: "10px",
  fontSize: "13px",
};

const emptyHint: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--text-2)",
  fontSize: "13px",
  pointerEvents: "none",
};

/**
 * CSS for the effect-trace overlay. Hoisted as a plain string so the browser
 * styles traced nodes by depth; kept out of the JSX so its braces are not
 * parsed as JSX delimiters.
 */
const TRACE_CSS = `
  .react-flow__node.${DIM_CLASS} { opacity: 0.3; }
  .trace-depth-1 { border-color: #fbbf24 !important; } /* 1st order: amber */
  .trace-depth-2 { border-color: #f97316 !important; } /* 2nd order: orange */
  .trace-depth-3 { border-color: #ef4444 !important; } /* 3rd order: red */
`;

const buttonBar: React.CSSProperties = {
  position: "absolute",
  top: "8px",
  right: "8px",
  zIndex: 10,
  display: "flex",
  gap: "6px",
};

// Sizes come from the base control styles in styles.css.
const button: React.CSSProperties = { boxShadow: "var(--shadow)" };
