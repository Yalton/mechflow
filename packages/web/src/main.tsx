import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "reactflow/dist/style.css";
import "./styles.css";
import { App } from "./App.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { applyTheme, storedTheme } from "./theme.js";

/** Package name, exposed for diagnostics and tests. */
export const PACKAGE = "@mechflow/web";

// Before the first render, so the page never flashes the wrong theme.
applyTheme(storedTheme());

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary
        area="mechflow"
        hint="Reload the page to continue. Your saved models are unaffected."
      >
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
