import { useMemo } from "react";
import { useStore } from "reactflow";
import { CARD_SIZE } from "../../layout/forceLayout.js";
import { SYMBOL_SIZE } from "../nodes/Symbol.js";
import { avoidingPath, pointPath, type FloatingPath, type Shape } from "./floating.js";
import type { Box, Point } from "./labelPlacement.js";

/** Node kinds drawn as cards; every other kind is a symbol (nodes/Symbol.tsx). */
const CARD_KINDS = new Set(["mechanic", "entity"]);

export type NodeBox = Box & { id: string; type?: string };

/**
 * The floating path between two nodes (see floating.ts), plus every node's box
 * for label placement. Economy nodes are met at their symbol, treated as a
 * circle; cards at their border. The curve bends further out when it would
 * run through another node (avoidingPath). Falls back to the handle points until the
 * nodes are known.
 */
export function useFloatingPath(
  source: string,
  target: string,
  from: Point,
  to: Point,
): { path: FloatingPath; cards: NodeBox[] } {
  const nodeInternals = useStore((s) => s.nodeInternals);
  const cards: NodeBox[] = useMemo(
    () => [...nodeInternals.values()].map((n) => {
      // Measured sizes once rendered; the layout's card sizes before that (and in jsdom).
      const fallback = CARD_SIZE[n.type as keyof typeof CARD_SIZE] ?? { width: 56, height: 56 };
      const at = n.positionAbsolute ?? n.position;
      return {
        id: n.id,
        type: n.type,
        x: at.x,
        y: at.y,
        width: n.width ?? fallback.width,
        height: n.height ?? fallback.height,
      };
    }),
    [nodeInternals],
  );
  const path = useMemo(() => {
    const shape = (nodeId: string): Shape | undefined => {
      const card = cards.find((c) => c.id === nodeId);
      if (!card) return undefined;
      if (CARD_KINDS.has(card.type ?? "")) return { ...card, round: false };
      // Edges meet the symbol at the top centre of the node, not its name.
      return {
        x: card.x + card.width / 2 - SYMBOL_SIZE / 2,
        y: card.y,
        width: SYMBOL_SIZE,
        height: SYMBOL_SIZE,
        round: true,
      };
    };
    const a = shape(source);
    const b = shape(target);
    if (!a || !b) return pointPath(from, to);
    // Bend around every other node, name and all.
    return avoidingPath(a, b, cards.filter((c) => c.id !== source && c.id !== target));
  }, [cards, source, target, from.x, from.y, to.x, to.y]);
  return { path, cards };
}
