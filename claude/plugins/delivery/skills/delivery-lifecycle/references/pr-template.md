# Pull request description

Use the repository's `.github/pull_request_template.md` when it exists; otherwise this. Keep it scannable; reviewers read the first five lines.

```markdown
## What and why
<one or two sentences: the change and the problem it solves>. Plan: <link or "n/a">.

## Acceptance criteria
- [x] AC1 <short> — `tests/path.test.ts:12`
- [x] AC2 <short> — `tests/path.test.ts:40`
- [ ] AC3 deferred to slice 3 (<link>)

## How it was verified
| Check | Command | Result |
|---|---|---|
| Tests | `pnpm run test` | pass (212 tests, 41 s) |
| Typecheck | `pnpm run typecheck` | pass |
| Lint | `pnpm run lint` | pass |
| Secrets | `scan_secrets.ts --diff origin/main...HEAD` (delivery-lifecycle) | clean |
| Manual | <steps the user performed, if any> | <result> |

## Risk and rollout
- Risk: <low/medium/high with one-line reason; name security, data or performance areas touched>
- Rollout: <flag name and default | migration order | none>
- Rollback: <revert / flag off / down-migration>

## Notes for reviewers
- Start at `<path>`; <anything non-obvious>.
- Follow-ups (not in this PR): <items>
```

Do not include claims you did not verify. If a check was not run, write `not run (<reason>)`.
