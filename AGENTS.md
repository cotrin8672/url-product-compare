# Project rules

- On this Windows host, follow `C:\Users\gummy\.codex\RTK.md` and prefix shell commands with `rtk`.
- Use `mise` for pinned Node.js/pnpm versions and task execution. `mise run verify` is the acceptance check.
- TypeScript uses ESM, named exports, `type`, separate `import type`, and explicit return types at public boundaries. Prefer readonly inputs and inference internally.
- Use `satisfies` or annotations for owned objects; validate external `unknown` with schemas. Do not bypass checks with assertions, non-null assertions, suppression comments or discarded Promises.
- Workspace modules belong in `apps/*` and `packages/*`. Future web code uses only the API client for comparison data. API and worker delegate to backend; comparison logic never imports frameworks, DB or queues. Concrete dependencies are wired at bootstrap.
- Lint/formatter/TypeScript configs, exclusions, dependencies, lockfiles, mise tasks, CI, generation rules, guardrail tests and CODEOWNERS require human review. This initial setup is authorized. Later, do not weaken checks or add dependencies without approval.
- Exceptions belong in the central ESLint config, limited to exact roles/files with a reason. Never delete a failing acceptance test to make checks pass.
- Run all checks before completion; report failures honestly. Do not merge or change remote protection settings autonomously.
