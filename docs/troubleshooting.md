# Troubleshooting

## `npm ci` reports a lockfile mismatch

Confirm that `package.json` and `package-lock.json` come from the same commit. Do not regenerate the lockfile using a different dependency policy unless you intend to review and commit that change.

## The build is missing

Run:

```bash
npm run build
```

The MCP entry points under `dist/` are generated and are not treated as source files.

## A CLI command says build artifacts are missing

Some task commands load modules from `dist/`. Run `npm run build` before using those commands.

## An npm install command cannot find `@menglook/codexpro`

The package is not published. Clone the GitHub repository and build from source.

## A README badge says npm is not published or release is none

That is the current project status, not an outage. Do not use upstream package or release identifiers as substitutes.

## The HTTP server refuses to start without a token

Public or non-loopback endpoints are designed to fail closed without authentication. Use the no-token override only for trusted loopback testing.

## A file read or write is blocked

Check whether the path is:

- outside the selected workspace root;
- inside `.git`, `node_modules`, a build/cache directory, or another blocked location;
- a symlink resolving outside the workspace;
- a credential or private-key path.

Narrow the request rather than disabling the guard.

## A write is rejected as secret-like

Replace the value with an environment-variable reference, `[REDACTED_SECRET]`, or a local ignored configuration file. Never weaken the public scan to admit a real credential.

## A validation command exists in a template but not in this package

Templates can describe project-specific commands such as `npm run smoke`. The public runtime repository itself currently guarantees only the scripts listed in its root `package.json`.

## CI is green but a local integration fails

Public CI verifies source install, typecheck, build, CLI help, and package-content dry run. It does not validate every operating system, tunnel provider, MCP client, external account, or private production integration.

## A documentation link is broken

Open an issue containing only the broken public path and expected destination. Do not include private repository URLs or local filesystem paths.
