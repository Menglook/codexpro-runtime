import type { Workspace } from "../guard.js";
import { createWorkspaceMessageStore } from "../messages/messageStore.js";
import type { BrowserDownloadStatus } from "../adapters/playwright-adapter.js";

export async function publishBrowserDownloadMessage(
  workspace: Workspace,
  input: {
    status: BrowserDownloadStatus;
    credential_path: string;
    download_id: string;
    task_id: string;
    run_id: string;
    task_contract_hash: string;
    session_id: string;
    relative_path?: string;
    bytes: number;
    mime: string;
    sha256?: string;
    completion_proof_fields: Record<string, unknown>;
  }
): Promise<{ message_id: string; dedupe_key: string; message_type: string }> {
  const store = createWorkspaceMessageStore(workspace.root);
  const completed = input.status === "completed";
  const messageType = completed ? "browser.download.completed" : "browser.download.failed";
  const dedupeKey = `browser_download:${input.download_id}:${input.status}`;
  const message = await store.append({
    message_type: messageType,
    producer: "browser_session",
    consumer: "browser_download_evidence",
    task_id: input.task_id,
    run_id: input.run_id,
    dedupe_key: dedupeKey,
    payload_ref: input.credential_path,
    payload: {
      status: input.status,
      credential_path: input.credential_path,
      download_id: input.download_id,
      task_contract_hash: input.task_contract_hash,
      session_id: input.session_id,
      relative_path: input.relative_path,
      bytes: input.bytes,
      mime: input.mime,
      sha256: input.sha256,
      completion_proof_fields: input.completion_proof_fields
    },
    max_attempts: 5
  });
  return {
    message_id: message.message_id,
    dedupe_key: message.dedupe_key,
    message_type: message.message_type
  };
}

export async function publishHumanActionPackageMessage(
  workspace: Workspace,
  input: {
    package_id: string;
    task_id: string;
    run_id: string;
    task_contract_hash: string;
    platform: string;
    post_action_verification: string[];
    before_evidence: string[];
  }
): Promise<{ human_action_message_id: string; post_verification_message_id: string }> {
  const store = createWorkspaceMessageStore(workspace.root);
  const human = await store.append({
    message_type: "browser.human_action_package",
    producer: "browser_business_tools",
    consumer: "human_action_operator",
    task_id: input.task_id,
    run_id: input.run_id,
    dedupe_key: `human_action_package:${input.package_id}`,
    payload_ref: `human-action-package:${input.package_id}`,
    payload: {
      package_id: input.package_id,
      task_contract_hash: input.task_contract_hash,
      platform: input.platform,
      before_evidence_refs: input.before_evidence.slice(0, 100)
    },
    max_attempts: 5
  });
  const verification = await store.append({
    message_type: "browser.post_verification.request",
    producer: "browser_business_tools",
    consumer: "browser_result_verifier",
    task_id: input.task_id,
    run_id: input.run_id,
    dedupe_key: `post_verification:${input.package_id}`,
    payload_ref: `human-action-package:${input.package_id}:post-verification`,
    payload: {
      package_id: input.package_id,
      task_contract_hash: input.task_contract_hash,
      platform: input.platform,
      requested_assertions: input.post_action_verification.slice(0, 100),
      evidence_refs: input.before_evidence.slice(0, 100)
    },
    max_attempts: 5
  });
  return {
    human_action_message_id: human.message_id,
    post_verification_message_id: verification.message_id
  };
}

export async function publishBrowserResultAttributionHandoff(
  workspace: Workspace,
  input: {
    task_id: string;
    run_id: string;
    producer?: string;
    attribution_ref: string;
    evidence_refs?: string[];
  }
): Promise<{ message_id: string }> {
  const store = createWorkspaceMessageStore(workspace.root);
  const message = await store.append({
    message_type: "browser.result_attribution.handoff",
    producer: input.producer ?? "wb_dashboard",
    consumer: "browser_result_attribution",
    task_id: input.task_id,
    run_id: input.run_id,
    dedupe_key: `browser_result_attribution:${input.task_id}:${input.run_id}:${input.attribution_ref}`,
    payload_ref: input.attribution_ref,
    payload: {
      evidence_refs: (input.evidence_refs ?? []).slice(0, 100)
    },
    max_attempts: 5
  });
  return { message_id: message.message_id };
}
