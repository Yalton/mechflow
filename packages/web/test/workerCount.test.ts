import { describe, expect, it } from "vitest";
import { workerCount } from "../vitest.workers.js";

const GB = 1024 ** 3;

describe("vitest worker count", () => {
  it("uses the default (cores - 1) on an idle machine", () => {
    expect(workerCount(16, 0, 32 * GB)).toBe(15);
  });

  it("drops to the idle cores under load and to 2 when the host is saturated", () => {
    expect(workerCount(16, 10, 32 * GB)).toBe(6);
    expect(workerCount(16, 57, 32 * GB)).toBe(2);
  });

  it("allows one worker per 512 MB of free memory", () => {
    expect(workerCount(16, 0, 2 * GB)).toBe(4);
  });
});
