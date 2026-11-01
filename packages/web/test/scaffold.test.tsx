import { describe, expect, it } from "vitest";
import { PACKAGE } from "../src/main";

describe("scaffold", () => {
  it("exposes its package name", () => {
    expect(PACKAGE).toBe("@mechflow/web");
  });
});
