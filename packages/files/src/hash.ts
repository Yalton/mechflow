import { createHash } from "node:crypto";

/**
 * Content hash for a model's YAML text.
 *
 * The same function backs three places that must agree:
 * - the GET response reports it, so the browser can echo it back in If-Match,
 * - the PUT handler recomputes it to detect a remote edit since that hash,
 * - the watcher emits it on `model-changed`, so a live-updated browser keeps a
 *   valid If-Match for its next save.
 *
 * sha1 of the UTF-8 bytes of the YAML text.
 */
export function hashYaml(yaml: string): string {
  return createHash("sha1").update(yaml, "utf8").digest("hex");
}

/**
 * Compare an If-Match value against a content hash. Tolerates optional
 * surrounding quotes (as an ETag would carry) and case differences.
 */
export function hashesMatch(current: string, ifMatch: string): boolean {
  const given = ifMatch.trim().replace(/^"|"$/g, "").toLowerCase();
  return given.length > 0 && given === current.toLowerCase();
}
