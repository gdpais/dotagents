# CLAUDE.md

## Language

- Reply in the language I write in. Portuguese means European Portuguese (PT-PT).
- A language I name for one output (e.g. "the email in Portuguese") applies to that output only.

## Tooling

- Run TypeScript and scripts with `bun` (`bun run`, `bun test`), not node/npm, unless the project uses something else.
- Use `gh` for GitHub. Prefer a CLI plus a skill over adding an MCP server.

## Think Before Doing

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- Ask only at real decisions: cost, irreversible or outward actions, open questions (real uncertainty about what I want counts). Do the mechanical steps a project policy already approves, then report them.
- If multiple interpretations exist, present them.
- If a simpler approach exists, say so. Push back when warranted.

## Simplicity First

**Minimum changes that solve the problem. Nothing speculative.**

- Don't spend tokens for nothing: read small inputs directly, skip helpers and subagents for small jobs.
- No features beyond what was asked.
- Prefer Anthropic's built-in skills and plugins; build custom ones only for a specific need.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

## Done Means Proven

- Before saying work is done, name the check that proves it: the command and its relevant output (exit code, test counts).
