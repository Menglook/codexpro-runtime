import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CodexProConfig } from "../config.js";
import type { Workspace } from "../guard.js";

export const BROWSER_SPACE_VERSION = 1 as const;
export const BROWSER_SPACE_MAX_CREATED = 3;
export const BROWSER_SPACE_MAX_RUNNING_FLOWS = 2;
export const BROWSER_SPACE_DEFAULT_ID = "default";
export const BROWSER_SPACE_FALLBACK_RUN_ID = "workspace";

export const browserSpaceIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const browserSpaceModeSchema = z.enum(["shared_profile", "isolated_context", "isolated_profile"]);
export const browserSpaceStatusSchema = z.enum([
  "creating",
  "ready",
  "active",
  "waiting_resource",
  "recovering",
  "orphaned",
  "closing",
  "closed",
  "failed"
]);

export const browserSpaceResourceLeaseSchema = z.object({
  status: z.enum(["none", "waiting", "leased"]),
  interactive_profile_slot: z.boolean(),
  visual_slot: z.boolean(),
  download_slot: z.boolean(),
  leased_at: z.string().datetime().optional(),
  lease_owner: z.string().min(1).optional()
}).strict();

export const browserSpaceManifestSchema = z.object({
  version: z.literal(BROWSER_SPACE_VERSION),
  space_id: browserSpaceIdSchema,
  workspace_id: z.string().min(1),
  mode: browserSpaceModeSchema,
  owner_task_id: z.string().nullable(),
  owner_run_id: z.string().nullable(),
  created_at: z.string().datetime(),
  last_used_at: z.string().datetime(),
  status: browserSpaceStatusSchema,
  controlled_tab_ids: z.array(z.string().min(1)),
  active_page_id: z.string().nullable(),
  active_flow_id: z.string().nullable(),
  browser_session_id: z.string().min(1),
  profile_identity_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  report_root: z.string().min(1).refine((value) => !value.startsWith("/") && !value.includes(".."), "report_root must be a safe relative path"),
  resource_lease: browserSpaceResourceLeaseSchema,
  recovery_notes: z.array(z.string().min(1)).optional()
}).strict();

export const browserTabOwnershipSchema = z.object({
  version: z.literal(1),
  tab_id: z.string().min(1),
  space_id: z.string().min(1),
  created_by_codexpro: z.boolean(),
  ownership: z.enum(["owned", "external", "adopted", "orphaned"]),
  url: z.string(),
  title: z.string(),
  last_seen_at: z.string().datetime(),
  transfer_state: z.enum(["none", "pending", "completed", "rejected"]),
  transferred_from_space_id: z.string().optional(),
  adoption_evidence_ref: z.string().optional(),
  close_with_space: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if (value.ownership === "external" && value.close_with_space !== false) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "External tabs must not close with a space.", path: ["close_with_space"] });
  }
  if (value.ownership === "owned" && value.close_with_space !== true) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Owned tabs must close with a space.", path: ["close_with_space"] });
  }
});

export type BrowserSpaceMode = z.infer<typeof browserSpaceModeSchema>;
export type BrowserSpaceStatus = z.infer<typeof browserSpaceStatusSchema>;
export type BrowserSpaceResourceLease = z.infer<typeof browserSpaceResourceLeaseSchema>;
export type BrowserSpaceManifest = z.infer<typeof browserSpaceManifestSchema>;
export type BrowserTabOwnership = z.infer<typeof browserTabOwnershipSchema>;

export interface BrowserSpaceCreateInput {
  space_id?: string;
  mode?: BrowserSpaceMode;
  owner_task_id?: string | null;
  owner_run_id?: string | null;
}

function pathIdentifier(value: string, label: string, maximum = 160): string {
  if (new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${maximum - 1}}$`).test(value) && value !== "." && value !== "..") return value;
  return `${label}-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export function browserSpaceRoot(runId: string | null | undefined, spaceId: string): string {
  const safeRunId = pathIdentifier(runId ?? BROWSER_SPACE_FALLBACK_RUN_ID, "run");
  const safeSpaceId = browserSpaceIdSchema.parse(spaceId);
  return `.codexpro/runs/${safeRunId}/browser-spaces/${safeSpaceId}`;
}

export function browserSpaceManifestPath(runId: string | null | undefined, spaceId: string): string {
  return `${browserSpaceRoot(runId, spaceId)}/manifest.json`;
}

export function browserSpaceTabPath(runId: string | null | undefined, spaceId: string, tabId: string): string {
  const safeTabId = pathIdentifier(tabId, "tab", 120);
  return `${browserSpaceRoot(runId, spaceId)}/tabs/${safeTabId}.json`;
}

export function browserSpaceProfileIdentityHash(config: CodexProConfig, workspace: Workspace, mode: BrowserSpaceMode): string {
  const profileIdentity = mode === "isolated_context"
    ? `ephemeral-context:${workspace.id}`
    : `${config.browserMode}:${config.browserCdpUrl ?? ""}:${config.browserCdpProfileDir ?? ""}`;
  return `sha256:${createHash("sha256").update(profileIdentity).digest("hex")}`;
}

export function emptyBrowserSpaceResourceLease(): BrowserSpaceResourceLease {
  return {
    status: "none",
    interactive_profile_slot: false,
    visual_slot: false,
    download_slot: false
  };
}

export function createBrowserSpaceManifest(input: {
  config: CodexProConfig;
  workspace: Workspace;
  spaceId: string;
  mode: Exclude<BrowserSpaceMode, "isolated_profile">;
  ownerTaskId?: string | null;
  ownerRunId?: string | null;
  browserSessionId: string;
  reportRoot: string;
  createdAt?: string;
}): BrowserSpaceManifest {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return browserSpaceManifestSchema.parse({
    version: BROWSER_SPACE_VERSION,
    space_id: input.spaceId,
    workspace_id: input.workspace.id,
    mode: input.mode,
    owner_task_id: input.ownerTaskId ?? null,
    owner_run_id: input.ownerRunId ?? null,
    created_at: createdAt,
    last_used_at: createdAt,
    status: "ready",
    controlled_tab_ids: [],
    active_page_id: null,
    active_flow_id: null,
    browser_session_id: input.browserSessionId || randomUUID(),
    profile_identity_hash: browserSpaceProfileIdentityHash(input.config, input.workspace, input.mode),
    report_root: input.reportRoot,
    resource_lease: emptyBrowserSpaceResourceLease(),
    recovery_notes: []
  });
}
