# Contributing

CodexPro Runtime is an early public source preview. Good contributions make the runtime safer, more testable, easier to explain, and more useful to open-source maintainers.

External contributors should be able to complete a first contribution through public Issues and pull requests without private setup instructions.

## Before you start

Read the documents relevant to your change:

- [README.md](README.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Public boundary](docs/public-boundary.md)
- [Governance](GOVERNANCE.md)
- [Roadmap](ROADMAP.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)

Changes must remain generic and independent of private operational configuration.

## Choose the correct public route

- Reproducible defect: use the Bug report form.
- Bounded capability proposal: use the Feature request form.
- Documentation problem: use the Documentation improvement form.
- Real public use case: use the Adoption feedback form.
- Security vulnerability: follow [SECURITY.md](SECURITY.md) and do not open a public Issue.
- Code of Conduct concern: use the private reporting route in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Blank Issues are disabled so reports collect enough reproduction, risk, and validation information.

## Local setup

Requirements: Git, Node.js 20 or newer, and npm.

```bash
git clone https://github.com/Menglook/codexpro-runtime.git
cd codexpro-runtime
npm ci --ignore-scripts --no-audit --no-fund
npm run docs:check
npm run typecheck
npm run build
npm run cli:help
npm run package:check
```

The initial install disables lifecycle scripts. These commands validate the public source tree; they do not publish npm, create a GitHub Release, deploy a service, start a public tunnel, or connect an external account.

## Start with an Issue

A focused typo or obvious documentation correction may go directly to a pull request. For behavior, architecture, security, compatibility, CI, or package-boundary changes, open or claim a public Issue first.

A useful Issue includes:

- affected public commit or branch;
- operating system, Node.js version, and relevant non-sensitive mode;
- numbered reproduction steps against public or disposable content;
- expected and actual behavior;
- sanitized evidence;
- highest side-effect level involved;
- focused checks already run;
- what remains unverified.

The `needs reproduction` label means maintainers need clearer public steps or evidence before implementation can proceed.

## Contribution scope

Keep pull requests small enough to review as one technical decision. Avoid mixing refactors, formatting, dependency changes, new behavior, and documentation cleanup unless they are inseparable.

Good contribution areas include:

- safer capability defaults;
- clearer authorization and failure outcomes;
- workspace isolation and path-guard checks;
- durable task, validation, review, and recovery evidence;
- smaller and faster context handling;
- reusable MCP and browser primitives;
- documentation that reduces setup and security mistakes;
- cross-platform source-build fixes.

The current bounded newcomer tasks are tracked in [ROADMAP.md](ROADMAP.md).

## Focused validation

Run the smallest checks that cover the change, then state what was not tested.

| Change area | Minimum focused checks |
|---|---|
| Markdown or documentation links | `npm run docs:check` |
| TypeScript behavior or public types | `npm run typecheck` and `npm run build` |
| CLI behavior | `npm run cli:help` plus the relevant focused command |
| Package contents or public export boundary | `npm run package:check` and `npm run pack:dry-run` |
| GitHub Issue or PR templates | Parse changed YAML where applicable and review the rendered field requirements |
| Security-sensitive behavior | Focused positive and negative cases, typecheck, build, and the relevant boundary check |

Do not add a broad framework only to validate one small change. Do not report a failed or skipped check as passed.

## Pull request content

Use the pull-request template and include:

- the problem and linked Issue;
- changed areas and explicit non-goals;
- compatibility impact;
- security and side-effect analysis;
- public/private boundary impact;
- exact validation commands and results;
- untested behavior;
- documentation changes;
- material AI assistance.

The primary maintainer performs final review and merge decisions under [GOVERNANCE.md](GOVERNANCE.md). A green CI run is necessary evidence for covered checks, not automatic merge approval.

## Security and public boundary

For changes touching authentication, file access, shell execution, redaction, network exposure, browser control, Git operations, or workspace binding:

- describe the threat or failure mode;
- identify new authority and data exposure;
- explain fail-open and fail-closed behavior;
- add a focused negative test or verification path;
- avoid posting active vulnerability details publicly before disclosure coordination.

Do not include:

- credentials, tokens, cookies, or private keys;
- `.env` values;
- private repository contents or URLs;
- customer or business data;
- production hostnames, tunnel identity, or deployment configuration;
- local machine paths or usernames;
- `.codexpro` runtime evidence;
- `.ai-bridge` task snapshots;
- internal reports, screenshots, or benchmark evidence.

Follow [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Documentation style

- Be concrete and testable.
- Avoid hype, implied endorsements, and unsupported adoption claims.
- Name exact commands, modes, flags, and failure cases.
- Distinguish source preview, npm package, GitHub Release, app, and hosted-service status.
- Use `/path/to/repo` and `codexpro.example.com` placeholders.
- Do not claim upstream metrics as this repository's adoption.
- Keep English and Chinese navigation consistent when changing top-level project status.

## AI-assisted contributions

AI tools may assist with research, code, documentation, or review. Disclose material assistance in the pull-request template. The human submitter must review the result and remains responsible for correctness, licensing, security, provenance, and validation.

Do not represent a model or tool as a human maintainer, independent reviewer, or community contributor.

## Licensing, DCO, and CLA

The project currently requires neither a separate Contributor License Agreement nor mandatory Developer Certificate of Origin sign-off.

By submitting a contribution, you confirm that you have the right to provide it under the repository MIT License and that required third-party attribution is included. Do not submit copied code, documentation, generated output, or data when licensing or provenance is unclear.

This policy may be reviewed before a packaged release or a material governance change. Any future change will be documented publicly and will not be applied retroactively without explanation.

## Maintainer response and triage

There is currently one primary maintainer and no response-time SLA.

The maintainer may:

- request reproduction or narrower scope;
- apply labels such as `bug`, `enhancement`, `documentation`, `security`, `needs reproduction`, `good first issue`, or `help wanted`;
- close duplicates, unsupported private-operation requests, unsafe disclosures, or proposals outside the public boundary;
- ask that a large proposal be split before review;
- leave an Issue open when it is valid but not currently prioritized.

No response, label, roadmap placement, or automated check is a promise of implementation or release.

## Share a real use case

Use the [Adoption feedback issue form](https://github.com/Menglook/codexpro-runtime/issues/new?template=adoption-feedback.yml) to share a reproducible public use case. Participation is voluntary and no payment, review incentive, or other reward is offered. Quotations require the author's explicit optional permission in the form.

## Community conduct

All participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Keep technical disagreement evidence-based and respectful.
