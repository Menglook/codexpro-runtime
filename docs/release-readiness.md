# Release Readiness

CodexPro Runtime `0.1.0` is currently a **public source candidate**, not a published release. This page records what is reproducible today and which publication actions remain separately gated.

## Current publication state

| Surface | Current state | Authority required to change it |
|---|---|---|
| Public GitHub source | Available on `main` | Normal reviewed source delivery |
| Source CI | Enabled and required for public changes | Repository maintainer |
| Package manifest | `@menglook/codexpro` version `0.1.0`, `private: true` | Reviewed release change |
| Local npm tarball | Reproducibly packable and installable | No registry write |
| npm registry | Not published; no `latest` dist-tag | Explicit npm publication authorization |
| Git tag | None for `v0.1.0` | Explicit tag authorization |
| GitHub Release | None | Explicit Release authorization |
| GitHub Pages | Not deployed | Explicit Pages/deployment authorization |
| Hosted service or app | Not provided or claimed | Separate product, security, and deployment review |

Passing the source-candidate checks does not authorize the npm, tag, Release, Pages, app, or production gates.

## Source-candidate checks

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
```

The unified check covers:

- Markdown links and public documentation references;
- TypeScript type checking and build;
- CLI help without credentials or external accounts;
- path, authorization-integrity, and browser-authorization security controls;
- reproducible demo assets and refusal evidence;
- npm archive boundaries;
- version and publication-state consistency;
- installation of the real local tarball into a clean temporary consumer project.

## Fresh-install model

`npm run fresh-install:check` performs a registry-free consumer test:

1. creates a real npm tarball in an operating-system temporary directory;
2. lists and inspects every tar entry;
3. rejects private runtime state, planning files, credentials, environment files, Git internals, and dependency trees;
4. installs the tarball into a clean temporary project with lifecycle scripts disabled;
5. verifies package name, version, public documents, demo assets, and installed command help;
6. runs the packaged disposable demo workflow;
7. deletes all temporary files.

The check proves the candidate archive can be consumed locally. It does not claim npm registry availability.

## Candidate consistency

The following surfaces must remain aligned before any future publication:

- `package.json` and `package-lock.json` version;
- CHANGELOG source-candidate section;
- README source-preview statement;
- Quickstart commands;
- Public Launch Checklist;
- Demo status and limitations;
- package archive contents;
- CI results;
- future Git tag, GitHub Release, npm dist-tag, and Pages content.

## Publication sequence requiring explicit authorization

1. Decide the version and compatibility statement.
2. Review the exact package and public-document diff.
3. Run the full source-candidate and release-safety gates.
4. Change `private: true` only in a reviewed npm-publication change.
5. Create and verify the Git tag.
6. Create the GitHub Release with accurate notes and limitations.
7. Publish the exact tested tarball to npm and verify the `latest` dist-tag.
8. Run a registry-based anonymous fresh install.
9. Deploy Pages only after a separate content and deployment review.
10. Freeze metrics and application wording after propagation.

No step may be inferred from a previous gate, automated by a documentation change, or described as complete before its external state is verified.
