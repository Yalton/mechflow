import type { Model } from "@mechflow/core";

/**
 * A run on a mechanics-only map, where the simulation has no resources to
 * move: waves of mechanics firing through the properties they share.
 *
 * - Step 1 fires every mechanic that reads nothing; when every mechanic reads
 *   something, step 1 fires them all.
 * - Each later step fires the mechanics that read a property written by a
 *   mechanic fired the step before. A mechanic never sets itself off.
 * - A step that fires nothing means the map has settled.
 *
 * Each step's links run from the mechanics it fired to the mechanics they set
 * off, naming the properties carried, so the canvas can show where the wave
 * goes next.
 */

export interface WaveLink {
  from: string;
  to: string;
  /** The properties `from` writes and `to` reads, sorted. */
  properties: string[];
}

export interface Wave {
  /** 1-based step number. */
  step: number;
  /** Mechanic ids fired in this step, sorted. */
  fired: string[];
  links: WaveLink[];
}

interface Mechanic {
  id: string;
  name: string;
  reads: readonly string[];
  writes: readonly string[];
}

function mechanicsOf(model: Model): Mechanic[] {
  return model.nodes
    .filter((n) => n.kind === "mechanic")
    .map((n) => n as unknown as Mechanic)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function linksFrom(mechanics: readonly Mechanic[], fired: readonly string[]): WaveLink[] {
  const links: WaveLink[] = [];
  for (const from of mechanics.filter((m) => fired.includes(m.id))) {
    for (const to of mechanics) {
      if (to.id === from.id) continue;
      const properties = from.writes.filter((p) => to.reads.includes(p)).sort();
      if (properties.length > 0) links.push({ from: from.id, to: to.id, properties });
    }
  }
  return links;
}

function wave(mechanics: readonly Mechanic[], step: number, fired: string[]): Wave {
  return { step, fired, links: linksFrom(mechanics, fired) };
}

/** The first wave, or null when the model has no mechanics. */
export function firstWave(model: Model): Wave | null {
  const mechanics = mechanicsOf(model);
  if (mechanics.length === 0) return null;
  const starters = mechanics.filter((m) => m.reads.length === 0);
  return wave(mechanics, 1, (starters.length > 0 ? starters : mechanics).map((m) => m.id));
}

/** The wave after `previous`; its `fired` is empty once the map has settled. */
export function nextWave(model: Model, previous: Wave): Wave {
  const mechanics = mechanicsOf(model);
  const fired = [...new Set(previous.links.map((l) => l.to))].sort();
  return wave(mechanics, previous.step + 1, fired);
}

/** A line saying what a wave fired, by name. */
export function describeWave(model: Model, current: Wave): string {
  if (current.fired.length === 0) return `Step ${current.step}: settled`;
  const name = (id: string): string => model.nodes.find((n) => n.id === id)?.name ?? id;
  return `Step ${current.step}: ${current.fired.map(name).join(", ")}`;
}
