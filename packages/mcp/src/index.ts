/**
 * @mechflow/mcp — a stdio MCP server that lets agents build and analyse
 * mechflow models. See packages/mcp/src/{server,patch,paths}.ts.
 */
export { createMcpServer, startStdioServer } from "./server.js";
export {
  applyOperations,
  applyPatchToFile,
  ModelParseError,
  ModelValidationError,
  PatchError,
  PatchOperationSchema,
  type PatchOperation,
} from "./patch.js";
export {
  ModelConflictError,
  PathEscapeError,
  readModelFile,
  resolveWithin,
  updateModelFile,
  writeModelFileAtomic,
} from "./paths.js";

export const PACKAGE = "@mechflow/mcp";
