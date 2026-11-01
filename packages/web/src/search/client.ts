import type { Model } from "@mechflow/core";
import { runSearch, type SearchRequest, type SearchResponse } from "./analyses.js";
import type { WorkerRequest, WorkerResponse } from "./worker.js";

/** A search in progress: its result, and a way to stop waiting for it. */
export interface SearchJob {
  result: Promise<SearchResponse | null>;
  /** Stop the search; `result` then settles with null. */
  cancel: () => void;
}

let worker: Worker | null = null;
let nextId = 1;

/**
 * Run a search in the search worker. Where workers are missing (tests, old
 * browsers) it runs on the main thread after a tick, so the page can show
 * that it started. Cancelling terminates the worker; the next search starts
 * a fresh one.
 */
export function startSearch(model: Model, request: SearchRequest): SearchJob {
  let settle: (response: SearchResponse | null) => void = () => undefined;
  const result = new Promise<SearchResponse | null>((resolve) => (settle = resolve));

  if (typeof Worker === "undefined") {
    const timer = setTimeout(() => settle(runSearch(model, request)), 0);
    return {
      result,
      cancel: () => {
        clearTimeout(timer);
        settle(null);
      },
    };
  }

  worker ??= new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const own = worker;
  const id = nextId++;
  const onMessage = (event: MessageEvent<WorkerResponse>): void => {
    if (event.data.id !== id) return;
    own.removeEventListener("message", onMessage);
    settle(event.data.response);
  };
  const onError = (event: ErrorEvent): void => {
    own.removeEventListener("error", onError);
    settle({ ok: false, error: event.message || "the search worker failed" });
  };
  own.addEventListener("message", onMessage);
  own.addEventListener("error", onError);
  own.postMessage({ id, model, request } satisfies WorkerRequest);
  return {
    result,
    cancel: () => {
      own.terminate();
      if (worker === own) worker = null;
      settle(null);
    },
  };
}
