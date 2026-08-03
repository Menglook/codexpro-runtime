# CodexPro Project Memory

This directory stores project-local memory for CodexPro-assisted work. It is separate from global assistant memory and from transient handoff files.

## Standard files

- `project.md`: stable project identity, stack, entry points, and important paths.
- `rules.md`: project-specific engineering, product, safety, and review rules.
- `decisions.md`: durable decisions with dates, rationale, and reversal notes.
- `glossary.md`: domain vocabulary, acronyms, and naming conventions.
- `handoff.md`: current stage, next actions, and operational notes for future sessions.

## Policy

- CodexPro reads and summarizes these files on request.
- CodexPro does not automatically write long-term memory. Add or update entries deliberately.
- Do not store secrets, API tokens, private keys, credentials, or sensitive personal data here.
- Keep entries concise, dated when useful, and stable enough to help future work.
