# Personal agent instructions

Loaded in every project (symlinked as `~/.claude/CLAUDE.md`). Project files, hooks and settings take precedence. Keep it under 40 lines: only what can't be inferred from a repo.

## Language
- Reply in the language I write in. Portuguese means European Portuguese (PT-PT).
- A language I name for one output (e.g. "the email in Portuguese") applies to that output only.

## Tooling
- Run TypeScript and scripts with `bun` (`bun run`, `bun test`), not node/npm, unless the project uses something else.
- Use `gh` for GitHub. Prefer a CLI plus a skill over adding an MCP server.

## Done means proven
- Before saying work is done, name the check that proves it: the command and its relevant output (exit code, test counts).
- If no test covers the new behaviour, add one or say exactly what you verified and how.

## Cost
- Don't spend tokens for nothing: read small inputs directly, skip helpers and subagents for small jobs, and drop optional steps that don't change the answer.
- Prefer Anthropic's built-in skills and plugins; build custom ones only for a specific need.

## Decisions
- Ask only at real decisions: cost, irreversible or outward actions, open questions. Do the mechanical steps a project policy already approves, then report them.
