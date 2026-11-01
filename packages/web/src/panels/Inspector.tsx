import { useState, useEffect, useSyncExternalStore } from "react";
import {
  parseFormula,
  validateModel,
  type Activation,
  type Edge,
  type FlowAct,
  type FlowMode,
  type Model,
  type Node,
  type Objective,
  type Parameter,
  type SchemaError,
  type Strategy,
  type StrategyRule,
  type Property,
  type PropertyKind,
  type Strength,
  type Subsystem,
} from "@mechflow/core";
import { useEditorStore } from "../state/editor.js";

/**
 * Inspector: a form for the currently selected model item.
 *
 * A node or edge becomes "selected" when it is clicked on the canvas (React
 * Flow owns that state). This component subscribes to the React Flow store so it
 * reflects selection without a snapshot tick, then renders an editable form for
 * the item: names, kind-specific fields, property pickers (with inline create),
 * formula fields with live parse errors, polarity/strength toggles, and a
 * subsystem picker. Cross-model validation errors from {@link validateModel}
 * show inline so the user sees what the schema rejects.
 *
 * When nothing is selected it falls back to a library list of properties and
 * subsystems, each editable inline.
 *
 * Writes go straight to the editor store (`updateNode`, `updateEdge`,
 * `updateProperty`, `updateSubsystem`, `addProperty`), so the form is a live
 * read/write of the model.
 */

interface Selection {
  nodeId?: string;
  edgeId?: string;
}

/** React Flow store shape as captured by {@link GraphView}'s InstanceRef. */
type InspectorFlowStoreLike = {
  getState: () => { getNodes: () => Node[]; edges: Edge[] };
  subscribe: (cb: () => void) => () => void;
};

/**
 * Stable-ref cache of the canvas selection. React Flow owns the real selection
 * (`globalThis.__rfStore`); this cache holds a plain value so the Inspector
 * re-renders through its own `useSyncExternalStore` — independent of RF's
 * `forceStoreRerender` burst — so the form does not loop on RF's `set` churn.
 */
let cachedSelection: Selection = {};
const rerenderListeners = new Set<() => void>();

/** Read current canvas selection from the RF store (`selected` nodes/edges). */
function readSelection(): Selection {
  const rfStore = (
    globalThis as { __rfStore?: InspectorFlowStoreLike }
  ).__rfStore;
  const state = rfStore?.getState();
  const selectedNodes =
    state?.getNodes().filter(
      (n) => (n as { selected?: boolean }).selected,
    ) ?? [];
  const selectedEdges =
    state?.edges.filter(
      (e) => (e as { selected?: boolean }).selected,
    ) ?? [];
  return selectedNodes.length
    ? { nodeId: selectedNodes[0]!.id }
    : selectedEdges.length
      ? { edgeId: selectedEdges[0]!.id }
      : {};
}

/** Stable-ref guard: return the same `Selection` ref when unchanged so
 * `useSyncExternalStore` does not force a redundant re-render (no loop). */
function sameSelection(a: Selection, b: Selection): boolean {
  return a.nodeId === b.nodeId && a.edgeId === b.edgeId;
}

/**
 * Reads the current canvas selection from the React Flow store via a local
 * mirror, so the Inspector form reflects a canvas click without a snapshot tick
 * and without looping on RF's `set` churn. Mirrors {@link GraphView}'s delete
 * handler, which filters `selected` nodes/edges.
 *
 * Two RF quirks force this design:
 *  1. `getNodes()` is stale at `set`-fire time — it reflects selection only
 *     after the store settles. So the read is deferred to the next microtask.
 *  2. React only re-runs `getSnapshot` when the stored value actually changes,
 *     so a stale `{}` at `set`-fire matches the mount value and never triggers
 *     a re-render. Deferring the read past settle forces a genuine change.
 *
 * The snapshot is cached for stable refs so RF's `set` burst returns the same
 * ref when the selection is unchanged (no redundant re-render).
 */
function useInspectorSelection(): Selection {
  useEffect(() => {
    const rfStore = (
      globalThis as { __rfStore?: InspectorFlowStoreLike }
    ).__rfStore;
    // On every RF store change, read after the store settles and bump so React
    // re-reads `getSnapshot` (the stale pre-settle read would otherwise match).
    const onSet = () => {
      queueMicrotask(() => {
        rerenderListeners.forEach((cb) => cb());
      });
    };
    onSet(); // initial read on mount
    return rfStore?.subscribe(onSet);
  }, []);

  // Subscribe to the local mirror (independent of RF's forceStoreRerender).
  return useSyncExternalStore(
    (cb) => {
      rerenderListeners.add(cb);
      return () => {
        rerenderListeners.delete(cb);
      };
    },
    () => {
      const sel = readSelection();
      return sameSelection(sel, cachedSelection)
        ? cachedSelection
        : (cachedSelection = sel);
    },
    () => cachedSelection,
  );
}

// Fills the app's inspector column, which supplies the border and scrolling.
const panel: React.CSSProperties = {
  width: "100%",
  fontSize: "13px",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

const headerStyle: React.CSSProperties = {
  fontWeight: 600,
  fontSize: "14px",
  marginBottom: "2px",
};

const subheaderStyle: React.CSSProperties = {
  marginTop: "8px",
  paddingTop: "10px",
  borderTop: "1px solid var(--border)",
  fontSize: "11px",
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  color: "var(--text-3)",
};

const errorBox: React.CSSProperties = {
  background: "var(--danger-soft)",
  border: "1px solid var(--danger-border)",
  borderRadius: "6px",
  margin: "0",
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <span style={{ color: "var(--text-2)" }}>{label}</span>
      {children}
    </label>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The node form. Names and subsystem are common; the rest depend on the node's
 * kind (economy vs mechanic, and each economy kind's own fields).
 */
function NodeInspector({
  node,
  model,
}: {
  node: Node;
  model: Model;
}): JSX.Element {
  const { updateNode } = useEditorStore.getState();
  const patch = (patch: Partial<Node>): void => updateNode(node.id, patch);

  return (
    <div data-testid="node-inspector">
      <div style={subheaderStyle}>{capitalize(node.kind)}</div>
      <Field label="Name">
        <input
          data-testid="node-name"
          value={node.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </Field>
      <Field label="Subsystem">
        <select
          data-testid="node-subsystem"
          value={node.subsystem ?? ""}
          onChange={(e) => patch({ subsystem: e.target.value || undefined })}
        >
          <option value="">— none —</option>
          {model.subsystems.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
      {KindFields({ node, patch, model })}
      <SimulationFields node={node} patch={patch} />
    </div>
  );
}

/** Kind-specific fields, rendered by the node's discriminated kind. */
function KindFields({
  node,
  patch,
  model,
}: {
  node: Node;
  patch: (patch: Partial<Node>) => void;
  model: Model;
}): JSX.Element | null {
  switch (node.kind) {
    case "pool":
      return (
        <>
          <Field label="Capacity">
            <input
              data-testid="node-capacity"
              type="number"
              value={node.capacity ?? ""}
              onChange={(e) => patch({ capacity: e.target.value === "" ? undefined : Number(e.target.value) })}
            />
          </Field>
          <Field label="Start">
            <input
              data-testid="node-start"
              type="number"
              value={node.start}
              onChange={(e) => patch({ start: Number(e.target.value) })}
            />
          </Field>
        </>
      );
    case "source":
    case "drain":
      return (
        <Field label="Rate">
          <input
            data-testid={`node-${node.kind}-rate`}
            type="number"
            value={node.rate}
            onChange={(e) => patch({ rate: Number(e.target.value) })}
          />
        </Field>
      );
    case "converter":
      return (
        <>
          <Field label="Max Activations / Step">
            <input
              data-testid="node-max-activations"
              type="number"
              value={node.maxActivationsPerStep ?? ""}
              onChange={(e) =>
                patch({
                  maxActivationsPerStep: e.target.value === "" ? undefined : Number(e.target.value),
                })
              }
            />
          </Field>
          <Field label="Inputs">
            <InputList
              items={node.inputs}
              onChange={(inputs) => patch({ inputs })}
            />
          </Field>
          <Field label="Outputs">
            <InputList
              items={node.outputs}
              onChange={(outputs) => patch({ outputs })}
            />
          </Field>
        </>
      );
    case "gate":
      return (
        <Field label="Mode">
          <select
            data-testid="node-mode"
            value={node.mode}
            onChange={(e) => patch({ mode: e.target.value as GateMode })}
          >
            <option value="random">random</option>
            <option value="deterministic">deterministic</option>
            <option value="condition">condition</option>
          </select>
        </Field>
      );
    case "register":
      return (
        <FormulaField
          value={node.formula}
          testId="node-formula"
          onChange={(formula) => patch({ formula })}
        />
      );
    case "mechanic":
      return (
        <>
          <PropertyPicker
            label="Reads"
            value={node.reads}
            properties={model.properties}
            onChange={(reads) => patch({ reads })}
            testId="node-reads"
          />
          <PropertyPicker
            label="Writes"
            value={node.writes}
            properties={model.properties}
            onChange={(writes) => patch({ writes })}
            testId="node-writes"
          />
          <PropertyPicker
            label="Drives"
            value={node.drives ?? []}
            properties={model.properties}
            onChange={(drives) => patch({ drives })}
            testId="node-drives"
          />
        </>
      );
    case "entity":
      return (
        <PropertyPicker
          label="Has"
          value={node.has}
          properties={model.properties}
          onChange={(has) => patch({ has })}
          testId="node-has"
        />
      );
    default:
      return null;
  }
}

type GateMode = "random" | "deterministic" | "condition";

/**
 * How an economy node acts in a simulation (docs/simulation-semantics.md,
 * "Activation"). Only choices the schema allows are offered: a source,
 * drain and converter have a fixed `act`, and a source and converter a fixed
 * `flowMode`. "Default" leaves the key out of the model.
 */
function SimulationFields({
  node,
  patch,
}: {
  node: Node;
  patch: (patch: Partial<Node>) => void;
}): JSX.Element | null {
  if (node.kind !== "pool" && node.kind !== "source" && node.kind !== "drain" && node.kind !== "converter") {
    return null;
  }
  return (
    <>
      <Field label="Activation">
        <select
          data-testid="node-activation"
          value={node.activation ?? ""}
          onChange={(e) => patch({ activation: (e.target.value || undefined) as Activation | undefined })}
        >
          <option value="">automatic (default)</option>
          <option value="interactive">interactive</option>
          <option value="passive">passive</option>
          <option value="onStart">onStart</option>
        </select>
      </Field>
      {node.kind === "pool" && (
        <Field label="Act">
          <select
            data-testid="node-act"
            value={node.act ?? ""}
            onChange={(e) => patch({ act: (e.target.value || undefined) as FlowAct | undefined })}
          >
            <option value="">pull (default)</option>
            <option value="push">push</option>
          </select>
        </Field>
      )}
      {(node.kind === "pool" || node.kind === "drain") && (
        <Field label="Flow mode">
          <select
            data-testid="node-flow-mode"
            value={node.flowMode ?? ""}
            onChange={(e) => patch({ flowMode: (e.target.value || undefined) as FlowMode | undefined })}
          >
            <option value="">any (default)</option>
            <option value="all">all</option>
          </select>
        </Field>
      )}
    </>
  );
}

/** A converter's input/output line list: a resource plus an amount. */
function InputList({
  items,
  onChange,
}: {
  items: { resource: string; amount: number }[];
  onChange: (next: { resource: string; amount: number }[]) => void;
}): JSX.Element {
  return (
    <div data-testid="input-list" style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      {items.map((item, i) => (
        <div key={i} style={{ display: "flex", gap: "4px" }}>
          <input
            data-testid={`input-resource-${i}`}
            value={item.resource}
            placeholder="resource"
            onChange={(e) =>
              onChange(
                items.map((it, j) => (j === i ? { ...it, resource: e.target.value } : it)),
              )
            }
          />
          <input
            data-testid={`input-amount-${i}`}
            type="number"
            value={item.amount}
            style={{ width: "60px" }}
            onChange={(e) =>
              onChange(
                items.map((it, j) => (j === i ? { ...it, amount: Number(e.target.value) } : it)),
              )
            }
          />
        </div>
      ))}
      <button
        data-testid="input-add"
        onClick={() =>
          onChange([...items, { resource: "", amount: 0 }])
        }
      >
        Add line
      </button>
    </div>
  );
}

/**
 * A formula text field with a live parse check. As the user types,
 * {@link parseFormula} runs; on an error the message shows inline under the
 * field so a bad formula is visible before it is committed.
 */
function FormulaField({
  value,
  onChange,
  testId,
  label = "Formula",
}: {
  value?: string;
  onChange: (value: string) => void;
  testId: string;
  label?: string;
}): JSX.Element {
  const parsed = value ? parseFormula(value) : { ok: true as const };
  const error = !parsed.ok ? parsed.error : undefined;
  return (
    <Field label={label}>
      <input
        data-testid={testId}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && (
        <span data-testid="formula-error" style={{ color: "var(--danger-text)", fontSize: "11px" }}>
          {error.message}
        </span>
      )}
    </Field>
  );
}

/**
 * A property picker: choose an existing property, or create one inline. The
 * created property is committed with {@link addProperty} and then selected.
 * Each property can be toggled independently, preserving existing selections.
 */
function PropertyPicker({
  label,
  value,
  onChange,
  properties,
  testId,
}: {
  label: string;
  value: string[];
  onChange: (ids: string[]) => void;
  properties: Property[];
  testId: string;
}): JSX.Element {
  const { addProperty } = useEditorStore.getState();
  const [open, setOpen] = useState(false);
  const [newId, setNewId] = useState("");
  const [newKind, setNewKind] = useState<PropertyKind>("number");

  return (
    <Field label={label}>
      <div data-testid={testId}>
        {properties.map((p) => (
          <label key={p.id} style={{ display: "block" }}>
            <input
              type="checkbox"
              checked={value.includes(p.id)}
              onChange={(e) => onChange(e.target.checked
                ? [...value, p.id]
                : value.filter((id) => id !== p.id))}
            />
            {p.id} · {p.kind}
          </label>
        ))}
      </div>
      <button
        data-testid={`${testId}-new`}
        onClick={() => setOpen((o) => (o ? false : true))}
      >
        New property…
      </button>
      {open && (
        <div data-testid={`${testId}-inline`} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <input
            data-testid={`${testId}-id`}
            value={newId}
            placeholder="new id"
            onChange={(e) => setNewId(e.target.value)}
          />
          <select
            data-testid={`${testId}-kind`}
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as PropertyKind)}
          >
            <option value="number">number</option>
            <option value="flag">flag</option>
            <option value="tag">tag</option>
          </select>
          <button
            data-testid={`${testId}-create`}
            onClick={() => {
              if (!newId || useEditorStore.getState().model?.properties.some((p) => p.id === newId)) return;
              addProperty({ id: newId, kind: newKind, description: "" });
              onChange([...value, newId]);
              setOpen(false);
            }}
          >
            Create
          </button>
        </div>
      )}
    </Field>
  );
}

/**
 * The edge form: label, polarity, strength, and (for flow edges) the rate and
 * multiplier formula fields.
 */
function EdgeInspector({
  edge,
}: {
  edge: Edge;
}): JSX.Element {
  const { updateEdge } = useEditorStore.getState();
  const patch = (patch: Partial<Edge>): void => updateEdge(edge.id, patch);

  return (
    <div data-testid="edge-inspector">
      <div style={subheaderStyle}>{capitalize(edge.kind)}</div>
      <Field label="Label">
        <input
          data-testid="edge-label"
          value={edge.label ?? ""}
          onChange={(e) => patch({ label: e.target.value })}
        />
      </Field>
      <Field label="Polarity">
        <select
          data-testid="edge-polarity"
          value={edge.polarity ?? ""}
          onChange={(e) =>
            patch({ polarity: (e.target.value as "+" | "-") || undefined })
          }
        >
          <option value="">— none —</option>
          <option value="+">+</option>
          <option value="-">−</option>
        </select>
      </Field>
      <Field label="Strength">
        <select
          data-testid="edge-strength"
          value={edge.strength ?? ""}
          onChange={(e) =>
            patch({ strength: (e.target.value as Strength) || undefined })
          }
        >
          <option value="">— none —</option>
          <option value="modifier">modifier</option>
          <option value="gate">gate</option>
          <option value="trigger">trigger</option>
        </select>
      </Field>
      {edge.kind !== "interaction" && (
        <>
          {/* An empty formula leaves the key out rather than storing "". */}
          <FormulaField
            value={edge.rate}
            testId="edge-rate"
            label={edge.kind === "state" ? "Rate (a gate's condition, with self)" : "Rate"}
            onChange={(rate) => patch({ rate: rate || undefined })}
          />
          <FormulaField
            value={edge.multiplier}
            testId="edge-multiplier"
            label="Multiplier"
            onChange={(multiplier) => patch({ multiplier: multiplier || undefined })}
          />
        </>
      )}
      {edge.kind === "flow" && (
        <Field label="Delay (steps)">
          <input
            data-testid="edge-delay"
            type="number"
            min={0}
            step={1}
            value={edge.delay ?? ""}
            onChange={(e) => {
              const value = Math.floor(Number(e.target.value));
              patch({ delay: e.target.value === "" || !(value >= 0) ? undefined : value });
            }}
          />
        </Field>
      )}
    </div>
  );
}

/**
 * The fallback view when nothing is selected on the canvas: a library of
 * properties and subsystems, each with an inline create.
 */
function LibraryList({
  model,
  errors,
}: {
  model: Model;
  /** The model's validation errors, shown next to the item they concern. */
  errors: readonly SchemaError[];
}): JSX.Element {
  const { addProperty, addSubsystem, updateProperty, updateSubsystem, updateModel } =
    useEditorStore.getState();
  return (
    <div data-testid="library">
      <div style={subheaderStyle}>Model</div>
      <Field label="Name">
        <input
          data-testid="library-model-name"
          value={model.name}
          onChange={(e) => updateModel({ name: e.target.value })}
        />
      </Field>
      <Field label="Description">
        <textarea
          data-testid="library-model-description"
          value={model.description ?? ""}
          rows={3}
          onChange={(e) => updateModel({ description: e.target.value || undefined })}
        />
      </Field>
      <div style={{ ...subheaderStyle, marginTop: "6px" }}>Invariants</div>
      <ConditionList
        kind="invariant"
        items={model.invariants}
        onChange={(invariants) => updateModel({ invariants })}
      />
      <div style={{ ...subheaderStyle, marginTop: "6px" }}>End conditions</div>
      <ConditionList
        kind="end"
        items={model.endConditions ?? []}
        // An empty list leaves the key out, as the YAML serializer does.
        onChange={(endConditions) =>
          updateModel({ endConditions: endConditions.length > 0 ? endConditions : undefined })
        }
      />
      <div style={{ ...subheaderStyle, marginTop: "6px" }}>Parameters</div>
      <ParameterList
        model={model}
        errors={errors}
        onChange={(parameters) =>
          updateModel({ parameters: parameters.length > 0 ? parameters : undefined })
        }
      />
      <div style={{ ...subheaderStyle, marginTop: "6px" }}>Objectives</div>
      <ObjectiveList
        objectives={model.objectives ?? []}
        errors={errors}
        onChange={(objectives) =>
          updateModel({ objectives: objectives.length > 0 ? objectives : undefined })
        }
      />
      <div style={{ ...subheaderStyle, marginTop: "6px" }}>Strategies</div>
      <StrategyList
        model={model}
        errors={errors}
        onChange={(strategies) =>
          updateModel({ strategies: strategies.length > 0 ? strategies : undefined })
        }
      />
      <div style={{ ...subheaderStyle, marginTop: "6px" }}>Properties</div>
      <ul data-testid="property-list" style={{ paddingLeft: "18px", margin: "0" }}>
        {model.properties.map((p) => (
          <li key={p.id}>
            <span>{p.id} </span>
            <select
              aria-label={`${p.id} kind`}
              value={p.kind}
              onChange={(e) => updateProperty(p.id, { kind: e.target.value as PropertyKind })}
            >
              <option value="number">number</option>
              <option value="flag">flag</option>
              <option value="tag">tag</option>
            </select>
            <input
              aria-label={`${p.id} description`}
              value={p.description ?? ""}
              placeholder="Description"
              onChange={(e) => updateProperty(p.id, { description: e.target.value })}
            />
          </li>
        ))}
      </ul>
      <NewPropertyButton onCreate={(prop) => {
        addProperty(prop);
      }} />
      <div style={{ ...subheaderStyle, marginTop: "6px" }}>Subsystems</div>
      <ul data-testid="subsystem-list" style={{ paddingLeft: "18px", margin: "0" }}>
        {model.subsystems.map((s) => (
          <li key={s.id}>
            <span>{s.id} </span>
            <input
              aria-label={`${s.id} name`}
              value={s.name}
              onChange={(e) => updateSubsystem(s.id, { name: e.target.value })}
            />
            <input
              aria-label={`${s.id} role`}
              value={s.role ?? ""}
              placeholder="Role"
              onChange={(e) => updateSubsystem(s.id, { role: e.target.value })}
            />
            <select
              aria-label={`${s.id} tier`}
              value={s.tier}
              onChange={(e) => updateSubsystem(s.id, { tier: e.target.value as Subsystem["tier"] })}
            >
              <option value="core">core</option>
              <option value="support">support</option>
              <option value="flavor">flavor</option>
            </select>
          </li>
        ))}
      </ul>
      <NewSubsystemButton onCreate={(s) => {
        addSubsystem(s);
      }} />
    </div>
  );
}

/** A formula identifier: a hyphen would read as minus. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why `id` cannot name a new item among `taken`, or undefined when it can.
 * Shared by the library's inline create forms.
 */
export function idProblem(id: string, taken: readonly string[]): string | undefined {
  if (!id) return "Enter an id.";
  if (!IDENTIFIER.test(id)) return "Use letters, digits and underscores, not starting with a digit.";
  if (taken.includes(id)) return `"${id}" is taken.`;
  return undefined;
}

/** The validation errors under `prefix` (such as `parameters.0`), in red. */
function ItemErrors({
  errors,
  prefix,
  testId,
}: {
  errors: readonly SchemaError[];
  prefix: string;
  testId: string;
}): JSX.Element | null {
  const mine = errors.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}.`));
  if (mine.length === 0) return null;
  return (
    <div data-testid={testId} style={{ color: "var(--danger-text)", fontSize: "11px" }}>
      {mine.map((e) => (
        <div key={`${e.path}:${e.message}`}>{e.message}</div>
      ))}
    </div>
  );
}

/** A number input that ignores an empty or non-numeric entry. */
function NumberInput({
  value,
  onChange,
  testId,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  testId: string;
  label: string;
}): JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", fontSize: "11px", color: "var(--text-2)" }}>
      {label}
      <input
        data-testid={testId}
        type="number"
        value={value}
        style={{ width: "60px" }}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(next)) onChange(next);
        }}
      />
    </label>
  );
}

/**
 * The model's parameters: description, value, range and whole-number flag of
 * each, editable in place, plus remove and an inline create. A parameter id
 * may not repeat a node id, since formulas read both by name.
 */
function ParameterList({
  model,
  errors,
  onChange,
}: {
  model: Model;
  errors: readonly SchemaError[];
  onChange: (parameters: Parameter[]) => void;
}): JSX.Element {
  const items = model.parameters ?? [];
  const [open, setOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const [draft, setDraft] = useState({ id: "", description: "", value: 1, min: 0, max: 10 });
  const replace = (i: number, item: Parameter): void =>
    onChange(items.map((it, j) => (j === i ? item : it)));
  const problem =
    idProblem(draft.id, [...items.map((p) => p.id), ...model.nodes.map((n) => n.id)]) ??
    (!draft.description.trim() ? "Enter a description." : undefined) ??
    (!(draft.min <= draft.value && draft.value <= draft.max)
      ? "The value must lie between min and max."
      : undefined);
  return (
    <div data-testid="parameter-list">
      {items.map((item, i) => (
        <div key={item.id} data-testid="parameter-item" style={{ marginBottom: "4px" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{item.id}</span>
            <button
              data-testid={`parameter-remove-${item.id}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
          <input
            data-testid={`parameter-description-${item.id}`}
            value={item.description}
            placeholder="Description"
            onChange={(e) => replace(i, { ...item, description: e.target.value })}
          />
          <div style={{ display: "flex", gap: "4px", alignItems: "flex-end" }}>
            {(["value", "min", "max"] as const).map((field) => (
              <NumberInput
                key={field}
                label={field}
                testId={`parameter-${field}-${item.id}`}
                value={item[field]}
                onChange={(value) => replace(i, { ...item, [field]: value })}
              />
            ))}
            <label style={{ fontSize: "11px", color: "var(--text-2)" }}>
              <input
                data-testid={`parameter-integer-${item.id}`}
                type="checkbox"
                checked={item.integer ?? false}
                onChange={(e) => {
                  const next = { ...item, integer: true };
                  if (!e.target.checked) delete (next as Partial<Parameter>).integer;
                  replace(i, next);
                }}
              />
              whole
            </label>
          </div>
          <ItemErrors errors={errors} prefix={`parameters.${i}`} testId={`parameter-errors-${item.id}`} />
        </div>
      ))}
      <button data-testid="new-parameter" onClick={() => setOpen((o) => !o)}>
        New parameter…
      </button>
      {open && (
        <div data-testid="new-parameter-form" style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <input
            data-testid="new-parameter-id"
            value={draft.id}
            placeholder="id"
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
          <input
            data-testid="new-parameter-description"
            value={draft.description}
            placeholder="Description"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          <div style={{ display: "flex", gap: "4px" }}>
            {(["value", "min", "max"] as const).map((field) => (
              <NumberInput
                key={field}
                label={field}
                testId={`new-parameter-${field}`}
                value={draft[field]}
                onChange={(value) => setDraft({ ...draft, [field]: value })}
              />
            ))}
          </div>
          {tried && problem && (
            <span data-testid="new-parameter-error" style={{ color: "var(--danger-text)", fontSize: "11px" }}>
              {problem}
            </span>
          )}
          <button
            data-testid="new-parameter-create"
            onClick={() => {
              setTried(true);
              if (problem) return;
              onChange([...items, { ...draft }]);
              setDraft({ id: "", description: "", value: 1, min: 0, max: 10 });
              setTried(false);
              setOpen(false);
            }}
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}

const MEASURES: Objective["measure"][] = ["final", "mean", "endStep"];

/**
 * The model's objectives, which the Search panel offers: description,
 * formula, measure and sense of each, editable in place, plus remove and an
 * inline create. An endStep objective scores when the run ended, so its
 * formula is not read; a new one gets "0".
 */
function ObjectiveList({
  objectives: items,
  errors,
  onChange,
}: {
  objectives: Objective[];
  errors: readonly SchemaError[];
  onChange: (objectives: Objective[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const empty: Objective = { id: "", description: "", expr: "", measure: "final", sense: "max" };
  const [draft, setDraft] = useState<Objective>(empty);
  const replace = (i: number, item: Objective): void =>
    onChange(items.map((it, j) => (j === i ? item : it)));
  const problem =
    idProblem(draft.id, items.map((o) => o.id)) ??
    (!draft.description.trim() ? "Enter a description." : undefined) ??
    (draft.measure !== "endStep" && !draft.expr.trim() ? "Enter a formula." : undefined);
  const measureSelect = (value: Objective["measure"], testId: string, set: (m: Objective["measure"]) => void) => (
    <select data-testid={testId} value={value} onChange={(e) => set(e.target.value as Objective["measure"])}>
      {MEASURES.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
  const senseSelect = (value: Objective["sense"], testId: string, set: (s: Objective["sense"]) => void) => (
    <select data-testid={testId} value={value} onChange={(e) => set(e.target.value as Objective["sense"])}>
      <option value="max">max</option>
      <option value="min">min</option>
    </select>
  );
  return (
    <div data-testid="objective-list">
      {items.map((item, i) => (
        <div key={item.id} data-testid="objective-item" style={{ marginBottom: "4px" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{item.id}</span>
            <button
              data-testid={`objective-remove-${item.id}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
          <input
            data-testid={`objective-description-${item.id}`}
            value={item.description}
            placeholder="Description"
            onChange={(e) => replace(i, { ...item, description: e.target.value })}
          />
          {item.measure !== "endStep" && (
            <FormulaField
              value={item.expr}
              testId={`objective-expr-${item.id}`}
              onChange={(expr) => replace(i, { ...item, expr })}
            />
          )}
          <div style={{ display: "flex", gap: "4px" }}>
            {senseSelect(item.sense, `objective-sense-${item.id}`, (sense) => replace(i, { ...item, sense }))}
            {measureSelect(item.measure, `objective-measure-${item.id}`, (measure) =>
              replace(i, { ...item, measure, expr: item.expr || "0" }),
            )}
          </div>
          <ItemErrors errors={errors} prefix={`objectives.${i}`} testId={`objective-errors-${item.id}`} />
        </div>
      ))}
      <button data-testid="new-objective" onClick={() => setOpen((o) => !o)}>
        New objective…
      </button>
      {open && (
        <div data-testid="new-objective-form" style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <input
            data-testid="new-objective-id"
            value={draft.id}
            placeholder="id"
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
          <input
            data-testid="new-objective-description"
            value={draft.description}
            placeholder="Description"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          {draft.measure !== "endStep" && (
            <input
              data-testid="new-objective-expr"
              value={draft.expr}
              placeholder="Formula, e.g. gold"
              onChange={(e) => setDraft({ ...draft, expr: e.target.value })}
            />
          )}
          <div style={{ display: "flex", gap: "4px" }}>
            {senseSelect(draft.sense, "new-objective-sense", (sense) => setDraft({ ...draft, sense }))}
            {measureSelect(draft.measure, "new-objective-measure", (measure) => setDraft({ ...draft, measure }))}
          </div>
          {tried && problem && (
            <span data-testid="new-objective-error" style={{ color: "var(--danger-text)", fontSize: "11px" }}>
              {problem}
            </span>
          )}
          <button
            data-testid="new-objective-create"
            onClick={() => {
              setTried(true);
              if (problem) return;
              onChange([...items, { ...draft, expr: draft.measure === "endStep" ? draft.expr || "0" : draft.expr }]);
              setDraft(empty);
              setTried(false);
              setOpen(false);
            }}
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The model's strategies (docs/search-design.md, "Strategies"): description,
 * intended flag, actions per step and the ordered rules of each, editable in
 * place. A rule fires an interactive node when its optional formula holds;
 * rules can be added, removed and moved, since the first eligible ones fire.
 */
function StrategyList({
  model,
  errors,
  onChange,
}: {
  model: Model;
  errors: readonly SchemaError[];
  onChange: (strategies: Strategy[]) => void;
}): JSX.Element {
  const items = model.strategies ?? [];
  const [open, setOpen] = useState(false);
  const [tried, setTried] = useState(false);
  const [draft, setDraft] = useState({ id: "", description: "" });
  const interactive = model.nodes
    .filter((n) => "activation" in n && n.activation === "interactive")
    .map((n) => n.id);
  const replace = (i: number, item: Strategy): void =>
    onChange(items.map((it, j) => (j === i ? item : it)));
  const problem =
    idProblem(
      draft.id,
      items.map((it) => it.id),
    ) ?? (!draft.description.trim() ? "Enter a description." : undefined);
  return (
    <div data-testid="strategy-list">
      {items.map((item, i) => {
        const setRules = (rules: StrategyRule[]): void => replace(i, { ...item, rules });
        return (
          <div key={item.id} data-testid="strategy-item" style={{ marginBottom: "6px" }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{item.id}</span>
              <button
                data-testid={`strategy-remove-${item.id}`}
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
            <input
              data-testid={`strategy-description-${item.id}`}
              value={item.description}
              placeholder="Description"
              onChange={(e) => replace(i, { ...item, description: e.target.value })}
            />
            <div style={{ display: "flex", gap: "6px", alignItems: "flex-end" }}>
              <label style={{ fontSize: "11px", color: "var(--text-2)" }}>
                <input
                  data-testid={`strategy-intended-${item.id}`}
                  type="checkbox"
                  checked={item.intended ?? false}
                  onChange={(e) => {
                    const next: Strategy = { ...item, intended: true };
                    if (!e.target.checked) delete next.intended;
                    replace(i, next);
                  }}
                />
                intended
              </label>
              <label
                style={{
                  display: "flex",
                  flexDirection: "column",
                  fontSize: "11px",
                  color: "var(--text-2)",
                }}
              >
                actions / step
                <input
                  data-testid={`strategy-actions-${item.id}`}
                  type="number"
                  min={1}
                  step={1}
                  placeholder="1"
                  value={item.actionsPerStep ?? ""}
                  style={{ width: "60px" }}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    const next: Strategy = { ...item };
                    // Empty means the default, 1.
                    if (e.target.value === "") delete next.actionsPerStep;
                    else if (Number.isInteger(value) && value >= 1) next.actionsPerStep = value;
                    else return;
                    replace(i, next);
                  }}
                />
              </label>
            </div>
            <div
              data-testid={`strategy-rules-${item.id}`}
              style={{ display: "flex", flexDirection: "column", gap: "2px" }}
            >
              {item.rules.map((rule, j) => {
                const key = `${item.id}-${j}`;
                const move = (to: number): void => {
                  const rules = [...item.rules];
                  rules.splice(to, 0, ...rules.splice(j, 1));
                  setRules(rules);
                };
                return (
                  <div key={j} style={{ borderLeft: "2px solid var(--border)", paddingLeft: "4px" }}>
                    <div style={{ display: "flex", gap: "2px" }}>
                      <select
                        data-testid={`strategy-rule-fire-${key}`}
                        value={rule.fire}
                        onChange={(e) =>
                          setRules(
                            item.rules.map((r, k) =>
                              k === j ? { ...r, fire: e.target.value } : r,
                            ),
                          )
                        }
                      >
                        {/* A rule may name a node that is no longer interactive; keep it selectable. */}
                        {[...new Set([...(rule.fire ? [rule.fire] : []), ...interactive])].map(
                          (id) => (
                            <option key={id} value={id}>
                              {id}
                            </option>
                          ),
                        )}
                      </select>
                      <button
                        data-testid={`strategy-rule-up-${key}`}
                        disabled={j === 0}
                        onClick={() => move(j - 1)}
                      >
                        ↑
                      </button>
                      <button
                        data-testid={`strategy-rule-down-${key}`}
                        disabled={j === item.rules.length - 1}
                        onClick={() => move(j + 1)}
                      >
                        ↓
                      </button>
                      <button
                        data-testid={`strategy-rule-remove-${key}`}
                        onClick={() => setRules(item.rules.filter((_, k) => k !== j))}
                      >
                        ×
                      </button>
                    </div>
                    <FormulaField
                      value={rule.when}
                      label="When (optional)"
                      testId={`strategy-rule-when-${key}`}
                      onChange={(when) =>
                        setRules(
                          item.rules.map((r, k) => {
                            if (k !== j) return r;
                            // An empty condition means "always": leave the key out.
                            return when ? { ...r, when } : { fire: r.fire };
                          }),
                        )
                      }
                    />
                  </div>
                );
              })}
              <button
                data-testid={`strategy-rule-add-${item.id}`}
                disabled={interactive.length === 0}
                title={
                  interactive.length === 0
                    ? "The model has no interactive nodes to fire"
                    : undefined
                }
                onClick={() => setRules([...item.rules, { fire: interactive[0]! }])}
              >
                Add rule
              </button>
            </div>
            <ItemErrors
              errors={errors}
              prefix={`strategies.${i}`}
              testId={`strategy-errors-${item.id}`}
            />
          </div>
        );
      })}
      <button data-testid="new-strategy" onClick={() => setOpen((o) => !o)}>
        New strategy…
      </button>
      {open && (
        <div
          data-testid="new-strategy-form"
          style={{ display: "flex", flexDirection: "column", gap: "2px" }}
        >
          <input
            data-testid="new-strategy-id"
            value={draft.id}
            placeholder="id"
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
          />
          <input
            data-testid="new-strategy-description"
            value={draft.description}
            placeholder="Description"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
          {tried && problem && (
            <span data-testid="new-strategy-error" style={{ color: "var(--danger-text)", fontSize: "11px" }}>
              {problem}
            </span>
          )}
          <button
            data-testid="new-strategy-create"
            onClick={() => {
              setTried(true);
              if (problem) return;
              onChange([...items, { ...draft, rules: [] }]);
              setDraft({ id: "", description: "" });
              setTried(false);
              setOpen(false);
            }}
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}

interface Condition {
  id: string;
  description: string;
  expr?: string;
}

/**
 * The invariants or the end conditions: each item's description and formula
 * are editable in place and the item can be removed; an inline form creates
 * one. An invariant's formula is optional (clearing it removes the key); an
 * end condition needs one.
 */
function ConditionList<T extends Condition>({
  kind,
  items,
  onChange,
}: {
  kind: "invariant" | "end";
  items: T[];
  onChange: (items: T[]) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [expr, setExpr] = useState("");
  const [tried, setTried] = useState(false);
  const exprRequired = kind === "end";
  const replace = (i: number, item: T): void => onChange(items.map((it, j) => (j === i ? item : it)));
  const problem =
    idProblem(id, items.map((it) => it.id)) ??
    (!description.trim() ? "Enter a description." : undefined) ??
    (exprRequired && !expr.trim() ? "Enter a formula." : undefined);
  return (
    <div data-testid={`${kind}-list`}>
      {items.map((item, i) => (
        <div key={item.id} data-testid={`${kind}-item`} style={{ marginBottom: "4px" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{item.id}</span>
            <button
              data-testid={`${kind}-remove-${item.id}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
          <input
            aria-label={`${item.id} description`}
            data-testid={`${kind}-description-${item.id}`}
            value={item.description}
            placeholder="Description"
            onChange={(e) => replace(i, { ...item, description: e.target.value })}
          />
          <FormulaField
            value={item.expr}
            testId={`${kind}-expr-${item.id}`}
            onChange={(value) => {
              const next: Condition = { ...item, expr: value };
              if (!value && !exprRequired) delete next.expr;
              replace(i, next as T);
            }}
          />
        </div>
      ))}
      <button data-testid={`new-${kind}`} onClick={() => setOpen((o) => !o)}>
        {kind === "invariant" ? "New invariant…" : "New end condition…"}
      </button>
      {open && (
        <div data-testid={`new-${kind}-form`} style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <input data-testid={`new-${kind}-id`} value={id} placeholder="id" onChange={(e) => setId(e.target.value)} />
          <input
            data-testid={`new-${kind}-description`}
            value={description}
            placeholder="Description"
            onChange={(e) => setDescription(e.target.value)}
          />
          <input
            data-testid={`new-${kind}-expr`}
            value={expr}
            placeholder={exprRequired ? "Formula, e.g. gold >= 100" : "Formula (optional)"}
            onChange={(e) => setExpr(e.target.value)}
          />
          {tried && problem && (
            <span data-testid={`new-${kind}-error`} style={{ color: "var(--danger-text)", fontSize: "11px" }}>
              {problem}
            </span>
          )}
          <button
            data-testid={`new-${kind}-create`}
            onClick={() => {
              setTried(true);
              if (problem) return;
              onChange([...items, { id, description, ...(expr ? { expr } : {}) } as T]);
              setId("");
              setDescription("");
              setExpr("");
              setTried(false);
              setOpen(false);
            }}
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}

function NewPropertyButton({
  onCreate,
}: {
  onCreate: (property: Property) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [id, setId] = useState("");
  const [kind, setKind] = useState<PropertyKind>("number");
  return (
    <div>
      <button data-testid="new-property" onClick={() => setOpen((o) => (o ? false : true))}>
        New property…
      </button>
      {open && (
        <div data-testid="new-property-form" style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <input
            data-testid="new-property-id"
            value={id}
            placeholder="id"
            onChange={(e) => setId(e.target.value)}
          />
          <select
            data-testid="new-property-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as PropertyKind)}
          >
            <option value="number">number</option>
            <option value="flag">flag</option>
            <option value="tag">tag</option>
          </select>
          <button
            data-testid="new-property-create"
            onClick={() => {
              if (!id || useEditorStore.getState().model?.properties.some((p) => p.id === id)) return;
              onCreate({ id, kind, description: "" });
              setId("");
              setOpen(false);
            }}
          >
            Create
          </button>
        </div>
      )}
    </div>
  );
}

function NewSubsystemButton({
  onCreate,
}: {
  onCreate: (subsystem: Subsystem) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [tier, setTier] = useState<Subsystem["tier"]>("support");
  return (
    <div>
      <button data-testid="new-subsystem" onClick={() => setOpen((o) => (o ? false : true))}>
        New subsystem…
      </button>
      {open && (
        <div data-testid="new-subsystem-form" style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <input
            data-testid="new-subsystem-name"
            value={name}
            placeholder="name"
            onChange={(e) => setName(e.target.value)}
          />
          <select
            data-testid="new-subsystem-tier"
            value={tier}
            onChange={(e) => setTier(e.target.value as Subsystem["tier"])}
          >
            <option value="core">core</option>
            <option value="support">support</option>
            <option value="flavor">flavor</option>
          </select>
          <button
            data-testid="new-subsystem-create"
            onClick={() => {
              const id = name.toLowerCase();
              if (!name || useEditorStore.getState().model?.subsystems.some((s) => s.id === id)) return;
              onCreate({ id, name, tier });
              setName("");
              setOpen(false);
            }}
          >
            Create
          </button>
        </div>
      )}
    </div>
);
}

/** Rendered inside the React Flow provider so {@link useStoreApi} resolves. */
export function Inspector({ model, selection: selected }: {
  model: Model;
  selection?: Selection;
}): JSX.Element {
  const fallbackSelection = useInspectorSelection();
  const selection = selected ?? fallbackSelection;

  // Subscribe to the editor store's live model so the form reflects an edit
  // without waiting for the next RF selection tick. `updateNode`/`updateEdge`
  // swap in a new model object; the prop is only the load-time snapshot, so we
  // read the store (falling back to the prop when nothing is open yet).
  const liveModel = useEditorStore((s) => (s.model ?? model) as Model);

  const selectedNode = selection.nodeId
    ? liveModel.nodes.find((n) => n.id === selection.nodeId)
    : undefined;
  const selectedEdge = selection.edgeId
    ? liveModel.edges.find((e) => e.id === selection.edgeId)
    : undefined;

  const result = validateModel(liveModel);
  const errors = !result.ok ? result.errors : [];

  return (
    <div data-testid="inspector" style={panel}>
      <div style={headerStyle}>Inspector</div>
      {errors.length > 0 && (
        <ul data-testid="validation-errors" style={errorBox}>
          {errors.map((e) => (
            <li key={`${e.path}:${e.message}`} style={{ margin: "2px 0" }}>
              <strong>{e.path}</strong>: {e.message}
            </li>
          ))}
        </ul>
      )}
      {selectedNode ? (
        <NodeInspector node={selectedNode} model={liveModel} />
      ) : selectedEdge ? (
        <EdgeInspector edge={selectedEdge} />
      ) : (
        <>
          <p data-testid="inspector-hint" style={hint}>
            Select a node or edge on the canvas to edit it.
          </p>
          {/* Model-wide settings stay out of the way until asked for. */}
          <details data-testid="model-settings" style={settings}>
            <summary style={settingsSummary}>Model settings</summary>
            <LibraryList model={liveModel} errors={errors} />
          </details>
        </>
      )}
    </div>
  );
}

const hint: React.CSSProperties = {
  margin: "8px 0",
  padding: "16px 8px",
  border: "1px dashed var(--border-strong)",
  borderRadius: "8px",
  color: "var(--text-3)",
  textAlign: "center",
};

const settings: React.CSSProperties = { display: "flex", flexDirection: "column", gap: "8px" };

const settingsSummary: React.CSSProperties = {
  cursor: "pointer",
  fontWeight: 600,
  color: "var(--text-2)",
  padding: "4px 0",
};

export default Inspector;
