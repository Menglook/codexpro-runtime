# Changelog

All notable public changes to CodexPro Runtime are documented here.

This repository is currently a **source preview**. Version `0.1.0` is a release candidate identifier in the package manifest; it is not an npm publication, Git tag, or GitHub Release.

## [Unreleased]

### Added

- Reproducible tarball fresh-install and release-readiness checks.
- Source-candidate documentation that separates source, npm, Release, Pages, and hosted-service gates.

### Changed

- Public validation now covers documentation, type checking, build, CLI help, security controls, demo assets, package boundary, release readiness, and tarball installation.

## 0.1.0 source candidate — 2026-08-04

### Added

- Local MCP stdio and Streamable HTTP entry points.
- Workspace guards, task and job runtime, structured evidence, review, recovery, and optional local handoff primitives.
- Generic browser authorization and browser-skill primitives.
- Bilingual README, Quickstart, Architecture, Security Model, Governance, Roadmap, contribution guidance, and public launch boundaries.
- Codex Security case with a threat-control-test-residual-risk matrix.
- Reproducible evidence demo with GIF, PNG, SVG, machine-readable results, and real refusal cases.
- Community issue forms, pull-request template, support guidance, Code of Conduct, and Private Vulnerability Reporting.

### Security

- Repository-specific allowed roots, blocked-path and symlink-escape checks.
- Sensitive-write scanning, output redaction, authorization-payload binding, and risk/permission decisions.
- Challenge-bound browser tab authorization and credentialed-URL rejection.
- Package-boundary checks and maintainer Full Release Safety evidence.

### Validation

- Public CI checks documentation links, TypeScript, build, CLI help, security controls, demo assets, and package contents.
- Maintainer evidence records broader capability certification and release-gate ownership without exposing private operational state.

### Known limitations

- `@menglook/codexpro` is not published to npm.
- No Git tag or GitHub Release exists for `0.1.0`.
- GitHub Pages is not deployed.
- No hosted relay, SaaS, or reviewed public ChatGPT app is provided.
- The committed demo has no MP4 because the generation environment did not provide a trusted video encoder; reproducible frames and a fail-closed renderer are included.
- CodexPro is not an operating-system sandbox. Human review remains authoritative for merge, release, publication, disclosure, and deployment.
