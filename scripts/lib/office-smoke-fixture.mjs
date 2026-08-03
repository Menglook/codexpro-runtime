export const NOW = '2026-07-27T06:00:00.000Z';

export function componentRecord(overrides = {}) {
  return {
    version: 1,
    component_id: 'worker:main',
    kind: 'worker',
    task_id: 'task-current',
    run_id: 'run-current',
    owner_id: null,
    fencing_token: 1,
    registered_at: NOW,
    last_liveness_at: NOW,
    last_progress_at: NOW,
    last_meaningful_progress_at: NOW,
    activity_state: 'tool_writing',
    safe_summary: 'Editing source files',
    user_action_required: null,
    last_activity_event: null,
    last_transition_at: NOW,
    expected_silence_until: null,
    no_progress_deadline: null,
    hard_deadline: null,
    state: 'running',
    progress_marker: 'Editing source files',
    terminal_reason: null,
    evidence_ref: '.ai-bridge/evidence/current.json',
    ...overrides
  };
}

export function attempt(overrides = {}) {
  const base = {
    task_id: 'task-current',
    run_id: 'run-current',
    workspace_id: 'workspace-a',
    workspace_root: '/workspace/project-a',
    workspace_generation: 1,
    identity_quality: 'authoritative',
    legacy_binding: false,
    source_conversation_id: 'conversation-a',
    actor_id: 'actor:executor-a',
    actor_role: 'executor',
    title: 'Implement office projection',
    status: 'running',
    domain_status: 'running',
    outcome: {
      version: 1,
      execution_status: 'running',
      validation_status: 'not_requested',
      delivery_status: 'not_requested',
      evidence_status: 'pending',
      primary_reason_code: null,
      blocked_capability: null,
      recoverable: true,
      updated_at: NOW
    },
    executor: {
      kind: 'codex',
      provider: 'openai',
      model: 'gpt-test',
      execution_id: 'execution-current',
      source: 'runtime'
    },
    liveness: 'working',
    liveness_reason: 'recent progress',
    current_phase: 'executing',
    phase: 'executing',
    current_step: 2,
    total_steps: 5,
    current_action: 'Editing source files',
    progress_summary: 'Editing source files',
    activity_state: 'tool_writing',
    activity_label: '开发中',
    safe_progress_summary: 'Editing source files',
    last_meaningful_progress_at: NOW,
    no_progress_level: 'fresh',
    no_progress_duration_ms: 0,
    user_action_required: null,
    wait_reason: null,
    last_heartbeat: NOW,
    last_evidence: '.ai-bridge/evidence/current.json',
    writer_activity: { active: true },
    browser_activity: { active: false },
    validation_activity: { active: false },
    resource_policy: {
      run_id: 'run-current',
      resource_class: 'standard',
      priority: 'normal',
      execution_mode: 'write',
      status: 'admitted',
      pools: ['workspace_write'],
      blocking_reasons: [],
      queue_id: null,
      queue_position: null,
      lease_id: 'lease-current',
      queue_duration_ms: 0,
      policy_source: 'fixture',
      occupancy: [],
      snapshot: null,
      updated_at: NOW
    },
    execution_observability: {
      owner_id: 'owner-current',
      fencing_token: 1,
      execution_state: 'working',
      liveness_state: 'working',
      last_liveness_at: NOW,
      last_progress_at: NOW,
      no_progress_deadline: null,
      hard_deadline: null,
      termination_reason: null,
      latest_error: null,
      recovering: false
    },
    execution_components: {
      model_stream: {},
      tool_processes: {},
      workers: { 'worker:main': componentRecord() }
    },
    safe_to_close_chat: {
      safe: true,
      reason: 'Durable task identity and local authority remain available after the ChatGPT page closes.',
      stable_task_identity: true,
      authority_recognized: true,
      authority: 'durable_job_store'
    },
    acceptance_status: 'not_requested',
    git_finalization: null,
    available_actions: [],
    created_at: NOW,
    updated_at: NOW
  };
  return deepMerge(base, overrides);
}

export function objective(overrides = {}) {
  const current = overrides.current_attempt === undefined ? attempt() : overrides.current_attempt;
  const base = {
    objective_key: 'objective:office',
    project_id: 'project-a',
    project_name: 'Project A',
    title: 'Office visualization',
    stage_key: null,
    source: 'explicit',
    status: 'active',
    reason_code: 'current_attempt_active',
    current_attempt_id: current?.task_id ?? null,
    current_attempt: current,
    attempts: current ? [{
      attempt_id: current.task_id,
      status: current.status,
      liveness: current.liveness,
      supersession: 'current',
      superseded_by_attempt_id: null,
      updated_at: current.updated_at
    }] : [],
    requires_human: false,
    user_action_required: null,
    system_next_action: null,
    activity_state: current?.activity_state ?? 'unknown',
    activity_label: current?.activity_label ?? '状态未知',
    last_meaningful_progress_at: current?.last_meaningful_progress_at ?? NOW,
    no_progress_level: current?.no_progress_level ?? 'unknown',
    no_progress_duration_ms: current?.no_progress_duration_ms ?? null,
    last_progress_at: current?.last_meaningful_progress_at ?? NOW,
    created_at: NOW,
    updated_at: current?.updated_at ?? NOW
  };
  return deepMerge(base, overrides);
}

export function project(overrides = {}) {
  return {
    project_id: 'project-a',
    name: 'Project A',
    root: '/workspace/project-a',
    workspace_id: 'workspace-a',
    workspace_generation: 1,
    available: true,
    unavailable_reason: null,
    branch: 'main',
    git_status_summary: { summary: 'clean' },
    watcher_status: { state: 'healthy' },
    ...overrides
  };
}

export function dashboard(overrides = {}) {
  return deepMerge({
    generated_at: NOW,
    projects: [project()],
    tasks: [],
    objectives: [objective()],
    counts: {},
    objective_counts: {},
    current_task_id: 'task-current',
    current_task: null,
    current_objective_id: 'objective:office',
    current_objective: null,
    recent_deliveries: [],
    recent_delivery_summary: null,
    attention: null,
    resource_governance: {
      schema_version: 1,
      state_path: '/workspace/project-a/.ai-bridge/resource-state.json',
      generated_at: NOW,
      config: {},
      snapshot: {},
      occupancy: [],
      leases: [],
      queue: []
    },
    pagination: { page_size: 25, next_cursor: null },
    projection_observability: {}
  }, overrides);
}

export function clone(value) {
  return structuredClone(value);
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return patch === undefined ? structuredClone(base) : patch;
  if (Array.isArray(base) || Array.isArray(patch)) return structuredClone(patch);
  if (typeof base !== 'object' || typeof patch !== 'object') return structuredClone(patch);
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = structuredClone(value);
    }
  }
  return output;
}
