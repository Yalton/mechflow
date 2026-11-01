import { describe, expect, it } from "vitest";
import { parseModelYaml, serializeModelYaml } from "../../src/model/io.js";

const YAML = `
version: 1
name: M
description: A minimal model.
properties:
  - id: temp
    kind: number
    description: Temperature.
subsystems:
  - id: s
    name: System
    role: core
    tier: core
nodes:
  - id: fire
    kind: mechanic
    name: Fire
    subsystem: s
    position:
      x: 10
      y: 20
    reads: []
    writes:
      - temp
edges: []
noInteraction: []
invariants: []
`;

describe("parseModelYaml", () => {
  it("parses a valid model", () => {
    const r = parseModelYaml(YAML);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.model.name).toBe("M");
      expect(r.model.nodes[0]?.kind).toBe("mechanic");
    }
  });

  it("reports a YAML syntax error", () => {
    const r = parseModelYaml("version: 1\n name: [bad");
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected parse error");
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors[0]?.message.length).toBeGreaterThan(0);
  });

  it("round-trips: serialize then parse yields an identical model", () => {
    const parsed = parseModelYaml(YAML);
    if (!parsed.ok) throw new Error("parse failed");
    const reparsed = parseModelYaml(serializeModelYaml(parsed.model));
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) expect(reparsed.model).toEqual(parsed.model);
  });

  it("serializes with a stable key order", () => {
    const out = serializeModelYaml(parseModelYaml(YAML).model);
    const order = [
      "version",
      "name",
      "description",
      "properties",
      "subsystems",
      "nodes",
      "edges",
    ];
    const positions = order.map((k) => out.indexOf(`${k}:`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("omits empty noInteraction and invariants arrays", () => {
    const out = serializeModelYaml(parseModelYaml(YAML).model);
    expect(out).not.toContain("noInteraction:");
    expect(out).not.toContain("invariants:");
  });
});
