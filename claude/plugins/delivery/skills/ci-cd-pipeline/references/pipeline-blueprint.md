# Pipeline blueprint (GitHub Actions)

A starting point that maps each delivery gate to a job. Replace `<…>` placeholders, swap the setup step for the stack, and pin every `uses:` to a full commit SHA (shown here as `@<sha>  # vX` so the version stays readable; resolve real SHAs with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`).

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  checks:                       # Definition of Done: format, lint, typecheck
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<sha>  # v4
        with: { persist-credentials: false }
      - uses: oven-sh/setup-bun@<sha>  # v2   (or actions/setup-node, setup-python, setup-go)
      - run: bun install --frozen-lockfile
      - run: <format check command>
      - run: <lint command>
      - run: <typecheck command>

  test:                         # Definition of Done: tests
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<sha>  # v4
        with: { persist-credentials: false }
      - uses: oven-sh/setup-bun@<sha>  # v2
      - run: bun install --frozen-lockfile
      - run: <test command>

  security:                     # Merge gate: secrets + dependencies
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<sha>  # v4
        with: { fetch-depth: 0, persist-credentials: false }
      - uses: gitleaks/gitleaks-action@<sha>  # v2   (or delivery-lifecycle's scan_secrets.ts --diff)
      - if: github.event_name == 'pull_request'
        uses: actions/dependency-review-action@<sha>  # v4
        with: { fail-on-severity: high }

  build:
    needs: [checks, test, security]
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<sha>  # v4
        with: { persist-credentials: false }
      - run: <build command>
      - uses: actions/upload-artifact@<sha>  # v4
        with: { name: build, path: <output dir> }
```

Separate deploy workflow (runs only from `main` or tags, protected environment):

```yaml
name: Deploy
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  id-token: write               # OIDC to the cloud; no long-lived keys
concurrency:
  group: deploy-production
  cancel-in-progress: false     # never cancel a deploy halfway

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    environment: production      # required reviewers configured in repo settings
    steps:
      - uses: actions/checkout@<sha>  # v4
        with: { persist-credentials: false }
      - run: <deploy command using the artifact built for this tag>
      - run: <smoke test against the deployed version; fail the job on error>
```

SAST (optional, where mature for the stack): `github/codeql-action` init/analyze in a scheduled and PR workflow with `security-events: write` on that job only.

Keep the action pins current with Dependabot:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly }
```
