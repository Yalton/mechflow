import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { compact } from "../src/graph/nodes/PoolNode.js";
import { EconomySymbol } from "../src/graph/nodes/Symbol.js";
import { SourceNode } from "../src/graph/nodes/SourceNode.js";
import type { NodeProps } from "reactflow";

describe("economy symbols", () => {
  it("draws the node's shape with its name underneath", () => {
    render(<EconomySymbol testId="flow-node-gate" shape="diamond" name="Drop chance" meta="random" />);
    const node = screen.getByTestId("flow-node-gate");
    expect(node.dataset.shape).toBe("diamond");
    expect(node.textContent).toContain("Drop chance");
    expect(node.textContent).toContain("random");
  });

  it("abbreviates pool amounts that would not fit the circle", () => {
    expect(compact(12)).toBe("12");
    expect(compact(9999)).toBe("9999");
    expect(compact(12_400)).toBe("12k");
    expect(compact(3_200_000)).toBe("3M");
  });

  it("marks an interactive source with a second outline and a per-fire rate", () => {
    const source = (activation?: "interactive") =>
      ({ data: { name: "Pray", node: { id: "pray", kind: "source", name: "Pray", rate: 1, activation } } }) as unknown as NodeProps;
    const { unmount } = render(<SourceNode {...source("interactive")} />);
    const node = screen.getByTestId("flow-node-source");
    expect(node.dataset.interactive).toBe("true");
    expect(screen.getByTestId("interactive-outline")).toBeTruthy();
    expect(node.textContent).toContain("+1 per fire");
    unmount();

    render(<SourceNode {...source()} />);
    expect(screen.getByTestId("flow-node-source").dataset.interactive).toBeUndefined();
    expect(screen.queryByTestId("interactive-outline")).toBeNull();
    expect(screen.getByTestId("flow-node-source").textContent).toContain("+1/step");
  });
});
