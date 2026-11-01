import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "../src/ErrorBoundary.js";

let shouldThrow = true;
function Boom(): JSX.Element {
  if (shouldThrow) throw new TypeError("Cannot read properties of undefined (reading 'x')");
  return <p>graph ok</p>;
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    shouldThrow = true;
    vi.restoreAllMocks();
  });

  it("shows the error instead of unmounting everything", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <p>sidebar</p>
        <ErrorBoundary area="The graph view" hint="Pick another model.">
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    const alert = screen.getByTestId("error-boundary");
    expect(alert.textContent).toContain("The graph view crashed.");
    expect(alert.textContent).toContain("reading 'x'");
    expect(alert.textContent).toContain("Pick another model.");
    expect(screen.getByText("sidebar")).toBeDefined();
  });

  it("renders the children again on Try again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary area="The graph view">
        <Boom />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByText("Try again"));
    expect(screen.getByText("graph ok")).toBeDefined();
  });

  it("resets when resetKey changes", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary area="The graph view" resetKey="a.yaml">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("error-boundary")).toBeDefined();
    shouldThrow = false;
    rerender(
      <ErrorBoundary area="The graph view" resetKey="b.yaml">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("graph ok")).toBeDefined();
  });
});
