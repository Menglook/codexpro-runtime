# Public Boundary

This repository is a sanitized public runtime extracted from a larger private operational implementation.

## Included

- MCP stdio and Streamable HTTP servers;
- reusable workspace, guard, tool, task, job, execution, review, and recovery components;
- public schemas and templates;
- shared execution and redaction primitives;
- generic browser runtime primitives and a generic skill example;
- source-level CLI entry points;
- security, contribution, attribution, and launch documentation.

## Excluded

- private production credentials and token files;
- private hostnames, named tunnel identity, and deployment configuration;
- customer and business integrations;
- WB, Ozon, dashboard, or product-specific rules;
- internal office reports and visual evidence;
- benchmark runs and private acceptance evidence;
- `.codexpro` runtime state;
- `.ai-bridge` task snapshots and handoff logs;
- private local paths and machine identity;
- the complete private Git history, branches, and tags;
- private deployment orchestration.

## Export rule

Public content is selected through an explicit allowlist. A public export must pass:

1. file-manifest review;
2. sensitive-content scanning without printing matched values;
3. dependency and license review;
4. fresh dependency installation;
5. type checking and build;
6. CLI and package-surface checks;
7. remote tree verification after publication.

## Authority

The private repository remains authoritative for private operations and production-specific capabilities. The public repository is authoritative only for the code and documentation actually published here.

## Attribution

This repository is independently maintained by Menglook and derived from `rebel0789/codexpro` under the MIT License. Upstream project metrics are not public adoption metrics for this repository.

## Future additions

A feature may enter the public boundary only when:

- it is generic rather than business-specific;
- secrets and private identifiers are removed;
- licensing is clear;
- documentation describes real behavior;
- tests or validation evidence are available;
- publication is explicitly approved.
