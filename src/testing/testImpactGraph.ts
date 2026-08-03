import { createHash } from "node:crypto";
import { minimatch } from "minimatch";

export type TestImpactLevel = "targeted" | "component" | "release";
export type TestExecutionMode = "serial" | "parallel";
export type TestResourceLevel = "light" | "default" | "cpu-heavy";

export interface TestImpactNode {
  id: string;
  command: string;
  owns: string[];
  depends_on: string[];
  timeout_ms: number;
  execution: TestExecutionMode;
  resource_level: TestResourceLevel;
  level: TestImpactLevel;
  acceptance_items: string[];
  provides_build?: boolean;
  flaky?: boolean;
}

export interface TestImpactPlanOptions {
  level?: TestImpactLevel;
  graph?: TestImpactNode[];
}

export interface TestImpactPlan {
  version: 1;
  plan_hash: string;
  level: TestImpactLevel;
  changed_files: string[];
  uncovered_files: string[];
  matched_node_ids: string[];
  expanded_for_shared_core: boolean;
  nodes: TestImpactNode[];
  layers: string[][];
  commands: string[];
  acceptance_map: Record<string, string[]>;
  cpu_heavy_node_ids: string[];
  flaky_node_ids: string[];
}

export interface TestImpactResultRecord {
  node_id: string;
  command: string;
  status: "passed" | "failed" | "blocked" | "cancelled" | "skipped";
  finished_at: string;
  log_path?: string;
  duration_ms?: number;
  exit_code?: number | null;
  flaky_candidate?: boolean;
}

export interface TestImpactState {
  version: 1;
  plan_hash: string;
  updated_at: string;
  results: Record<string, TestImpactResultRecord>;
}

const LEVEL_WEIGHT: Record<TestImpactLevel, number> = {
  targeted: 1,
  component: 2,
  release: 3
};

const SHARED_CORE_PATTERNS = [
  "shared/**",
  "src/compactExecution.ts",
  "src/asyncCompactTasks.ts",
  "src/bashOps.ts",
  "src/config.ts",
  "src/redact.ts",
  "src/server.ts",
  "src/server/**",
  "src/jobs/**",
  "src/runtime/**"
];

export const DEFAULT_TEST_IMPACT_GRAPH: TestImpactNode[] = [
  {
    id: "build",
    command: "npm run build",
    owns: [],
    depends_on: [],
    timeout_ms: 60_000,
    execution: "serial",
    resource_level: "default",
    level: "targeted",
    acceptance_items: ["build"]
  },
  {
    id: "browser-authorization",
    command: "node scripts/browser-authorization-smoke.mjs",
    owns: ["src/browser/browser-authorization.ts", "chrome-extension/**"],
    depends_on: ["build"],
    timeout_ms: 30_000,
    execution: "parallel",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["browser.authorization"]
  },
  {
    id: "browser-bridge",
    command: "node scripts/browser-bridge-v2-tools-smoke.mjs",
    owns: ["src/browser/**", "src/adapters/playwright-adapter.ts", "scripts/browser-*.mjs", "shared/browser-runtime-env.*"],
    depends_on: ["build"],
    timeout_ms: 45_000,
    execution: "serial",
    resource_level: "default",
    level: "targeted",
    acceptance_items: ["browser.bridge", "browser.runtime"]
  },
  {
    id: "goal-store",
    command: "node scripts/goal-store-smoke.mjs",
    owns: ["src/goals/**", "schemas/goal-acceptance.schema.json"],
    depends_on: ["build"],
    timeout_ms: 60_000,
    execution: "serial",
    resource_level: "default",
    level: "targeted",
    acceptance_items: ["goal.persistence", "goal.acceptance"]
  },
  {
    id: "durable-jobs",
    command: "node scripts/durable-job-recovery-smoke.mjs",
    owns: ["src/jobs/**", "src/runtime/**", "src/asyncCompactTasks.ts", "src/bashOps.ts"],
    depends_on: ["build"],
    timeout_ms: 60_000,
    execution: "serial",
    resource_level: "default",
    level: "targeted",
    acceptance_items: ["job.recovery", "job.progress", "job.cancellation"]
  },
  {
    id: "task-identity",
    command: "node scripts/task-identity-smoke.mjs",
    owns: ["src/tasks/**", "src/jobs/progressProjection.ts", "src/handoffStatus.ts", "src/server.ts"],
    depends_on: ["build"],
    timeout_ms: 45_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["task.identity", "task.projection", "task.timeline"]
  },
  {
    id: "task-recovery",
    command: "node scripts/task-recovery-smoke.mjs",
    owns: ["src/tasks/**", "src/jobs/jobSteps.ts", "src/jobs/jobManager.ts", "src/asyncCompactTasks.ts", "src/handoffStatus.ts", "src/server.ts"],
    depends_on: ["build"],
    timeout_ms: 45_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["task.recovery", "task.idempotency", "task.side_effects"]
  },
  {
    id: "task-acceptance",
    command: "node scripts/task-acceptance-smoke.mjs",
    owns: ["src/tasks/**", "src/workflow/acceptanceEngine.ts", "src/goals/**", "src/jobs/**", "src/asyncCompactTasks.ts", "src/handoffStatus.ts", "src/server.ts"],
    depends_on: ["build"],
    timeout_ms: 45_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["task.acceptance", "task.completion_contract", "task.evidence"]
  },
  {
    id: "acceptance-profiles",
    command: "node scripts/acceptance-dynamic-profile-smoke.mjs",
    owns: [
      ".codexpro/acceptance.yml",
      "templates/acceptance.yml",
      "schemas/acceptance.schema.json",
      "src/workflow/acceptanceEngine.ts",
      "src/workflow/acceptanceProfile.ts",
      "src/project/projectConfig.ts",
      "src/project/types.ts",
      "src/testing/testImpactGraph.ts",
      "src/bashOps.ts",
      "scripts/acceptance-*.mjs",
      "scripts/test-impact-graph-smoke.mjs"
    ],
    depends_on: ["build"],
    timeout_ms: 45_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["acceptance.profile_selection", "acceptance.fail_fast", "acceptance.test_impact"]
  },
  {
    id: "task-control",
    command: "node scripts/task-control-smoke.mjs",
    owns: ["src/tasks/**", "src/server.ts", "src/server/toolRegistry.ts", "src/asyncCompactTasks.ts", "src/goals/**", "src/jobs/**", "src/handoffStatus.ts"],
    depends_on: ["build"],
    timeout_ms: 60_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["task.current", "task.evidence", "task.resume", "task.cancel"]
  },
  {
    id: "execution-lane-routing",
    command: "npm run stage-j3-smoke",
    owns: [
      "src/security/riskGate.ts",
      "src/workflow/taskCompiler.ts",
      "src/workflow/taskRouter.ts",
      "src/workflow/executionLane.ts",
      "src/goals/goalManager.ts",
      "src/goals/types.ts",
      "src/config.ts",
      "src/server/toolRegistration.ts",
      "src/workflow/bossReport.ts",
      "scripts/aggregate-risk-routing-smoke.mjs",
      "scripts/execution-lane-routing-smoke.mjs",
      "scripts/reviewer-policy-smoke.mjs",
      "scripts/reasoning-effort-routing-smoke.mjs",
      "scripts/goal-execution-lane-smoke.mjs"
    ],
    depends_on: [],
    provides_build: true,
    timeout_ms: 120_000,
    execution: "serial",
    resource_level: "default",
    level: "targeted",
    acceptance_items: ["risk.argument_paths", "risk.side_effect_descriptor", "execution.lane", "execution.reasoning", "review.routing", "goal.lane_recovery"]
  },
  {
    id: "runtime-cost-reduction",
    command: "npm run stage-j4-smoke",
    owns: [
      "src/codex/providerCapabilityCache.ts",
      "src/codex/providerRouter.ts",
      "src/codex/adapterFactory.ts",
      "src/server/toolRegistry.ts",
      "src/server/toolRegistration.ts",
      "src/contextBudget.ts",
      "src/proContext.ts",
      "src/workflow/contextProfiles.ts",
      "src/observability/riskMetrics.ts",
      "src/security/riskGate.ts",
      "src/config.ts",
      "src/goals/goalManager.ts",
      "src/goals/types.ts",
      "scripts/provider-capability-cache-smoke.mjs",
      "scripts/context-profile-routing-smoke.mjs",
      "scripts/risk-observability-metrics-smoke.mjs",
      "scripts/progressive-tool-disclosure-smoke.mjs",
      "scripts/progressive-mcp-smoke.mjs"
    ],
    depends_on: [],
    provides_build: true,
    timeout_ms: 180_000,
    execution: "serial",
    resource_level: "default",
    level: "targeted",
    acceptance_items: ["provider.cache", "tools.progressive_default", "context.lane_profile", "risk.metrics", "runtime.no_sync_report"]
  },
  {
    id: "execution-path-audit",
    command: "node scripts/execution-path-audit-smoke.mjs",
    owns: ["scripts/lib/execution-path-audit.mjs", "scripts/codexpro-stack.mjs", "package.json"],
    depends_on: [],
    timeout_ms: 30_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["execution.path_manifest", "execution.orphan_detection", "execution.non_destructive_audit"]
  },
  {
    id: "event-bus",
    command: "node scripts/event-bus-smoke.mjs",
    owns: ["src/events/**", "src/server/toolRegistration.ts", "src/goals/goalStore.ts", "src/jobs/jobManager.ts", "src/codex/providerRouter.ts", "scripts/provider-router-smoke.mjs"],
    depends_on: ["build"],
    timeout_ms: 45_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["event.lifecycle", "event.before_gate", "event.domain_bridge", "event.subscriber_isolation", "event.model_switch"]
  },
  {
    id: "model-registry",
    command: "node scripts/model-registry-smoke.mjs",
    owns: ["src/models/**", "src/codex/providerRouter.ts", "src/codex/types.ts", "src/goals/**", "src/agents/**", "scripts/model-registry-smoke.mjs"],
    depends_on: ["build"],
    timeout_ms: 45_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["model.roles", "model.quota_routing", "model.independent_review", "model.real_chrome", "model.safe_switch", "model.structured_handoff"]
  },
  {
    id: "session-tree",
    command: "node scripts/session-tree-smoke.mjs",
    owns: ["src/sessions/**", "src/goals/**", "src/gitOps.ts", "scripts/session-tree-smoke.mjs"],
    depends_on: ["build"],
    timeout_ms: 45_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["session.branch", "session.compare", "session.bindings", "session.no_false_rollback", "session.branch_isolation"]
  },
  {
    id: "pi-prototype-evaluation",
    command: "node scripts/pi-prototype-evaluation-smoke.mjs",
    owns: ["src/pi/**", "scripts/pi-prototype-evaluation-smoke.mjs", "planning-local/Pi隔离原型评估报告-2026-07-12.md"],
    depends_on: ["build"],
    timeout_ms: 30_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["pi.isolation", "pi.control_plane_owner", "pi.forbidden_actions", "pi.metrics", "pi.stop_decision"]
  },
  {
    id: "unified-risk-observability",
    command: "node scripts/unified-risk-observability-smoke.mjs",
    owns: ["src/security/**", "src/events/**", "src/server/toolRegistration.ts", "scripts/unified-risk-observability-smoke.mjs"],
    depends_on: ["build"],
    timeout_ms: 30_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["risk.l0_l3", "risk.external_authorization", "risk.no_l3_auto", "observability.fields", "observability.redaction"]
  },
  {
    id: "final-control-plane-acceptance",
    command: "node scripts/final-control-plane-acceptance-smoke.mjs",
    owns: ["src/tasks/**", "src/jobs/**", "src/goals/**", "src/events/**", "src/security/**", "src/workflow/sideEffectReconciliation.ts", "scripts/final-control-plane-acceptance-smoke.mjs"],
    depends_on: ["build"],
    timeout_ms: 240_000,
    execution: "serial",
    resource_level: "default",
    level: "release",
    acceptance_items: ["control_plane.502", "control_plane.restart", "control_plane.browser_disconnect", "control_plane.push_reconcile", "control_plane.database_recovery", "control_plane.single_owner", "control_plane.acceptance_gate", "control_plane.liveness_query"]
  },
  {
    id: "task-routing",
    command: "npm run stage-c-smoke",
    owns: [
      "src/workflow/taskCompiler.ts",
      "src/workflow/taskRouter.ts",
      "src/workflow/contextPlanner.ts",
      "src/codex/providerRouter.ts",
      "src/server/toolRegistry.ts",
      "src/server/toolRegistration.ts",
      "src/proContext.ts",
      "scripts/*planner*smoke.mjs",
      "scripts/*router*smoke.mjs",
      "scripts/progressive-*.mjs"
    ],
    depends_on: [],
    timeout_ms: 90_000,
    execution: "serial",
    resource_level: "default",
    level: "targeted",
    acceptance_items: ["task.compiler", "provider.router", "tool.disclosure", "context.planner"],
    provides_build: true
  },
  {
    id: "memory-governance",
    command: "npm run memory-governance-smoke",
    owns: ["src/project/projectMemory.ts", "src/project/memoryGovernance.ts", "src/workflow/memoryCandidate.ts", "src/workflow/contextPlanner.ts"],
    depends_on: [],
    timeout_ms: 45_000,
    execution: "parallel",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["memory.metadata", "memory.conflicts", "memory.expiry", "memory.scope"],
    provides_build: true
  },
  {
    id: "boss-report",
    command: "npm run stage-j5-smoke",
    owns: [
      "src/workflow/reportPolicy.ts",
      "src/workflow/bossReport.ts",
      "src/workflow/reportBuilder.ts",
      "src/workflow/taskTemplateEngine.ts",
      "src/compactExecution.ts",
      "src/asyncCompactTasks.ts",
      "scripts/codexpro-cli.mjs",
      "scripts/reporting-tier-smoke.mjs",
      "scripts/compact-execution-smoke.mjs",
      "scripts/boss-report-smoke.mjs",
      "scripts/task-template-smoke.mjs"
    ],
    depends_on: [],
    timeout_ms: 120_000,
    execution: "serial",
    resource_level: "light",
    level: "targeted",
    acceptance_items: ["report.compact_success", "report.full_failure", "report.reason_code", "report.debug_full", "report.legacy_compat"],
    provides_build: true
  },
  {
    id: "joint-final-regression",
    command: "npm run stage-j6-smoke",
    owns: ["scripts/joint-final-regression-smoke.mjs"],
    depends_on: [],
    timeout_ms: 180_000,
    execution: "serial",
    resource_level: "default",
    level: "release",
    acceptance_items: ["joint.performance", "joint.safety", "joint.routing", "joint.rollback", "joint.recovery", "joint.reporting"],
    provides_build: true
  },
  {
    id: "execution-kernel",
    command: "npm run execution-kernel-smoke",
    owns: ["shared/execution-kernel.*", "src/bashOps.ts", "src/compactExecution.ts", "src/jobs/**", "src/runtime/**"],
    depends_on: [],
    timeout_ms: 90_000,
    execution: "serial",
    resource_level: "default",
    level: "component",
    acceptance_items: ["execution.lease", "execution.cleanup", "execution.safety"],
    provides_build: true
  },
  {
    id: "mcp-compatibility",
    command: "node scripts/smoke.mjs",
    owns: ["src/server.ts", "src/server/**", "src/stdio.ts", "src/config.ts", "src/project/**", "src/workflow/**"],
    depends_on: ["build"],
    timeout_ms: 90_000,
    execution: "serial",
    resource_level: "default",
    level: "component",
    acceptance_items: ["mcp.registration", "mcp.compatibility"]
  },
  {
    id: "http-compatibility",
    command: "node scripts/http-smoke.mjs",
    owns: ["src/http.ts", "src/http/**", "src/server.ts", "src/server/**", "src/config.ts"],
    depends_on: ["build"],
    timeout_ms: 90_000,
    execution: "serial",
    resource_level: "default",
    level: "component",
    acceptance_items: ["http.compatibility", "http.authentication"]
  },
  {
    id: "pack",
    command: "npm run pack-smoke",
    owns: ["package.json", "templates/**", "shared/**", "src/**", "scripts/**", "docs/**"],
    depends_on: ["build"],
    timeout_ms: 120_000,
    execution: "serial",
    resource_level: "default",
    level: "release",
    acceptance_items: ["package.contents", "package.installability"]
  },
  {
    id: "release-gate",
    command: "npm run smoke",
    owns: ["**/*"],
    depends_on: ["pack"],
    timeout_ms: 180_000,
    execution: "serial",
    resource_level: "cpu-heavy",
    level: "release",
    acceptance_items: ["release.full_regression"]
  }
];

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function pathMatches(file: string, pattern: string): boolean {
  const normalized = normalizePath(file);
  return minimatch(normalized, pattern, { dot: true, nocase: false, matchBase: false });
}

function matchesNode(file: string, node: TestImpactNode): boolean {
  return node.owns.some((pattern) => pathMatches(file, pattern));
}

function includesSharedCore(changedFiles: string[]): boolean {
  return changedFiles.some((file) => SHARED_CORE_PATTERNS.some((pattern) => pathMatches(file, pattern)));
}

function validateGraph(graph: TestImpactNode[]): Map<string, TestImpactNode> {
  const byId = new Map<string, TestImpactNode>();
  for (const node of graph) {
    if (!node.id.trim()) throw new Error("Test Impact node id is required.");
    if (byId.has(node.id)) throw new Error(`Duplicate Test Impact node id: ${node.id}`);
    byId.set(node.id, { ...node, owns: [...node.owns], depends_on: [...node.depends_on], acceptance_items: [...node.acceptance_items] });
  }
  for (const node of byId.values()) {
    for (const dependency of node.depends_on) {
      if (!byId.has(dependency)) throw new Error(`Unknown Test Impact dependency ${dependency} for ${node.id}.`);
    }
  }
  return byId;
}

function dependencyClosure(selected: Set<string>, byId: Map<string, TestImpactNode>): Set<string> {
  const out = new Set(selected);
  const visit = (id: string, stack: string[]) => {
    if (stack.includes(id)) throw new Error(`Test Impact dependency cycle: ${[...stack, id].join(" -> ")}`);
    const node = byId.get(id);
    if (!node) return;
    for (const dependency of node.depends_on) {
      out.add(dependency);
      visit(dependency, [...stack, id]);
    }
  };
  for (const id of [...out]) visit(id, []);
  return out;
}

function topologicalLayers(selected: Set<string>, byId: Map<string, TestImpactNode>): string[][] {
  const pending = new Set(selected);
  const completed = new Set<string>();
  const layers: string[][] = [];
  while (pending.size) {
    const layer = [...pending]
      .filter((id) => (byId.get(id)?.depends_on ?? []).every((dependency) => !selected.has(dependency) || completed.has(dependency)))
      .sort((left, right) => left.localeCompare(right));
    if (!layer.length) throw new Error(`Test Impact dependency cycle among: ${[...pending].join(", ")}`);
    layers.push(layer);
    for (const id of layer) {
      pending.delete(id);
      completed.add(id);
    }
  }
  return layers;
}

function planHash(level: TestImpactLevel, changedFiles: string[], nodes: TestImpactNode[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ level, changedFiles, nodes: nodes.map((node) => ({ id: node.id, command: node.command, depends_on: node.depends_on, provides_build: node.provides_build === true })) }))
    .digest("hex");
}

export function planImpactedTests(changedFilesInput: string[], options: TestImpactPlanOptions = {}): TestImpactPlan {
  const graph = options.graph ?? DEFAULT_TEST_IMPACT_GRAPH;
  const byId = validateGraph(graph);
  const level = options.level ?? "targeted";
  const changedFiles = unique(changedFilesInput.map(normalizePath)).sort((a, b) => a.localeCompare(b));
  const matched = new Set<string>();
  const uncoveredFiles: string[] = [];
  for (const file of changedFiles) {
    let fileCovered = false;
    for (const node of graph) {
      if (node.id === "build" || LEVEL_WEIGHT[node.level] > LEVEL_WEIGHT[level] || !matchesNode(file, node)) continue;
      matched.add(node.id);
      fileCovered = true;
    }
    if (!fileCovered) uncoveredFiles.push(file);
  }

  const expandedForSharedCore = includesSharedCore(changedFiles);
  if (expandedForSharedCore && level === "targeted") {
    for (const node of graph) {
      if (node.level === "targeted" || node.level === "component") matched.add(node.id);
    }
  } else if (level === "component") {
    for (const node of graph) if (node.level !== "release") matched.add(node.id);
  } else if (level === "release") {
    for (const node of graph) matched.add(node.id);
  }

  if (!matched.size) matched.add("build");
  const selected = dependencyClosure(matched, byId);
  const layers = topologicalLayers(selected, byId);
  const orderedIds = layers.flat();
  const nodes = orderedIds.map((id) => byId.get(id)!).filter(Boolean);
  const acceptanceMap: Record<string, string[]> = {};
  for (const node of nodes) {
    for (const item of node.acceptance_items) {
      acceptanceMap[item] = unique([...(acceptanceMap[item] ?? []), node.id]);
    }
  }
  return {
    version: 1,
    plan_hash: planHash(level, changedFiles, nodes),
    level,
    changed_files: changedFiles,
    uncovered_files: uncoveredFiles,
    matched_node_ids: [...matched].sort((a, b) => a.localeCompare(b)),
    expanded_for_shared_core: expandedForSharedCore,
    nodes,
    layers,
    commands: nodes.map((node) => node.command),
    acceptance_map: acceptanceMap,
    cpu_heavy_node_ids: nodes.filter((node) => node.resource_level === "cpu-heavy").map((node) => node.id),
    flaky_node_ids: nodes.filter((node) => node.flaky === true).map((node) => node.id)
  };
}

export function reusablePassedNodeIds(plan: TestImpactPlan, state: TestImpactState | undefined): string[] {
  if (!state || state.plan_hash !== plan.plan_hash) return [];
  return plan.nodes
    .filter((node) => state.results[node.id]?.status === "passed")
    .map((node) => node.id);
}

export function nextTestImpactState(
  plan: TestImpactPlan,
  previous: TestImpactState | undefined,
  record: TestImpactResultRecord
): TestImpactState {
  return {
    version: 1,
    plan_hash: plan.plan_hash,
    updated_at: new Date().toISOString(),
    results: {
      ...(previous?.plan_hash === plan.plan_hash ? previous.results : {}),
      [record.node_id]: { ...record }
    }
  };
}

export function formatTestImpactPlan(plan: TestImpactPlan): string {
  return [
    `Level: ${plan.level}`,
    `Changed files: ${plan.changed_files.length ? plan.changed_files.join(", ") : "none"}`,
    `Uncovered files: ${plan.uncovered_files.length ? plan.uncovered_files.join(", ") : "none"}`,
    `Matched tests: ${plan.matched_node_ids.join(", ") || "build"}`,
    `Expanded for shared core: ${plan.expanded_for_shared_core}`,
    `Execution layers: ${plan.layers.map((layer) => `[${layer.join(", ")}]`).join(" -> ")}`,
    `CPU-heavy tests: ${plan.cpu_heavy_node_ids.join(", ") || "none"}`,
    `Commands: ${plan.commands.join(" | ")}`
  ].join("\n");
}
