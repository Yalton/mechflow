import type { NodeProps } from "reactflow";
import type { PoolNode as PoolCore } from "@mechflow/core";
import { EconomySymbol } from "./Symbol.js";

/**
 * Economy pool: a circle holding its amount. The amount is the start amount,
 * or the current amount (amber) while a run is active; a capacity shows under
 * the name. A small whole amount (up to {@link MAX_DOTS}) is drawn as dots, as
 * in Machinations, with the number on hover.
 */
export function PoolNode({ data }: NodeProps) {
  const pool = data.node as PoolCore;
  const capacity = pool.capacity ?? 0;
  const running = data.runAmount !== undefined;
  const amount: number = running ? data.runAmount : pool.start;
  return (
    <EconomySymbol
      testId="flow-node-pool"
      shape="circle"
      name={data.name}
      tier={data.tier}
      chain={data.chain}
      interactive={pool.activation === "interactive"}
      tracePolarity={data.tracePolarity}
      inside={
        Number.isInteger(amount) && amount > 0 && amount <= MAX_DOTS ? (
          <span
            data-testid="pool-amount"
            data-running={String(running)}
            data-dots={amount}
            title={String(amount)}
            style={dotsBox}
          >
            {Array.from({ length: amount }, (_, i) => (
              <span key={i} aria-hidden style={{ ...dot, ...(running ? { background: "var(--moving)" } : {}) }} />
            ))}
            <span style={hidden}>{amount}</span>
          </span>
        ) : (
        <span
          data-testid="pool-amount"
          data-running={String(running)}
          title={String(amount)}
          style={{ fontSize: amountSize(amount), ...(running ? { color: "var(--moving)" } : {}) }}
        >
          {compact(amount)}
        </span>
        )
      }
      meta={capacity > 0 ? `max ${capacity}` : undefined}
    />
  );
}

/** Fit an amount inside the circle: big numbers shrink, then abbreviate. */
export function compact(amount: number): string {
  const abs = Math.abs(amount);
  if (abs < 10_000) return String(Math.round(amount * 100) / 100);
  if (abs < 1_000_000) return `${Math.round(amount / 1000)}k`;
  return `${Math.round(amount / 1_000_000)}M`;
}

function amountSize(amount: number): string {
  const length = compact(amount).length;
  return length <= 2 ? "12px" : length === 3 ? "10.5px" : "9px";
}

/** Largest whole amount drawn as dots instead of a number. */
export const MAX_DOTS = 9;

const dotsBox: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 5px)",
  gap: "2px",
  justifyContent: "center",
};

const dot: React.CSSProperties = {
  width: "5px",
  height: "5px",
  borderRadius: "50%",
  background: "var(--text-2)",
};

// Off screen but read by screen readers (and by textContent).
const hidden: React.CSSProperties = {
  position: "absolute",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};
