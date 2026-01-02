# Task Completion Checklist

## Before Completing Any Task

### 1. Quality Gates (if code changed)
```bash
npm run build        # Must pass without type errors
npm test             # All tests must pass
npm run test:coverage # Maintain 80%+ coverage
```

### 2. Commit Changes
- Use concise, imperative commit messages (e.g., `Add network throttling command`)
- Reference related issues in commit body
- Flag breaking changes prominently

### 3. Push to Remote (MANDATORY)
```bash
git pull --rebase
git push
git status           # Must show "up to date with origin"
```

## Critical Rules
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- If push fails, resolve and retry until it succeeds

## For Feature Work
1. Create feature branch
2. Implement changes
3. Add/update tests
4. Run quality gates
5. Commit with descriptive message
6. Push and create MR via `glab mr create`

## For Bug Fixes
1. Write failing test first (if applicable)
2. Fix the bug
3. Ensure test passes
4. Run full test suite
5. Commit and push
