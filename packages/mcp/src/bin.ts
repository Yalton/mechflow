#!/usr/bin/env node
import { startStdioServer } from "./server.js";

interface CliArgs {
  models?: string;
  help?: boolean;
}

const USAGE = "Usage: mechflow-mcp --models <dir>\n\n" +
  "  --models, -m <dir>  Models root directory the server operates on.\n" +
  "  --help, -h          Show this help.\n";

/** Minimal argv parser: supports `--key value`, `--key=value`, and flags. */
function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = arg.startsWith("--") ? arg.slice(2, eq === -1 ? undefined : eq) : arg.slice(1);
    const inlineValue = eq !== -1 ? arg.slice(eq + 1) : undefined;
    switch (name) {
      case "models":
      case "m":
        args.models = inlineValue ?? argv[++i];
        break;
      case "help":
      case "h":
        args.help = true;
        break;
      default:
        process.stderr.write(`Unknown argument: ${arg}\n\n${USAGE}`);
        args.help = true;
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!args.models) {
    process.stderr.write(`Missing required --models <dir>\n\n${USAGE}`);
    process.exit(1);
    return;
  }
  await startStdioServer(args.models);
}

main().catch((err) => {
  process.stderr.write(`mechflow-mcp: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
