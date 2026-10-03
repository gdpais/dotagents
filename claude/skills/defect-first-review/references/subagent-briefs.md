# Subagent briefs

Use these when SKILL.md Step 3 chooses lens fan-out or path partition. Subagents run in parallel through Claude's Agent tool. The coordinator (the session running the skill) alone resolves the target, dedupes, verifies P0/P1, ranks, and writes the report.

## Rules for every subagent

- Read-only: no edits, no git state changes, no posting, no network calls except read access the coordinator already uses.
- No further delegation. A lens subagent does not spawn agents.
- Return candidates in the schema below, not a finished report. No priority inflation; `suggested_priority` is a suggestion.
- Report coverage honestly: which files/hunks were examined, which were skipped and why.

## Lens subagent brief (template)

```
You are the <LENS> lens of a defect-first code review. Read-only: do not modify files,
change git state, post comments, or start other agents.

Target: <PR #n head <sha> / merge base <sha> / "git diff <merge-base>" in <repo path>>
Files in scope: <all changed files | this partition: ...>
Instructions files that apply: <paths to CLAUDE.md / AGENTS.md>
Stated intent: <PR title + description / commit message>
User focus: <if any>

Checklist for your lens: <paste the lens section from coverage-lenses.md>

Examine every hunk in scope through your lens. Read callers, callees, and tests as needed
to decide whether a real call path reaches the problem. Propose a candidate only if you can
describe a concrete scenario. Do not propose pre-existing problems, intentional behavior
changes, or style preferences.

Return YAML:
candidates:
  - lens: <LENS>
    file: path
    lines: "a-b"            # smallest range overlapping the diff
    title: imperative, fix-oriented
    scenario: input/state/call path -> wrong behavior
    evidence: [files:lines and tests you read]
    would_refute: observation that would show this is not a defect
    suggested_priority: P0|P1|P2|P3
examined_no_candidates: [files or areas examined with nothing found]
not_examined: [files skipped, with reason]
```

## Verifier brief (template)

Use one verifier per batch of candidates when there are many; verify P0/P1 candidates with a fresh verifier or in the coordinator. Give the verifier the claim and location, **not** the lens's reasoning, so it checks the code rather than the argument.

```
You are verifying candidate findings from a code review. Read-only.

Target: <same identity as above>
For each candidate below, try to refute it:
- Is the cited code actually changed by this diff (compare with the merge-base version)?
- Does any real caller reach the described path? List the call sites you checked.
- Does a guard, validation, type, or config elsewhere prevent it?
- Does an existing test pin this behavior as intended?
- If running is permitted (<commands the coordinator allows, or "none">), run the narrowest check.

Return per candidate:
  id: <n>
  verdict: confirmed | plausible | refuted
  evidence: call sites / tests / checks, with file:line
  gap: (plausible only) the one link you could not inspect
  introduced_by_change: yes | no | unclear
  notes: priority concerns or a smaller citation, if any

Candidates:
<id, file, lines, title, scenario>
```

## Coordinator merge procedure

1. Collect candidates as they arrive; do not wait for all lenses before starting verification of early ones.
2. Deduplicate by root defect (same fix = same finding). Keep the clearest scenario and smallest citation.
3. Drop `refuted` and `introduced_by_change: no`. Move real-but-unverifiable unknowns to residual risks.
4. Decide final priority yourself from the calibration in SKILL.md Step 6.
5. Build the coverage note from `examined_no_candidates` and `not_examined`. If any hunk was examined by no lens, read it yourself before reporting.
