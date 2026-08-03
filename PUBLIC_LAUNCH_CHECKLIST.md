# Public Launch Checklist

CodexPro Runtime currently has four separate publication gates:

1. Public source repository
2. npm package
3. GitHub Release and Pages
4. Public app or hosted service

Passing one gate does not authorize or certify the others.

## Current status

| Gate | Status |
|---|---|
| Public source repository | Open |
| Source CI | Configured |
| npm package `@menglook/codexpro` | Not published |
| GitHub Release | None |
| GitHub Pages | Not deployed |
| Reviewed public ChatGPT app | Not claimed |
| Hosted relay or SaaS | Not provided |

## Source gate

Run before updating public `main`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm run cli:help
npm run pack:dry-run
```

Also require:

- reviewed public file manifest;
- sensitive-content scan with values redacted;
- license and attribution review;
- no private history, runtime evidence, credentials, tunnel identity, or business data;
- anonymous-link validation;
- local and remote Git tree verification after publication.

## npm gate

Do not publish while `package.json` is `private: true`.

Before any future npm publication:

- obtain explicit publication authorization;
- confirm package scope ownership and access;
- remove `private: true` in a reviewed release change;
- verify version consistency across package metadata and runtime protocol responses;
- create a real tarball and inspect every included path;
- install the tarball into a clean consumer project;
- verify the published dist-tag after publication;
- document rollback and deprecation procedures.

Never announce npm availability before the registry state is verified.

## GitHub Release gate

Before creating a Release:

- define the version and compatibility statement;
- prepare a changelog based only on public changes;
- attach or reference reproducible validation evidence;
- confirm no private artifacts are attached;
- document known limitations;
- obtain explicit Release authorization.

## Pages gate

Before enabling GitHub Pages:

- confirm all links use the independent repository identity;
- remove private product paths and outdated screenshots;
- use only current, verified UI evidence;
- add a clear non-endorsement statement;
- confirm Pages does not expose internal reports or analytics.

## Public app or hosted-service gate

Do not present CodexPro as a reviewed public ChatGPT app, hosted relay, or managed service unless that exact surface exists and has completed its applicable review and security process.

Before any such announcement:

- test from a fresh user environment;
- document account and product prerequisites using current official sources;
- verify authentication, CSP, privacy, logging, deletion, and incident response;
- distinguish local runtime behavior from hosted behavior;
- obtain separate deployment and announcement authorization.

## Security gate

- Use repository-specific roots.
- Keep public HTTP authentication enabled.
- Keep Bash safe or off by default.
- Do not expose generic writes in planning-only modes.
- Block `.env`, `.git`, dependency, build, cache, key, and symlink-escape paths.
- Do not log raw tokens, prompts, file contents, or full command output by default.
- Never commit connector URLs containing authentication data.

## Adoption claims

- Use only attributable metrics from this repository or its future package.
- Timestamp every metric.
- Do not treat stars or forks as active users.
- Do not use upstream metrics as this repository's metrics.
- Do not describe private operational usage as public adoption.
- Obtain permission before quoting a user or organization.
