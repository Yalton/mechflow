import { useState } from "react";

/**
 * Popover shown when a ghost edge is clicked (ypg.4). Lists every reason the
 * pair looks related and offers two resolutions:
 * - **Connect** — add an interaction edge between the pair.
 * - **Intentionally none** — ask for a reason, then record a `noInteraction`.
 *
 * Rendered by {@link GraphView} as a centered `absolute` overlay; the parent
 * applies the chosen resolution through the editor store so it is undoable.
 */
export function GhostResolvePopover({
  aName,
  bName,
  reasons,
  onConnect,
  onNoInteraction,
  onClose,
}: {
  aName: string;
  bName: string;
  reasons: string[];
  onConnect: () => void;
  onNoInteraction: (reason: string) => void;
  onClose: () => void;
}): JSX.Element {
  // `null` until "Intentionally none" is chosen; then the reason being typed.
  const [noneReason, setNoneReason] = useState<string | null>(null);
  const trimmed = noneReason?.trim() ?? "";

  return (
    <div data-testid="ghost-resolve-popover" style={popover}>
      <div style={header}>
        <div style={title}>
          {aName} ↔ {bName}
        </div>
        <button
          type="button"
          data-testid="ghost-resolve-close"
          aria-label="Close"
          onClick={onClose}
          style={closeButton}
        >
          ×
        </button>
      </div>
      <ul data-testid="ghost-resolve-reasons" style={reasonList}>
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {noneReason === null ? (
        <div style={actions}>
          <button
            type="button"
            data-testid="ghost-resolve-connect"
            title="Add an interaction edge between these two"
            onClick={onConnect}
            style={option}
          >
            Connect
          </button>
          <button
            type="button"
            data-testid="ghost-resolve-none"
            title="Record that these two intentionally do not interact"
            onClick={() => setNoneReason("")}
            style={option}
          >
            Intentionally none
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed) onNoInteraction(trimmed);
          }}
        >
          <textarea
            data-testid="ghost-resolve-reason"
            placeholder="Why do these not interact?"
            autoFocus
            value={noneReason}
            onChange={(event) => setNoneReason(event.target.value)}
            rows={2}
            style={textarea}
          />
          <div style={actions}>
            <button
              type="submit"
              data-testid="ghost-resolve-confirm"
              disabled={!trimmed}
              style={option}
            >
              Confirm
            </button>
            <button
              type="button"
              data-testid="ghost-resolve-cancel"
              onClick={() => setNoneReason(null)}
              style={option}
            >
              Back
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

const popover: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  zIndex: 20,
  background: "var(--surface)",
  border: "1px solid #c4b5fd",
  borderRadius: "10px",
  boxShadow: "0 6px 24px rgba(2, 8, 23, 0.18)",
  padding: "10px 12px",
  minWidth: "220px",
  maxWidth: "320px",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: "8px",
};

const title: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: 600,
  color: "var(--text)",
};

const closeButton: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "var(--text-2)",
  fontSize: "16px",
  cursor: "pointer",
  lineHeight: 1,
};

const reasonList: React.CSSProperties = {
  margin: "8px 0",
  paddingLeft: "18px",
  fontSize: "12px",
  color: "var(--violet)",
};

const actions: React.CSSProperties = { display: "flex", gap: "6px", marginTop: "6px" };

const textarea: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  fontSize: "12px",
  padding: "6px",
  borderRadius: "6px",
  border: "1px solid var(--border-strong)",
  resize: "vertical",
};

const option: React.CSSProperties = {
  flex: 1,
  fontSize: "12px",
  fontWeight: 600,
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid var(--border-strong)",
  background: "var(--surface)",
  color: "var(--text)",
  cursor: "pointer",
};
