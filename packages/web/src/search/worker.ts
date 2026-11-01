/**
 * The search worker: runs one analysis per message off the main thread, so a
 * search of several seconds does not freeze the page.
 */
import type { Model } from "@mechflow/core";
import { runSearch, type SearchRequest, type SearchResponse } from "./analyses.js";

export interface WorkerRequest {
  id: number;
  model: Model;
  request: SearchRequest;
}

export interface WorkerResponse {
  id: number;
  response: SearchResponse;
}

// The DOM lib types `self` as a window; in a worker it is the worker scope.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

scope.onmessage = (event) => {
  const { id, model, request } = event.data;
  scope.postMessage({ id, response: runSearch(model, request) });
};
