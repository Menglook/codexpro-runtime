# Maintainer Workflows

These patterns describe how CodexPro can support open-source maintenance while preserving human authority.

## Common workflow shape

1. Bind the correct repository workspace.
2. Read project rules and contribution requirements.
3. Inspect the smallest relevant file set.
4. Define acceptance criteria before editing.
5. Apply bounded changes or create a handoff plan.
6. Run targeted validation.
7. Review changed files and evidence.
8. Let the maintainer decide whether to commit, merge, release, or deploy.

## Pull request preparation

Use CodexPro to:

- identify impacted modules and tests;
- summarize repository rules;
- prepare a focused patch;
- run typecheck, build, or project-specific validation;
- produce a changed-file and risk summary.

Keep these actions separate:

- creating a local commit;
- pushing a branch;
- opening a pull request;
- approving or merging a pull request.

The public runtime does not treat those repository operations as implicit consequences of a successful patch.

## Pull request review

A review-oriented session should prefer read-only tools and targeted validation.

Review questions:

- Does the patch match the issue scope?
- Which public APIs or schemas changed?
- Which security boundaries changed?
- Were new side effects introduced?
- Which tests or checks ran?
- What remains unverified?

A failed check must remain visible even when the code change looks plausible.

## Issue triage

A useful triage record separates:

- reporter claim;
- reproducible evidence;
- affected versions;
- suspected component;
- proposed next check;
- confirmed root cause;
- remediation status.

Do not turn an unverified issue description directly into an autonomous release task.

## Bug fix

Recommended acceptance contract:

- reproduce or identify the failing path;
- make the smallest sufficient change;
- add or update a focused regression check when possible;
- run the relevant build/typecheck/test command;
- report known gaps;
- preserve the maintainer's final commit and release decision.

## Security fix

Security changes require stronger boundaries:

- avoid public issue details before coordinated disclosure;
- use read-only inspection until the affected path is understood;
- avoid printing secret-shaped values;
- test fail-closed behavior;
- inspect auth, path, command, and logging implications;
- keep publication and deployment separate from remediation validation.

## Release readiness

CodexPro can collect evidence for:

- source build;
- type checking;
- package-content dry run;
- version consistency;
- documentation links;
- secret-scanning results;
- known limitations.

A release should not be created merely because these checks pass. The maintainer must still decide versioning, compatibility, changelog, signing, publication, and rollback strategy.

## Planning-only handoff

For tasks where the assistant should not edit source files:

- use a handoff-oriented capability profile;
- write only bounded planning artifacts;
- have a local executor read the plan;
- return test and diff evidence;
- keep the final acceptance decision with the maintainer.

## Multi-project work

Each conversation or task should retain an explicit workspace identity. Do not rely on one global active directory when multiple projects are in progress.

Before any side effect, verify:

- conversation identity;
- workspace identity;
- workspace generation;
- repository root;
- current task objective.

## Publication boundary

The public repository does not automatically publish npm packages, GitHub Releases, Pages sites, deployments, or pull requests. Each publication action requires separate authorization and evidence.
