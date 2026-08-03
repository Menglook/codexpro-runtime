# Project Memory: Rules

## Operating rules

- Prefer small, reviewable changes over broad rewrites.
- Preserve user-authored project memory unless explicitly asked to change it.
- Keep generated examples free of live credentials.
- Read the task preflight rule summary before changing files.
- Run the relevant local verification command before considering a stage complete.

## Engineering rules

- Record durable project conventions here, such as naming, directory ownership, API boundaries, release gates, and migration rules.
- Put temporary task instructions in `.ai-bridge/current-plan.md`, not in long-term memory.

## Product / business rules

- Add product-specific or business-specific constraints that should apply across future sessions.

## Safety notes

- Do not store live credentials or confidential personal data in project memory.

## CPU Safety / Heavy Validation Policy

- Do not run full test suites by default.
- Do not run `npm test`, `pytest`, `vitest`, `playwright`, `next build`, or other CPU-heavy validation without a clear target or explicit user approval.
- Do not automatically retry CPU-heavy validation after a tool 502, timeout, failed command, browser freeze, fan noise, system lag, or high CPU report.
- Prefer targeted single-file or single-command validation.
- For frontend tests, prefer serial execution with silent output, for example:
  `npm test -- <test-file> --runInBand --silent`
- If validation is likely to be heavy, provide the command for the user to run manually in their local terminal instead of running it through CodexPro.
- If the user reports high CPU or system lag, stop tool execution immediately and diagnose before continuing.
- Report partial validation results instead of repeatedly chasing a full green test suite.
