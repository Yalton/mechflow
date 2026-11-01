/**
 * Wire types for the mechflow web app.
 *
 * These mirror the server's `ModelWatchEvent` (packages/server/src/watch.ts)
 * but are declared locally so the browser app does not depend on the server
 * package. Keep them in sync when the broadcast shape changes.
 */

/** A model was (re)written on disk. `hash` is the server's content hash. */
export interface ModelChangedEvent {
  type: "model-changed";
  path: string;
  hash: string;
}

/** A model file was deleted from disk. */
export interface ModelRemovedEvent {
  type: "model-removed";
  path: string;
}

/** Any event broadcast over `/ws`. */
export type ModelWatchEvent = ModelChangedEvent | ModelRemovedEvent;
