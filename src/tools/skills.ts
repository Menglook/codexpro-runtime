import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import { listInstalledSkills, readInstalledSkill } from "../skills/skillReader.js";
import { issueSkillUsageReceipt } from "../skills/skillUsage.js";

export interface SkillToolResult {
  text: string;
  structured: Record<string, unknown>;
}

export interface SkillToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  invoking: string;
  invoked: string;
  handler(args: any): Promise<SkillToolResult>;
}

export const EXPLICIT_SKILL_LOADING_INSTRUCTION = [
  "Explicit Skill loading rule: when the user explicitly names an installed Skill",
  "(for example: use neat-freak, run neat-freak, 按 neat-freak 检查这个项目, or /neat),",
  "call read_skill for that exact Skill before opening, inspecting, or modifying the project.",
  "Load the current approved version from the lock file and never rely on remembered Skill content.",
  "Do not auto-trigger a Skill for generic requests such as fixing an error, writing a weekly report, or cleaning JSON.",
  "When an explicitly loaded Skill task writes files, pass the returned skill_receipt and a skill_plan with path, reason, and evidence for every planned file to run_task, run_stage, or start_run_task; do not use write, edit, or apply_patch_bundle directly.",
  "For neat-freak, project source and configuration are evidence-only: writes are limited to approved documentation paths and network, deployment, Git mutation, deletion, cross-project writes, and direct memory writes are forbidden.",
  "After a neat-freak write task, call run_neat_freak_acceptance with the same skill_receipt and run_id; do not claim completion unless its acceptance_passed field is true."
].join(" ");

export function skillToolNames(): string[] {
  return ["list_skills", "read_skill", "run_neat_freak_acceptance"];
}

export function createSkillTools(config: CodexProConfig): SkillToolDefinition[] {
  if (!config.skillsEnabled) return [];
  return [
    {
      name: "list_skills",
      title: "List Approved Skills",
      description: "List fixed-version Skills from the configured lock file and verify each SKILL.md fingerprint. Read-only; does not execute, update, or download Skills.",
      inputSchema: {},
      invoking: "Checking approved Skills...",
      invoked: "Approved Skills ready",
      async handler(): Promise<SkillToolResult> {
        const skills = await listInstalledSkills(config);
        const text = [
          "# Approved Skills",
          "",
          `${skills.length} Skill(s) in the lock file.`,
          "",
          ...skills.map((skill) => `- ${skill.name} ${skill.version ? `v${skill.version} ` : ""}— ${skill.enabled ? "enabled" : "disabled"}, integrity=${skill.integrity}, commit=${skill.source_commit}`)
        ].join("\n");
        return { text, structured: { skills, count: skills.length } };
      }
    },
    {
      name: "read_skill",
      title: "Read Approved Skill",
      description: "Read SKILL.md or one relative text resource from a fixed-version approved Skill after fingerprint and path checks. Never executes scripts, writes files, downloads content, or invokes other tools.",
      inputSchema: {
        skill_name: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9._-]*$/).describe("Exact Skill name from list_skills."),
        resource: z.string().min(1).max(500).optional().describe("Optional relative path inside the locked Skill root, for example references/verification.md.")
      },
      invoking: "Reading approved Skill...",
      invoked: "Approved Skill loaded",
      async handler(args): Promise<SkillToolResult> {
        const result = await readInstalledSkill(config, args.skill_name, args.resource);
        const skillReceipt = issueSkillUsageReceipt(result);
        const text = [
          `# Skill: ${result.skill.name}`,
          "",
          `Version: ${result.skill.version ?? "not declared"}`,
          `Source: ${result.skill.source_repository}@${result.skill.source_commit}`,
          `Resource: ${result.resource}`,
          `Digest: ${result.skill.digest}`,
          `Integrity: ${result.skill.integrity}`,
          `Skill receipt: ${skillReceipt.receipt_id}`,
          `Receipt expires: ${skillReceipt.expires_at}`,
          "",
          result.content
        ].join("\n");
        return {
          text,
          structured: {
            ...result as unknown as Record<string, unknown>,
            skill_receipt: skillReceipt
          }
        };
      }
    }
  ];
}
