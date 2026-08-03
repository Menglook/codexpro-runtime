# Security Model

CodexPro Runtime gives an MCP client controlled access to a local source workspace. Treat it as a developer tool with potentially sensitive local access.

## Assets to protect

- source code and repository history;
- credentials, tokens, cookies, and private keys;
- customer or business data;
- production hostnames and tunnel configuration;
- local machine paths and user identity;
- task evidence that may contain private implementation details;
- command execution authority.

## Trust assumptions

CodexPro assumes:

- the local machine owner is trusted;
- the selected workspace root is intentional;
- the MCP client and model may make mistakes;
- external content may be malicious or misleading;
- shell commands and writes require stronger controls than reads;
- public network exposure requires authentication.

## Primary controls

### Workspace roots

Operations are resolved against explicit roots. Prefer one repository-specific root. Do not use a home-directory-wide root unless the task truly requires it.

### Path guards

Blocked paths include common credential, dependency, build, cache, and repository-internal locations. Path traversal and symlink resolution are checked before access.

### Capability modes

Read, write, Bash, tool, and connector modes control the advertised surface. Use the smallest surface that can complete the task.

### Sensitive write gate

Generic writes are scanned before persistence. A blocked result identifies the location and rule without printing the matched secret value.

### HTTP authentication

Public or non-loopback HTTP must fail closed when authentication is missing. The local no-token override is only for trusted loopback testing.

### Redaction

Status, logs, and UI output should not expose raw authentication values or tunnel credentials.

### Evidence and review

Structured outcomes and validation evidence support review. Evidence is not a substitute for maintainer judgment.

## Safer defaults

For initial evaluation:

- use a disposable repository or reviewed clone;
- bind one explicit root;
- keep public tunnels off;
- keep Bash off or safe;
- keep generic writes off until needed;
- avoid transcript access;
- run source validation before starting a server;
- inspect diffs and command results before accepting a task.

## Public HTTP checklist

Before any public or tunnel exposure:

1. Configure a strong authentication secret outside the repository.
2. Confirm the endpoint fails closed without authentication.
3. Confirm the workspace root is repository-specific.
4. Keep Bash safe or off.
5. Keep write mode minimal.
6. Avoid logging query strings, prompts, file contents, or full command output.
7. Verify no connector URL containing authentication data is committed or shared.
8. Review the current `SECURITY.md` hard rules.

## Failure cases

| Failure | Required response |
|---|---|
| A request targets a blocked or out-of-root path | Deny without exposing sensitive path contents |
| A write appears to contain a secret | Reject the write and report only rule/location metadata |
| A public endpoint lacks authentication | Fail closed |
| A command is outside the configured Bash policy | Deny or require a narrower approved command |
| Validation fails | Preserve the failed status and evidence; do not report completion |
| Workspace identity is ambiguous | Stop and resolve the workspace before side effects |
| Recovery evidence conflicts | Require review rather than silently resuming |

## What the controls do not provide

They do not provide:

- kernel or container isolation;
- protection from a compromised local account;
- correctness guarantees for every command allowed by safe mode;
- protection after a maintainer deliberately enables unrestricted local commands;
- repository-host permissions or branch protection;
- automatic secure deployment.

## Reporting vulnerabilities

Do not put secrets or exploit details in a public issue. Follow [SECURITY.md](../SECURITY.md) for private reporting guidance.
