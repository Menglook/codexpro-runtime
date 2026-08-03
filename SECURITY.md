# Security Policy

CodexPro Runtime exposes a selected local workspace to an MCP client. Treat it as a developer tool with source-tree access, not as a hosted SaaS application or an operating-system sandbox.

## Supported public surface

The current supported public surface is GitHub `main`. No npm package or GitHub Release is published yet.

Security statements in this repository apply only to the public source actually present here. Private production integrations have separate operational controls and are outside this repository's public support boundary.

## Reporting

Report security issues privately before opening a public issue. Use GitHub private vulnerability reporting when enabled. Otherwise contact the repository owner through a private channel listed on the maintainer's GitHub profile.

Do not include secrets, private repository contents, customer data, tunnel credentials, `.env` values, or active exploit details in a public report.

## Terms boundary

CodexPro is not designed to bypass, pool, resell, avoid, or modify ChatGPT, Codex, OpenAI, third-party model, account, safety, or quota limits.

Each user is responsible for using only product surfaces available to their account and following the applicable terms and safety rules.

## Threat model

Depending on configuration, CodexPro may expose:

- file metadata and selected file contents from allowed workspaces;
- Git status and diffs;
- bounded `.ai-bridge` planning files;
- optional shell commands;
- optional workspace writes;
- local task, review, and recovery state;
- optional browser and transcript-related metadata.

The connected client may be fallible or untrusted. Side effects must therefore remain constrained by workspace, capability, authorization, and command policy.

## Main risks

- selecting an overly broad workspace root;
- connecting an untrusted MCP client;
- exposing an HTTP endpoint without authentication;
- enabling full Bash on an important repository;
- enabling generic writes when planning-only access would suffice;
- executing an untrusted handoff plan or local adapter command;
- leaking authentication or tunnel credentials;
- trusting downloaded binaries without organizational review;
- confusing model output with verified completion evidence.

## Required controls

### Workspace scope

Use one repository-specific root. Path resolution must reject traversal, blocked paths, and symlinks that escape the workspace.

### HTTP authentication

Public and non-loopback HTTP endpoints must fail closed when authentication is missing. The local no-token override is only for trusted loopback testing.

### Bash modes

- Off: no shell execution.
- Safe: allowlisted and policy-checked local commands.
- Full: trusted-local-only choice with broad risk.

Safe mode can still run project scripts. Use Bash off for untrusted repositories or inspection-only work.

### Write modes

Use read-only or handoff mode when generic source edits are unnecessary. Workspace writes should be enabled only for a trusted session and explicit repository root.

### Sensitive write gate

Generic writes and patches scan the resulting content before persistence.

- Rejections identify rule and location without printing the matched value.
- Use environment-variable references, `[REDACTED_SECRET]`, or ignored local configuration for credentials.
- Never weaken the scanner to admit a real credential.

### Redaction

Status, logs, UI, reports, and package output must not expose raw authentication values, private keys, cookies, or tunnel credentials.

## Safer source-preview commands

Build and inspect locally:

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm run cli:help
```

Inspect server help:

```bash
node dist/stdio.js --help
node dist/http.js --help
```

For trusted loopback-only HTTP testing:

```bash
CODEXPRO_ALLOW_NO_HTTP_TOKEN=1 node dist/http.js \
  --root /path/to/repo \
  --allow-root /path/to/repo \
  --host 127.0.0.1 \
  --port 8787
```

Do not use the no-token override for public or non-loopback access.

## Failure expectations

| Failure mode | Expected control |
|---|---|
| Public endpoint has no authentication | Fail closed |
| Request targets an out-of-root or blocked path | Deny without exposing contents |
| Write contains a secret-like value | Reject and report only metadata |
| Command violates Bash policy | Deny or require a narrower command |
| Validation fails | Preserve failed state and evidence |
| Workspace identity is ambiguous | Stop before side effects |
| Recovery evidence conflicts | Require review |
| Client claims success without evidence | Treat the task as unverified |

## Built-in blocked areas

Common blocked areas include:

- `.env` and credential files;
- `.git` internals;
- `node_modules`;
- private-key names;
- build and cache directories such as `dist`, `build`, `.next`, `coverage`, and `.cache`;
- symlinks that resolve outside the workspace or into blocked paths.

These controls reduce risk. They do not replace kernel, container, VM, or repository-host isolation.

## Hard rules

- Do not run public endpoints without authentication.
- Do not commit connector URLs containing authentication data.
- Do not commit tunnel credentials.
- Do not paste raw credentials into screenshots, issues, or browser pages.
- Do not use full Bash on an untrusted repository.
- Do not wrap unrestricted local-agent execution in a remote MCP tool without a stronger approval and sandbox design.
- Do not automate account access, approval prompts, safety prompts, or quota workarounds.
- Do not treat MCP session IDs as local Codex conversation IDs.
- Do not claim that path guards make CodexPro an OS sandbox.

## Disclosure expectations

A useful private report includes:

- affected public commit;
- operating system and Node.js version;
- minimal reproduction steps using placeholders;
- expected and actual security behavior;
- whether a public endpoint or credential was involved;
- suggested mitigation when known.

Never include active secrets or private customer data.
