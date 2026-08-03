# Governance

CodexPro Runtime is currently an independently maintained source-preview project. This document describes the authority that exists today; it does not imply a foundation, company team, steering committee, or larger maintainer group.

## Current maintainer

The current primary maintainer is [Menglook](https://github.com/Menglook).

The primary maintainer is responsible for:

- architecture and public roadmap decisions;
- issue triage and pull-request review;
- security response coordination;
- public-boundary and licensing review;
- CI and regression-gate ownership;
- release, tag, and package-publication authorization;
- contributor documentation and community moderation.

Contributors, reviewers, automation, AI systems, and external tools do not become maintainers merely by submitting code, reviewing a change, or generating a patch.

## Decision process

Project decisions should begin in a public Issue or pull request unless the subject is a non-public security report or a Code of Conduct matter.

The project uses a consensus-seeking maintainer model:

1. State the problem, constraints, security impact, and validation plan.
2. Invite relevant technical feedback.
3. Prefer the smallest change that preserves the documented public and security boundaries.
4. Record material trade-offs in the Issue or pull request.
5. The primary maintainer makes the final repository decision and explains a rejection or significant scope change.

Silence, an automated check, or AI-generated text is not approval. Repository-host permissions and human maintainer review remain authoritative.

## Pull requests and merge authority

Anyone may open a pull request that follows [CONTRIBUTING.md](CONTRIBUTING.md).

A pull request may be merged only after:

- its scope is understood;
- required validation passes or any exception is explicitly documented;
- security and public-boundary effects are reviewed;
- licensing and attribution are acceptable;
- the primary maintainer approves the merge.

The project currently has no standing external reviewer or automatic merge authority.

## Releases and publication

Only the primary maintainer may authorize:

- Git tags;
- GitHub Releases;
- npm publication;
- public application or hosted-service announcements;
- changes to release credentials or repository protection.

The repository is currently a source preview. No npm package or GitHub Release is published. A merged change does not imply that a release will be created.

## Security responsibility

Security reports follow [SECURITY.md](SECURITY.md). Active vulnerability details, credentials, private source, customer data, and production configuration must not be posted in public Issues or pull requests.

The primary maintainer coordinates disclosure, remediation, and public advisories. A contributor may help with an authorized fix, but does not receive broader access by default.

## Maintainer addition

A new maintainer may be invited after demonstrating sustained, reviewable contributions and sound judgment in several of these areas:

- architecture and compatibility;
- security and failure-closed behavior;
- public/private boundary preservation;
- testing and release evidence;
- issue triage and respectful review.

Maintainer status requires an explicit invitation, acceptance of this governance model and the Code of Conduct, and least-privilege repository access. Any change in maintainership must be recorded in this document through a reviewed pull request.

There is no contribution-count threshold and no entitlement to maintainer access.

## Inactivity and stepping down

A maintainer may step down at any time. Repository access should be removed when the role ends. If a future maintainer becomes inactive, remaining maintainers should attempt private contact before changing access and should document the public governance change without disclosing personal information.

If the project has no active maintainer, the repository should be marked clearly as unmaintained or archived rather than implying active support.

## Disputes

Technical disagreements should remain in the relevant Issue or pull request and focus on evidence, scope, security, compatibility, and maintenance cost.

For a serious dispute involving the sole maintainer, the parties may ask a mutually acceptable experienced open-source maintainer for a non-binding review. Repository ownership and security authority remain with the repository owner unless formally transferred.

Code of Conduct reports are handled privately under [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), not argued in public threads.

## AI-assisted contributions

AI tools may assist with research, code, documentation, or review. The human submitter remains responsible for accuracy, licensing, security, validation, and disclosure of material assistance. A model or tool must not be represented as a human maintainer, reviewer, or independent contributor.