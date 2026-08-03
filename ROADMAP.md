# Roadmap

This roadmap describes current direction for the public source repository. It is not a release schedule, service-level agreement, or promise that every item will ship. Priorities may change after security findings, maintainer review, or contributor evidence.

## Now

- Keep the public source preview buildable from a fresh Node.js 20 installation.
- Maintain explicit workspace, side-effect, security, and public/private boundaries.
- Keep governance, contribution guidance, Issue forms, pull-request review, and labels usable without private contact.
- Preserve truthful adoption and release status: no npm package, GitHub Release, Pages site, hosted relay, or managed service is claimed.
- Triage the first bounded contribution tasks listed below.

## Next: open contribution tasks

These are real repository gaps with bounded acceptance criteria:

1. [#1 Add fixture-based tests for the documentation link checker](https://github.com/Menglook/codexpro-runtime/issues/1)
2. [#2 Add a schema catalog integrity check](https://github.com/Menglook/codexpro-runtime/issues/2)
3. [#3 Add a Windows Node.js 20 source-build CI job](https://github.com/Menglook/codexpro-runtime/issues/3)
4. [#4 Validate the built-in generic browser skill pack](https://github.com/Menglook/codexpro-runtime/issues/4)

Issue scope and acceptance criteria are authoritative. A roadmap position does not reserve an Issue for a contributor.

## Later

Later work may include:

- repeatable release evidence and changelog policy;
- a reviewed decision on npm publication and GitHub Releases;
- broader cross-platform source verification;
- more focused regression checks around authorization, workspace isolation, and evidence contracts;
- additional generic examples that do not contain private or business-specific data;
- re-evaluating GitHub Discussions when recurring community Q&A or announcements justify a separate channel.

## Discussions decision

GitHub Discussions remains disabled for now. The repository currently has no established discussion volume, and Issues plus pull requests provide one searchable support and contribution path.

Discussions may be enabled later when at least one of these conditions is present:

- recurring questions do not map cleanly to actionable Issues;
- release or project announcements need a dedicated public archive;
- community design conversations are repeatedly crowding implementation Issues;
- there is enough maintainer capacity to moderate another channel.

## Non-goals

The public roadmap does not include:

- building a hosted multi-tenant source-code service;
- automatic merging, npm publishing, release creation, or production deployment;
- replacing operating-system, container, repository-host, or branch-protection security;
- bypassing model, account, safety, product, or quota limits;
- publishing private operational integrations, credentials, customer data, production identity, or internal evidence;
- promising compatibility with every MCP client or model behavior.

## Proposing roadmap work

Open a structured feature request and explain the problem, public use case, security and side-effect impact, alternatives, and validation plan. Read [CONTRIBUTING.md](CONTRIBUTING.md) and [GOVERNANCE.md](GOVERNANCE.md) before proposing a broad architectural change.