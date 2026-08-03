import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import type { PathGuard, Workspace } from "../guard.js";
import { TOOL_LIMITS } from "../tools/toolLimits.js";
import { createWorkspaceMessageStore } from "../messages/messageStore.js";
import { recordBrowserSkillUsage } from "../observability/usageProducers.js";
import { BrowserSessionManager, browserDownloadFingerprintFromElement } from "./browser-session.js";
import { loadPersistedBrowserBusinessTask, persistBrowserBusinessTask } from "./browser-business-task-store.js";
import {
  browserBusinessTaskSchema,
  businessFactSchema,
  businessPageRefSchema,
  businessResultAssertionSchema,
  completionProofFieldsForBusinessTask,
  createHumanActionPackage,
  humanActionPackageSchema,
  prepareBrowserBusinessTask,
  validateBrowserBusinessTask,
  verifyBusinessResult
} from "./browser-business-contract.js";
import {
  loadProjectPlatformSkills,
  platformSkillSchema,
  readProjectPlatformSkill,
  runPlatformSkillWithObservation,
  validatePlatformSkill
} from "./platform-skill-runtime.js";
import { extractBrowserSkillPackFacts, recordBrowserSkillDrift } from "./browser-skill-pack-runtime.js";
import { createBrowserExperienceCandidate } from "./browser-experience-candidate.js";
import type { BrowserToolDefinition, BrowserToolResult } from "./browser-tools.js";
import { publishHumanActionPackageMessage } from "./browser-message-producers.js";
import { BrowserSpaceManager } from "./browser-space-manager.js";
import { BROWSER_SPACE_DEFAULT_ID, browserSpaceIdSchema } from "./browser-space.js";

type WorkspaceResolver = (input?: string | { workspaceId?: string; conversationId?: string }) => Workspace;

function workspaceArg(): z.ZodOptional<z.ZodString> {
  return z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace.");
}

function formatJsonBlock(value: unknown): string {
  return `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function localHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function compactTaskFields(task: ReturnType<typeof validateBrowserBusinessTask>): Record<string, unknown> {
  return {
    task_id: task.task_id,
    run_id: task.run_id,
    task_contract_hash: task.task_contract_hash,
    platform: task.platform,
    shop_context: task.shop_context,
    business_object: task.business_object,
    risk_class: task.risk_class,
    allowed_actions: task.allowed_actions,
    handoff_required: task.handoff_required,
    authorization_decision: task.authorization_decision,
    completion_proof_fields: completionProofFieldsForBusinessTask(task)
  };
}

function taskResultText(title: string, task: ReturnType<typeof validateBrowserBusinessTask>): string {
  return [
    `# ${title}`,
    "",
    `Task: ${task.task_id}`,
    `Run: ${task.run_id}`,
    `Contract: ${task.task_contract_hash}`,
    `Platform: ${task.platform}`,
    `Risk: ${task.risk_class}`,
    `Business object: ${task.business_object.type}/${task.business_object.id} (${task.business_object.display_name})`
  ].join("\n");
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function includesText(haystack: string | undefined, needle: string | undefined): boolean {
  const normalizedNeedle = normalizeText(needle);
  return Boolean(normalizedNeedle) && normalizeText(haystack).includes(normalizedNeedle);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function compactDownloadCredential(entry: any): Record<string, unknown> {
  return {
    download_id: entry.download_id,
    status: entry.status,
    credential_path: entry.credential_path,
    relative_path: entry.relative_path,
    bytes: entry.bytes,
    mime: entry.mime,
    mime_source: entry.mime_source,
    sha256: entry.sha256,
    task_id: entry.task_id,
    run_id: entry.run_id,
    session_id: entry.session_id,
    error: entry.error,
    replayed: entry.replayed,
    durable_message: entry.durable_message
  };
}

function locateAliases(value: string | undefined): string[] {
  return String(value ?? "")
    .split(/\s*\|\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function downloadTermsFor(skill: any, step: any): string[] {
  return unique([
    ...locateAliases(step.target),
    ...skill.locate_strategies
      .filter((strategy: any) => ["business_semantic_accessible_name", "role_name"].includes(strategy.method))
      .flatMap((strategy: any) => [...locateAliases(strategy.target), ...locateAliases(strategy.name)])
  ]);
}

function elementSearchText(element: any): string {
  return [element.name, element.text, element.ariaLabel, element.role, element.selector].filter(Boolean).join(" ");
}

function isSafeDownloadButton(element: any): boolean {
  return element.visible !== false
    && element.disabled !== true
    && element.clickable === true
    && normalizeText(element.tagName) === "button"
    && normalizeText(element.role) === "button"
    && !String(element.href ?? "").trim();
}

function exactDownloadLabelMatches(element: any, aliases: string[]): boolean {
  const labels = [element.name, element.text, element.ariaLabel]
    .map((value) => normalizeText(value))
    .filter(Boolean);
  const normalizedAliases = aliases.map((value) => normalizeText(value)).filter(Boolean);
  return labels.some((label) => normalizedAliases.includes(label));
}

function narrowToBusinessObject(elements: any[], task: any): any[] {
  const displayName = task?.business_object?.display_name;
  if (!displayName) return elements;
  const related = elements.filter((element) => includesText(elementSearchText(element), displayName));
  return related.length ? related : elements;
}

function canonicalSelector(value: string | undefined): string {
  return String(value ?? "").replace(/\s+/g, "").replaceAll('"', "'").toLowerCase();
}

function observedStableSelectorCandidates(clickable: any[], selector: string): any[] {
  const expected = selector.split(",").map((entry) => canonicalSelector(entry)).filter(Boolean);
  return clickable.filter((element) => {
    const actual = canonicalSelector(element.selector);
    return actual && expected.some((candidate) => actual === candidate || actual.includes(candidate) || candidate.includes(actual));
  });
}

function uniqueTargetResult(input: {
  step: any;
  strategy: string;
  candidates: any[];
  task: any;
}): { step?: any; ref?: string; selector?: string; strategy?: string; reason?: string; element?: any } | undefined {
  const candidates = narrowToBusinessObject(input.candidates, input.task);
  if (candidates.length > 1) {
    return {
      step: input.step,
      reason: `Multiple download triggers matched ${input.strategy}; stop instead of guessing the report period.`
    };
  }
  const found = candidates[0];
  if (!found) return undefined;
  if (found.ref) return { step: input.step, ref: found.ref, strategy: input.strategy, element: found };
  if (found.selector) return { step: input.step, selector: found.selector, strategy: input.strategy, element: found };
  return {
    step: input.step,
    reason: `The unique download trigger matched ${input.strategy} but has no stable ref or selector.`
  };
}

function resolveSkillDownloadTarget(skill: any, task: any, observation: any): { step?: any; ref?: string; selector?: string; strategy?: string; reason?: string; element?: any } {
  const step = skill.steps.find((candidate: any) => candidate.action === "download");
  if (!step) return {};
  const terms = downloadTermsFor(skill, step);
  const elements = Array.isArray(observation.elements) ? observation.elements : [];
  const clickable = elements.filter((element: any) => isSafeDownloadButton(element));

  for (const strategy of [...skill.locate_strategies].sort((left: any, right: any) => left.order - right.order)) {
    if (strategy.method === "business_semantic_accessible_name" || strategy.method === "stable_element_ref") {
      const exactMatches = clickable.filter((element: any) => exactDownloadLabelMatches(element, terms));
      const exactResult = uniqueTargetResult({ step, strategy: `${strategy.method}:exact`, candidates: exactMatches, task });
      if (exactResult) return exactResult;
    }
    if (strategy.method === "role_name") {
      const aliases = unique([...locateAliases(strategy.name), ...locateAliases(strategy.target), ...terms]);
      const exactMatches = clickable.filter((element: any) => exactDownloadLabelMatches(element, aliases));
      const exactResult = uniqueTargetResult({ step, strategy: `${strategy.method}:exact`, candidates: exactMatches, task });
      if (exactResult) return exactResult;
    }
    if (strategy.method === "stable_selector" && step.selector) {
      const matches = observedStableSelectorCandidates(clickable, step.selector)
        .filter((element: any) => exactDownloadLabelMatches(element, terms));
      const result = uniqueTargetResult({ step, strategy: `${strategy.method}:exact`, candidates: matches, task });
      if (result) return result;
    }
  }
  return { step, reason: "No unique safe download trigger matched the skill locate strategies on the current page." };
}

function blockedSkillResult(base: any, step: any | undefined, reason: string): any {
  const safeReason = reason.trim() || "download_blocked";
  return {
    ...base,
    status: "blocked",
    next_step: `Stop: ${safeReason}`,
    verification: {
      status: "unknown",
      reasons: unique([...(base.verification?.reasons ?? []), safeReason])
    },
    deferred_steps: step
      ? [
          ...(base.deferred_steps ?? []).filter((entry: any) => entry.id !== step.id),
          { id: step.id, action: step.action, description: step.description, reason: safeReason }
        ]
      : base.deferred_steps
  };
}

function applyDownloadResult(base: any, step: any, download: any, reportPath: string): any {
  const evidenceRefs = unique([
    ...(base.evidence_refs ?? []),
    `browser_download:${download.download_id}`,
    download.credential_path,
    ...(download.relative_path ? [download.relative_path] : []),
    reportPath
  ]);
  const facts = [
    ...(base.facts ?? []),
    {
      key: "download_credential",
      label: "Download credential",
      value: download.credential_path,
      evidence_refs: [`browser_download:${download.download_id}`, download.credential_path],
      observed_at: download.downloaded_at,
      source: "browser_download"
    },
    {
      key: "download_status",
      label: "Download status",
      value: download.status,
      evidence_refs: [`browser_download:${download.download_id}`],
      observed_at: download.downloaded_at,
      source: "browser_download"
    }
  ];
  return {
    ...base,
    status: "completed",
    facts,
    verification: download.status === "completed" && base.verification?.status !== "failed"
      ? { status: "verified", reasons: [] }
      : { status: "unknown", reasons: unique([...(base.verification?.reasons ?? []), `browser_download returned ${download.status}`]) },
    evidence_refs: evidenceRefs,
    browser_report_refs: unique([...(base.browser_report_refs ?? []), reportPath]),
    executed_steps: [
      ...(base.executed_steps ?? []),
      { id: step.id, action: step.action, description: step.description }
    ],
    deferred_steps: (base.deferred_steps ?? []).filter((entry: any) => entry.id !== step.id),
    download: compactDownloadCredential(download),
    next_step: download.status === "completed" ? undefined : `Stop: browser_download returned ${download.status}`
  };
}

function attachDownloadFailureResult(base: any, download: any, reportPath: string): any {
  return {
    ...base,
    facts: [
      ...(base.facts ?? []),
      {
        key: "download_status",
        label: "Download status",
        value: download.status,
        evidence_refs: [`browser_download:${download.download_id}`, download.credential_path],
        observed_at: download.downloaded_at,
        source: "browser_download"
      }
    ],
    evidence_refs: unique([
      ...(base.evidence_refs ?? []),
      `browser_download:${download.download_id}`,
      download.credential_path,
      reportPath
    ]),
    browser_report_refs: unique([...(base.browser_report_refs ?? []), reportPath]),
    download: compactDownloadCredential(download)
  };
}

export function browserBusinessToolNames(): string[] {
  return [
    "browser_business_prepare_task",
    "browser_business_validate_task",
    "browser_business_list_skills",
    "browser_business_read_skill",
    "browser_business_validate_skill",
    "browser_business_run_skill",
    "browser_business_generate_handoff",
    "browser_business_verify_result"
  ];
}

export function createBrowserBusinessTools(
  config: CodexProConfig,
  guard: PathGuard,
  resolveWorkspace: WorkspaceResolver
): BrowserToolDefinition[] {
  const sessions = new BrowserSessionManager(config, guard);
  const spaces = new BrowserSpaceManager(config, guard, sessions);
  const workspaceFor = (args: any) => resolveWorkspace({ workspaceId: args.workspace_id, conversationId: args.conversation_id });
  const sessionFor = (args: any) => spaces.sessionFor(workspaceFor(args), args.space_id ?? BROWSER_SPACE_DEFAULT_ID);
  const taskArg = browserBusinessTaskSchema.describe("Prepared browser_business_task returned by browser_business_prepare_task.");

  const definitions: BrowserToolDefinition[] = [
    {
      name: "browser_business_prepare_task",
      title: "Prepare Browser Business Task",
      description: "Validate and prepare a versioned browser_business_task contract with platform, shop, business object, R0-R4 risk boundary, Task authorization decision, run identity, and task_contract_hash.",
      inputSchema: {
        workspace_id: workspaceArg(),
        task_id: z.string().min(1),
        run_id: z.string().optional(),
        platform: z.string().min(1),
        shop_context: z.record(z.unknown()),
        business_object: z.record(z.unknown()),
        intent: z.string().min(1),
        risk_class: z.enum(["R0", "R1", "R2", "R3", "R4"]),
        allowed_actions: z.array(z.enum(["observe", "navigate", "filter", "expand", "download", "prepare_draft", "assert", "record", "report", "handoff"])).optional(),
        forbidden_actions: z.array(z.string().min(1)).optional(),
        preconditions: z.array(z.string().min(1)).optional(),
        success_criteria: z.array(z.string().min(1)).optional(),
        handoff_required: z.boolean().optional(),
        evidence_policy: z.record(z.unknown()).optional()
      },
      safety: "read",
      invoking: "Preparing browser business task...",
      invoked: "Browser business task prepared",
      async handler(args): Promise<BrowserToolResult> {
        const workspace = workspaceFor(args);
        const { workspace_id: _workspaceId, space_id: _spaceId, ...input } = args;
        const task = prepareBrowserBusinessTask(input);
        const taskRef = await persistBrowserBusinessTask(guard, workspace, task);
        return {
          text: [taskResultText("Browser Business Task", task), `Task reference: ${taskRef}`].join("\n"),
          structured: { browser_business_task: task, task_ref: taskRef, ...compactTaskFields(task) }
        };
      }
    },
    {
      name: "browser_business_validate_task",
      title: "Validate Browser Business Task",
      description: "Validate a prepared browser_business_task contract and its task_contract_hash without creating browser state.",
      inputSchema: {
        workspace_id: workspaceArg(),
        task: taskArg
      },
      safety: "read",
      invoking: "Validating browser business task...",
      invoked: "Browser business task validated",
      async handler(args): Promise<BrowserToolResult> {
        const task = validateBrowserBusinessTask(args.task);
        return {
          text: taskResultText("Browser Business Task Validation", task),
          structured: { valid: true, browser_business_task: task, ...compactTaskFields(task) }
        };
      }
    },
    {
      name: "browser_business_list_skills",
      title: "List Browser Platform Skills",
      description: "List governed Browser Skill Pack v2 workflows and compatible v1 platform skills using workspace, user, then builtin precedence.",
      inputSchema: {
        workspace_id: workspaceArg(),
        platform: z.string().optional()
      },
      safety: "read",
      invoking: "Listing browser platform skills...",
      invoked: "Browser platform skills listed",
      async handler(args): Promise<BrowserToolResult> {
        const skills = await loadProjectPlatformSkills(config, guard, workspaceFor(args));
        const filtered = args.platform
          ? skills.filter((entry) => entry.skill.platform.toLowerCase() === String(args.platform).toLowerCase())
          : skills;
        const compact = filtered.map((entry) => ({
          id: entry.skill.id,
          version: entry.skill.version,
          platform: entry.skill.platform,
          intent: entry.skill.intent,
          risk_class: entry.skill.risk_class,
          path: entry.path,
          skill_contract_hash: entry.skill_contract_hash,
          source_contract_version: entry.source_contract_version,
          layer: entry.layer,
          pack_id: entry.pack_id,
          pack_version: entry.pack_version,
          pack_status: entry.pack_status,
          migration: entry.migration
        }));
        return {
          text: ["# Browser Platform Skills", "", `${compact.length} skill(s).`, formatJsonBlock(compact)].join("\n"),
          structured: { skills: compact, count: compact.length }
        };
      }
    },
    {
      name: "browser_business_read_skill",
      title: "Read Browser Platform Skill",
      description: "Read one layered Browser Skill Pack workflow or compatible v1 platform skill by id.",
      inputSchema: {
        workspace_id: workspaceArg(),
        skill_id: z.string().min(1)
      },
      safety: "read",
      invoking: "Reading browser platform skill...",
      invoked: "Browser platform skill ready",
      async handler(args): Promise<BrowserToolResult> {
        const loaded = await readProjectPlatformSkill(config, guard, workspaceFor(args), args.skill_id);
        return {
          text: ["# Browser Platform Skill", "", `Skill: ${loaded.skill.id}`, `Path: ${loaded.path}`, `Hash: ${loaded.skill_contract_hash}`].join("\n"),
          structured: {
            platform_skill: loaded.skill,
            path: loaded.path,
            skill_contract_hash: loaded.skill_contract_hash,
            source_contract_version: loaded.source_contract_version,
            layer: loaded.layer,
            pack_id: loaded.pack_id,
            pack_version: loaded.pack_version,
            pack_status: loaded.pack_status,
            migration: loaded.migration
          }
        };
      }
    },
    {
      name: "browser_business_validate_skill",
      title: "Validate Browser Platform Skill",
      description: "Validate an inline platform_skill payload for schema shape, risk/read-only boundaries, locate order, and no fixed coordinates.",
      inputSchema: {
        workspace_id: workspaceArg(),
        skill: platformSkillSchema
      },
      safety: "read",
      invoking: "Validating browser platform skill...",
      invoked: "Browser platform skill validated",
      async handler(args): Promise<BrowserToolResult> {
        const skill = validatePlatformSkill(args.skill);
        return {
          text: ["# Browser Platform Skill Validation", "", `Skill: ${skill.id}`, "Valid: yes"].join("\n"),
          structured: { valid: true, platform_skill: skill }
        };
      }
    },
    {
      name: "browser_business_run_skill",
      title: "Run Browser Business Skill",
      description: "Observe the current authorized browser session, validate task/skill context and entry fingerprints, then run safe automatic skill steps including controlled download when explicitly authorized. It reuses BrowserSession and Browser Report.",
      inputSchema: {
        workspace_id: workspaceArg(),
        task: taskArg.optional().describe("Full prepared browser_business_task. Use either this or task_id+run_id."),
        task_id: z.string().min(1).optional().describe("Persisted task id returned by browser_business_prepare_task. Must be paired with run_id."),
        run_id: z.string().min(1).optional().describe("Persisted run id returned by browser_business_prepare_task. Must be paired with task_id."),
        skill_id: z.string().min(1),
        max_nodes: z.number().int().min(1).max(TOOL_LIMITS.browser.observe_max_nodes).optional(),
        max_text_chars: z.number().int().min(1000).max(TOOL_LIMITS.browser.observe_max_text_chars).optional()
      },
      safety: "write",
      invoking: "Running browser business skill...",
      invoked: "Browser business skill result ready",
      async handler(args): Promise<BrowserToolResult> {
        const workspace = workspaceFor(args);
        const hasFullTask = args.task !== undefined;
        const hasTaskReference = Boolean(args.task_id || args.run_id);
        if (hasFullTask === hasTaskReference) {
          throw new Error("Provide exactly one browser task source: full task, or task_id together with run_id.");
        }
        if (hasTaskReference && (!args.task_id || !args.run_id)) {
          throw new Error("Both task_id and run_id are required for a persisted browser task reference.");
        }
        const task = hasFullTask
          ? validateBrowserBusinessTask(args.task)
          : await loadPersistedBrowserBusinessTask(guard, workspace, String(args.task_id), String(args.run_id));
        const loaded = await readProjectPlatformSkill(config, guard, workspace, args.skill_id);
        const session = sessionFor(args);
        const usageStartedAt = new Date().toISOString();
        const usageBeforeStatus = session.status();
        const observation = await session.observe({
          scope: "document",
          maxNodes: args.max_nodes ?? Math.min(config.browserObserveMaxNodes, TOOL_LIMITS.browser.inspect_default_nodes),
          maxTextChars: args.max_text_chars ?? Math.min(config.browserObserveMaxTextChars, TOOL_LIMITS.browser.inspect_default_text_chars),
          includeTables: true,
          includeForms: true,
          includeLayoutIssues: true,
          includeAccessibility: true
        });
        const initialReport = await session.writeReport();
        const drift = loaded.pack_source
          ? await recordBrowserSkillDrift({
              guard,
              workspace,
              run_id: task.run_id,
              pack: loaded.pack_source.pack,
              page: loaded.pack_source.page,
              snapshot: observation
            })
          : undefined;
        let result = runPlatformSkillWithObservation({
          task,
          skill: loaded.skill,
          observation,
          browser_report_refs: [initialReport.path]
        });
        if (drift) {
          (result as any).skill_pack = {
            pack_id: loaded.pack_id,
            pack_version: loaded.pack_version,
            layer: loaded.layer,
            manifest_status: loaded.pack_status,
            runtime_status: drift.state.status,
            interaction_allowed: drift.state.interaction_allowed,
            drift_state_ref: drift.path,
            contract_hash: loaded.pack_contract_hash
          };
          result.evidence_refs = unique([...result.evidence_refs, drift.path]);
          (result as any).skill_pack_facts = extractBrowserSkillPackFacts({
            source: loaded.pack_source!,
            snapshot: observation,
            shop: task.shop_context.display_name ?? task.shop_context.shop_name ?? task.shop_context.shop_id ?? "unknown",
            business_object: task.business_object.display_name
          });
          if (drift.state.status === "quarantined") {
            result = blockedSkillResult(result, undefined, "Browser Skill Pack is quarantined after page fingerprint drift; only observation and diagnostics are allowed.");
          }
        }
        const downloadTarget = resolveSkillDownloadTarget(loaded.skill, task, observation);
        if (downloadTarget.step && result.status === "completed" && (!drift || drift.state.interaction_allowed)) {
          if (!downloadTarget.ref || !downloadTarget.element) {
            result = blockedSkillResult(result, downloadTarget.step, downloadTarget.reason ?? "No safe snapshot-bound download trigger was found.");
          } else {
            const resourceOwner = `tool-browser_business_run_skill-${randomUUID()}`;
            try {
              if (!await spaces.acquireResource(workspace, args.space_id ?? BROWSER_SPACE_DEFAULT_ID, resourceOwner, "download")) {
                throw new Error(`Browser Space ${args.space_id ?? BROWSER_SPACE_DEFAULT_ID} is waiting_resource for the download lease.`);
              }
              const download = await session.download({
                task,
                ref: downloadTarget.ref,
                snapshotId: observation.snapshotId,
                elementFingerprint: browserDownloadFingerprintFromElement(downloadTarget.element),
                prevalidatedSnapshot: observation,
                context: {
                  platform: loaded.skill.platform,
                  shop_context: task.shop_context,
                  business_object: task.business_object,
                  page_fingerprints: loaded.skill.entry_fingerprints,
                  required_visible_text: [task.business_object.display_name]
                }
              });
              const finalReport = await session.writeReport();
              result = download.status === "completed"
                ? applyDownloadResult(result, downloadTarget.step, download, finalReport.path)
                : blockedSkillResult(attachDownloadFailureResult(result, download, finalReport.path), downloadTarget.step, `browser_download returned ${download.status}`);
            } catch (error) {
              result = blockedSkillResult(result, downloadTarget.step, error instanceof Error ? error.message : String(error));
            } finally {
              await spaces.releaseResource(workspace, args.space_id ?? BROWSER_SPACE_DEFAULT_ID, resourceOwner, "download");
            }
          }
        }
        const report = await session.writeReport();
        result.browser_report_refs = unique([...(result.browser_report_refs ?? []), report.path]);
        if (loaded.pack_source && result.status === "completed" && result.verification.status === "verified" && drift?.state.status === "active") {
          const experience = await createBrowserExperienceCandidate({
            guard,
            workspace,
            source: loaded.pack_source,
            result,
            drift_reasons: drift.evaluation.reasons
          });
          (result as any).experience_candidate = {
            candidate_id: experience.candidate.candidate_id,
            path: experience.path,
            approval_status: experience.candidate.approval.status,
            automatic_long_term_write: experience.candidate.automatic_long_term_write
          };
          result.evidence_refs = unique([...result.evidence_refs, experience.path]);
        }
        recordBrowserSkillUsage({
          workspace_root: workspace.root,
          result,
          started_at: usageStartedAt,
          finished_at: new Date().toISOString(),
          before_status: usageBeforeStatus,
          after_status: session.status()
        });
        return {
          text: [
            "# Browser Business Skill Run",
            "",
            `Skill: ${result.skill_id}`,
            `Task: ${result.task_id}`,
            `Status: ${result.status}`,
            `Verification: ${result.verification.status}`,
            `Snapshot: ${result.current_page.snapshot_id}`,
            `Report: ${report.path}`,
            (result as any).download?.credential_path ? `Download credential: ${(result as any).download.credential_path}` : "",
            result.next_step ? `Next step: ${result.next_step}` : ""
          ].filter(Boolean).join("\n"),
          structured: { platform_skill_run: result, ...result }
        };
      }
    },
    {
      name: "browser_business_generate_handoff",
      title: "Generate Human Browser Action Package",
      description: "Generate a versioned human_action_package for a prepared browser business task. Final business actions are explicitly marked human-only.",
      inputSchema: {
        workspace_id: workspaceArg(),
        task: taskArg,
        current_facts: z.array(businessFactSchema).min(1),
        recommended_action: z.string().min(1),
        reason: z.string().min(1),
        current_page: businessPageRefSchema,
        steps: z.array(z.object({
          index: z.number().int().min(1),
          instruction: z.string().min(1),
          action: z.string().optional(),
          human_required: z.boolean()
        }).strict()).min(1),
        human_final_action: z.object({
          label: z.string().min(1),
          must_be_performed_by: z.literal("human"),
          requires_confirmation: z.boolean(),
          irreversible: z.boolean().optional()
        }).strict(),
        forbidden_actions: z.array(z.string().min(1)).optional(),
        expected_result: z.string().min(1),
        risk_warnings: z.array(z.string().min(1)).min(1),
        post_action_verification: z.array(z.string().min(1)).min(1),
        before_evidence: z.array(z.string().min(1)).min(1),
        handoff_time: z.string().optional()
      },
      safety: "read",
      invoking: "Generating human action package...",
      invoked: "Human action package ready",
      async handler(args): Promise<BrowserToolResult> {
        const { workspace_id: _workspaceId, space_id: _spaceId, ...handoffInput } = args;
        const handoff = createHumanActionPackage(handoffInput);
        const delivery = await publishHumanActionPackageMessage(workspaceFor(args), {
          package_id: handoff.package_id,
          task_id: handoff.task_id,
          run_id: handoff.run_id,
          task_contract_hash: handoff.task_contract_hash,
          platform: handoff.platform,
          post_action_verification: handoff.post_action_verification,
          before_evidence: handoff.before_evidence
        });
        return {
          text: [
            "# Human Action Package",
            "",
            `Package: ${handoff.package_id}`,
            `Task: ${handoff.task_id}`,
            `Human final action: ${handoff.human_final_action.label}`,
            `Handoff time: ${handoff.handoff_time}`
          ].join("\n"),
          structured: { human_action_package: handoff, durable_messages: delivery }
        };
      }
    },
    {
      name: "browser_business_verify_result",
      title: "Verify Browser Business Result",
      description: "Compare before/after structured facts and assertions. Returns only verified, failed, or unknown; insufficient evidence is unknown.",
      inputSchema: {
        workspace_id: workspaceArg(),
        task: taskArg,
        before_facts: z.array(businessFactSchema),
        after_facts: z.array(businessFactSchema),
        assertions: z.array(businessResultAssertionSchema).min(1),
        evidence_refs: z.array(z.string().min(1)).optional()
      },
      safety: "read",
      invoking: "Verifying browser business result...",
      invoked: "Browser business result verification ready",
      async handler(args): Promise<BrowserToolResult> {
        const { workspace_id: _workspaceId, space_id: _spaceId, ...verificationInput } = args;
        const verification = verifyBusinessResult(verificationInput);
        const verificationHash = localHash({
          task_id: verification.task_id,
          run_id: verification.run_id,
          status: verification.status,
          assertions: verification.assertions,
          evidence_refs: verification.evidence_refs
        });
        const store = createWorkspaceMessageStore(workspaceFor(args).root);
        const postVerificationResult = await store.append({
          message_type: "browser.post_verification.result",
          producer: "browser_business_tools",
          consumer: "browser_result_verifier",
          task_id: verification.task_id,
          run_id: verification.run_id,
          dedupe_key: `post_verification_result:${verification.task_id}:${verification.run_id}:${verification.status}:${verificationHash}`,
          payload_ref: `browser-result-verification:${verificationHash}`,
          payload: {
            status: verification.status,
            verification_hash: verificationHash,
            evidence_refs: verification.evidence_refs.slice(0, 100)
          },
          max_attempts: 5
        });
        return {
          text: [
            "# Browser Business Result Verification",
            "",
            `Task: ${verification.task_id}`,
            `Run: ${verification.run_id}`,
            `Status: ${verification.status}`,
            verification.reasons.length ? `Reasons: ${verification.reasons.join("; ")}` : ""
          ].filter(Boolean).join("\n"),
          structured: { business_result_verification: verification, durable_messages: { post_verification_result_message_id: postVerificationResult.message_id } }
        };
      }
    }
  ];
  return definitions.map((definition) => {
    const originalHandler = definition.handler;
    return {
      ...definition,
      inputSchema: {
        ...definition.inputSchema,
        space_id: browserSpaceIdSchema.optional().describe("Browser Task Space id. Omit to use default.")
      },
      async handler(args: any) {
        if (definition.name === "browser_business_run_skill") {
          await spaces.ensureUsable(workspaceFor(args), args.space_id ?? BROWSER_SPACE_DEFAULT_ID);
        }
        return originalHandler(args);
      }
    };
  });
}
