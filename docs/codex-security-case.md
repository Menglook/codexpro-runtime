# Codex Security Case: CodexPro Runtime

## Why the project needs deep security review

CodexPro Runtime is a local MCP control plane for open-source maintenance. Depending on configuration, it can inspect a source tree, prepare bounded edits, run local commands, coordinate agents, review Git state, interact with authorized browser tabs, and collect release evidence. A defect can therefore cross from model output into a real developer workstation or repository.

The most important questions are not only whether a command is syntactically safe, but whether the correct conversation, workspace, generation, path, capability, approval, and evidence were bound to the action.

## Highest-value Codex Security work

1. **Cross-layer audit** — trace a risky change through transport, workspace binding, path resolution, risk classification, permission decisions, tool execution, evidence, and documentation.
2. **Confused-deputy review** — look for stale workspace identity, mismatched authorization payloads, incorrect browser-tab ownership, and external actions executed with broader authority than the user approved.
3. **Adversarial regression generation** — create minimal positive and negative cases for traversal, symlinks, invisible Unicode, credential leakage, shell/Git escalation, browser authorization, and stale task recovery.
4. **Patch and verification** — propose the smallest fix, run targeted checks, and identify which broader acceptance profile must be rerun.
5. **Disclosure and release consistency** — ensure the security model, advisory, changelog, package contents, and release evidence describe the implemented control without overstating isolation.

## Existing control layers

- repository-specific roots, blocked globs, realpath and symlink checks;
- read/write/Bash/tool capability modes;
- sensitive-write scanning and redaction;
- L0-L3 risk and monotonic permission decisions;
- pre-execution payload, workspace, and authorization binding;
- challenge-bound browser tab authorization;
- structured task, completion, and execution-origin evidence;
- exact-path Git finalization, package-boundary checks, CI, and Full Release Safety;
- GitHub Private Vulnerability Reporting.

## Human boundary

Codex Security may find, explain, patch, and test vulnerabilities. The human maintainer remains responsible for severity, accepted risk, private disclosure, repository permissions, merge, release, npm publication, and any production change.

## Honest residual risk

CodexPro is not an OS sandbox. A compromised local account, unsafe Full Bash configuration, malicious dependency, compromised browser profile, overly broad workspace root, repository-host compromise, or flawed human approval can bypass assumptions outside the runtime. Security controls and evidence reduce risk; they do not make autonomous execution inherently trustworthy.

For the detailed matrix, see [Security Model](security-model.md).
