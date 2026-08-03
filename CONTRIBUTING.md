# Contributing

CodexPro Runtime is an early public source preview. Good contributions make the runtime safer, more testable, easier to explain, and more useful to open-source maintainers.

## Before you start

Read:

- [README.md](README.md)
- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Adoption evidence](docs/adoption.md)
- [Public boundary](docs/public-boundary.md)

Changes must remain generic and independent of private operational configuration.

## Local setup

```bash
git clone https://github.com/Menglook/codexpro-runtime.git
cd codexpro-runtime
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run build
npm run cli:help
npm run pack:dry-run
```

## Useful contribution areas

- safer capability defaults;
- clearer authorization and failure outcomes;
- workspace isolation and path-guard tests;
- durable task, validation, review, and recovery evidence;
- smaller and faster context handling;
- reusable MCP and browser primitives;
- documentation that reduces setup and security mistakes;
- cross-platform source-build fixes.

## Pull request checklist

- Keep the change focused.
- Explain the user or maintainer problem.
- Describe security and side-effect impact.
- Add or update focused validation where possible.
- Run `npm run typecheck`.
- Run `npm run build`.
- Run `npm run cli:help`.
- Run `npm run pack:dry-run` when package contents may change.
- Update public documentation when behavior changes.
- State what was not tested.

## Prohibited content

Do not include:

- credentials, tokens, cookies, or private keys;
- `.env` values;
- private repository contents or URLs;
- customer or business data;
- production hostnames or tunnel identity;
- local machine paths or usernames;
- `.codexpro` runtime evidence;
- `.ai-bridge` task snapshots;
- internal reports or screenshots.

## Documentation style

- Be concrete and testable.
- Avoid hype and implied endorsements.
- Name exact commands, modes, flags, and failure cases.
- Distinguish source preview, npm package, release, app, and hosted-service status.
- Use `/path/to/repo` and `codexpro.example.com` placeholders.
- Do not claim upstream metrics as this repository's adoption.

## Share a real use case

Use the [Adoption feedback issue form](https://github.com/Menglook/codexpro-runtime/issues/new?template=adoption-feedback.yml) to share a reproducible public use case. Participation is voluntary and no payment, review incentive, or other reward is offered. Do not include private source, credentials, customer data, production details, or vulnerability information. Quotations require the author's explicit optional permission in the form.

## Security changes

For changes touching authentication, file access, shell execution, redaction, tunnels, browser control, or workspace binding:

- describe the threat being addressed;
- identify fail-open and fail-closed behavior;
- include a focused negative test or verification path;
- avoid posting active vulnerability details publicly before disclosure coordination.

Follow [SECURITY.md](SECURITY.md) for vulnerability reporting.
