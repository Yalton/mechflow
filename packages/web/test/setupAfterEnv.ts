/**
 * Post-environment setup for the web vitest suite.
 *
 * Sets the React act-environment flag that `@testing-library/react`'s `act`
 * reads. Without it `act(...)` warns "environment not configured to support
 * act(...)", which can corrupt timers and swallow assertions. Mirrors what
 * RTL sets on import, so it is safe even if RTL's own set races.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
