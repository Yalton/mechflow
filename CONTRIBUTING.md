# Contributing to mechflow

Thanks for your interest. Bug reports, example models and pull requests are
all welcome.

## Setup

You need Node 22 or later and pnpm 9.

```bash
pnpm install
pnpm -r build
```

See the [README](README.md) for running the app and the MCP server.

## Before you open a pull request

Run the same checks CI runs, from the repository root:

```bash
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

Add or update tests for any behaviour you change. Tests use Vitest and live in
each package's `test/` folder. Tests read the models in `fixtures/examples/`,
never `models/`, which users edit through the app.

Format code with Prettier (`npx prettier --write <files>`). Commit messages
follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `chore:` and so on).

## Code rules

The rules that keep the codebase coherent are in [AGENTS.md](AGENTS.md). The
short version:

- `packages/core` has no DOM, filesystem or network code. Its only IO is YAML
  parse and serialize.
- Formulas are never evaluated with `eval` or `Function`. Use the evaluator in
  `packages/core/src/formula/evaluate.ts`.
- Every simulation run takes an explicit seed. Never use `Math.random()` for a
  reproducible run.
- Simulation behaviour follows `docs/simulation-semantics.md`. Change the spec
  in the same pull request as the engine.
- Every analysis check returns findings in the shared `Finding` shape.

## Reporting bugs

Open an issue with the model YAML that shows the problem (cut it down to the
smallest model you can), what you expected, and what happened.

## Security

The local server has no authentication and is meant for your own machine. If
you find a way to reach model files or the host from outside that, please
report it privately to the maintainer rather than in a public issue.
