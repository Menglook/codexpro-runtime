# Adoption Evidence

This document records only adoption signals attributable to `Menglook/codexpro-runtime`.
It does not borrow stars, forks, downloads, contributors, issues, pull requests, traffic,
or testimonials from the upstream `rebel0789/codexpro` project or from the private
CodexPro implementation.

## Current status

CodexPro Runtime is a public **source preview**. The repository is available, but the
npm package is not published, there is no GitHub Release, and no hosted service is
provided.

[![GitHub stars](https://img.shields.io/github/stars/Menglook/codexpro-runtime?style=flat)](https://github.com/Menglook/codexpro-runtime/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/Menglook/codexpro-runtime?style=flat)](https://github.com/Menglook/codexpro-runtime/forks)
[![GitHub watchers](https://img.shields.io/github/watchers/Menglook/codexpro-runtime?style=flat)](https://github.com/Menglook/codexpro-runtime/watchers)
[![Open issues](https://img.shields.io/github/issues/Menglook/codexpro-runtime)](https://github.com/Menglook/codexpro-runtime/issues)
[![Last commit](https://img.shields.io/github/last-commit/Menglook/codexpro-runtime)](https://github.com/Menglook/codexpro-runtime/commits/main)

Badges are live GitHub metadata. The dated snapshot below is the reproducible baseline
used for the OSS application evidence package.

## Dated baseline

**Captured:** 2026-08-03 16:46:44 UTC  
**Repository:** `Menglook/codexpro-runtime`  
**Authority:** GitHub REST API, GitHub GraphQL API, npm downloads API, and npm registry

| Signal | Baseline | Interpretation |
|---|---:|---|
| Stars | 0 | Repository interest signal; not an active-user count |
| Forks | 0 | Repository fork signal; not proof that a fork is deployed or used |
| Watchers / subscribers | 0 | GitHub notification subscriptions; not product users |
| Contributors | 1 | Repository owner only; 3 attributed contributions |
| Open / closed issues | 0 / 0 | No public issue activity at capture time |
| Open / merged / closed PRs | 0 / 0 / 0 | No public pull-request activity at capture time |
| Commits in preceding 30 days | 3 | Counted from repository commits API |
| Commits in preceding 90 days | 3 | Counted from repository commits API |
| Repository views, trailing 14 days | 0 total / 0 unique | Owner-authorized GitHub traffic aggregate |
| Repository clones, trailing 14 days | 0 total / 0 unique | Owner-authorized GitHub traffic aggregate |
| npm weekly downloads | Not applicable | Package endpoint returned `404 package not found` |
| npm monthly downloads | Not applicable | Package endpoint returned `404 package not found` |
| GitHub Releases | 0 | No published, draft, or prerelease entries |
| Independently attributable public case studies | 0 | None found or authorized at capture time |

A zero value is still a valid baseline. It must not be rewritten as adoption, hidden, or
combined with metrics from another repository.

## Measurement method

### GitHub repository metadata

Stars, forks, subscribers, default branch, repository timestamps, and release state are
queried from GitHub's official repository APIs. Contributors are queried from the
contributors endpoint. Issue and pull-request totals are queried separately through
GitHub GraphQL so issues and pull requests are not conflated.

### Traffic retention

GitHub exposes repository views, clones, and popular referrers for a rolling 14-day
window. A native 30-day or 90-day traffic export is therefore not claimed. Longer
windows can only be produced prospectively by archiving repeated, non-overlapping
14-day snapshots and documenting the aggregation method.

Traffic aggregates are maintainer-visible evidence. They are not used to identify
visitors, and no additional telemetry is added by CodexPro Runtime.

### npm status

The package name reserved in `package.json` is `@menglook/codexpro`, with
`private: true`. At capture time both the official npm registry and official npm
download endpoints returned package-not-found responses. The correct state is
**unpublished / downloads not applicable**, not zero downloads.

### Active-user claims

This repository does not currently have a reliable active-user measurement. Stars,
forks, watchers, clones, downloads, issues, and contributors are different signals and
must not be combined or relabeled as active users.

## Maintainer-operated validation scenarios

The following scenarios are real workflows used to shape and verify the public source,
but they are **maintainer-operated scenarios**, not independent third-party adoption:

1. **Single-repository local engineering** — bind one source workspace, inspect a
   bounded file set, apply reviewed changes, run targeted checks, and inspect the diff.
2. **Multi-project isolation** — retain conversation-scoped workspace identity so two
   simultaneous projects do not share one mutable global directory authority.
3. **Code review and security work** — prefer read-only inspection, preserve failed
   checks, and keep auth, path, command, logging, and publication decisions explicit.
4. **Planner and local executor split** — create a bounded handoff artifact while a
   user-started local agent performs implementation and returns evidence.
5. **Windows and WSL development** — run the local runtime inside WSL while preserving
   explicit workspace and process boundaries.

These scenarios demonstrate design intent and maintainer experience. They will not be
presented as external testimonials.

## Independent use cases and quotations

No independent public use case or authorized third-party quotation is claimed in this
baseline.

Users may voluntarily open an
[Adoption feedback issue](https://github.com/Menglook/codexpro-runtime/issues/new?template=adoption-feedback.yml)
to describe a reproducible use case. The form:

- does not request credentials, private source, customer data, or production details;
- offers no payment, review incentive, or other reward;
- makes quotation permission explicit and optional;
- keeps security reports on the private path described in [SECURITY.md](../SECURITY.md).

A public issue may be referenced as a public record. Text will not be quoted in an
application, website, or testimonial without explicit permission from the author.

## Ecosystem context, not repository adoption

The broader upstream project has independent public coverage, including:

- [What is codexpro?](https://whatisgithub.com/rebel0789/codexpro)
- [ChatGPT Web, On a Short Leash in Your Repo](https://heatdrop.ai/repo/rebel0789/codexpro)
- [SourceForge mirror of the upstream project](https://sourceforge.net/projects/codexpro.mirror/)
- [LinkedIn discussion of the upstream repository](https://www.linkedin.com/posts/the-voting-vault_rebel0789codexpro-use-chatgpt-developer-activity-7473760890643763200-7gLa)

These links show that the problem space has attracted outside attention. They refer to
`rebel0789/codexpro`, not `Menglook/codexpro-runtime`, and therefore are not counted as
this repository's dissemination, adoption, downloads, testimonials, or case studies.

## Evidence acceptance rule

A future adoption record can be added only when it is:

1. attributable to this repository or its released package;
2. timestamped;
3. publicly verifiable or retained with explicit permission;
4. classified by signal type instead of converted into an active-user claim; and
5. free of credentials, private business data, customer data, and private runtime
   evidence.

Until those conditions are met, the repository will report the gap rather than infer
adoption.