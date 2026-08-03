# CodexPro Runtime

CodexPro Runtime is a public, sanitized runtime for evidence-driven MCP and Codex workflows. It contains reusable server, execution, schema, template, browser-skill, and CLI components extracted from a larger private operational implementation.

> Public preview: the source repository is public, but the npm package is intentionally not published yet. `package.json` remains `private: true` until a separate npm release is explicitly approved.

## What is included

- MCP server entry points for stdio and HTTP transports
- Shared execution and validation primitives
- Schemas and reusable templates
- A generic browser-skill example
- A minimal CLI surface
- Security, contribution, license, and attribution documents

## What is excluded

This repository deliberately excludes private runtime state, business integrations, office evidence, project-specific reports, benchmark evidence, local machine paths, production tunnel identity, credentials, and the original private Git history.

## Build from source

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/Menglook/codexpro-runtime.git
cd codexpro-runtime
npm install --ignore-scripts
npm run build
npm run typecheck
npm run cli:help
```

Available source-level commands:

```bash
npm run build
npm run typecheck
npm run cli:help
npm run pack:dry-run
```

The current CLI command name reserved for a future package release is `menglook-codexpro`. The runtime entry points are `codexpro-mcp` and `codexpro-mcp-http`.

## Release boundary

The private implementation remains the internal authority for production-specific capabilities. Public changes are exported through an explicit allowlist and must pass build, typecheck, package-content, and secret-scanning gates before publication.

No npm package, GitHub Pages site, or production deployment is created by this initial repository publication.

## Attribution

This work is derived from [rebel0789/codexpro](https://github.com/rebel0789/codexpro) under the MIT License and contains independent modifications maintained by Menglook. This repository is not the upstream project.

Upstream stars, forks, npm downloads, maintainers, issues, pull requests, website traffic, and other adoption metrics are not metrics of this repository.

See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE) for details.

## Security

Do not include credentials, tokens, cookies, private hostnames, production paths, or customer-sensitive data in issues or pull requests. Follow [SECURITY.md](SECURITY.md) for reporting security concerns.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes should remain generic, reviewable, and independent of private operational configuration.
