export type ProjectCommandResourceProfile = "acceptance-test" | "acceptance-full-test";
export type ProjectCommandTestScope = "targeted" | "full";
export type ProjectAcceptanceImpactLevel = "targeted" | "component" | "release";

export interface ProjectCommand {
  name: string;
  command: string;
  cwd?: string;
  timeout_ms?: number;
  resource_profile?: ProjectCommandResourceProfile;
  test_scope?: ProjectCommandTestScope;
  allow_full_test?: boolean;
  max_workers?: number;
  require_non_watch_mode?: boolean;
}

export interface ProjectAcceptanceProfile {
  description?: string;
  commands: ProjectCommand[];
  alias_profile?: string;
  dynamic_test_impact?: boolean;
  test_impact_level?: ProjectAcceptanceImpactLevel;
  include_build?: boolean;
}

export interface ProjectPathConfig {
  frontend?: string[];
  backend?: string[];
  docs?: string[];
  reports?: string[];
  risk?: string[];
  [key: string]: string[] | undefined;
}

export interface ProjectBrowserVisualPair {
  name?: string;
  before_url: string;
  after_url: string;
}

export interface ProjectBrowserConfig {
  base_url?: string;
  smoke_urls?: string[];
  visual_pairs?: ProjectBrowserVisualPair[];
  visual_threshold_ratio?: number;
  visual_pixel_delta_threshold?: number;
  allowed_domains?: string[];
}

export interface ProjectContextBudget {
  max_files_per_task?: number;
  max_lines_per_file?: number;
  max_total_chars?: number;
}

export interface ProjectReviewConfig {
  mode?: "advisory" | "gated" | "independent";
  block_on?: {
    P0?: number | null;
    P1?: number | null;
    P2?: number | null;
  };
  require_critical_scope_covered?: boolean;
  independent_provider?: string;
}

export interface ProjectConfigFile {
  name?: string;
  kind?: string;
  type?: string | string[];
  description?: string;
  package_manager?: string;
  primary_language?: string;
  frameworks?: string[];
  adapters?: string[];
  important_paths?: string[];
  blocked_paths?: string[];
  risk_paths?: string[];
  entrypoints?: string[];
  env_files?: string[];
  docker_services?: string[];
  rules?: string[];
  business_rules?: string[];
  notes?: string[];
  commands?: Record<string, string[] | string>;
  paths?: ProjectPathConfig;
  browser?: ProjectBrowserConfig;
  context?: ProjectContextBudget;
  review?: ProjectReviewConfig;
  acceptance?: Record<string, unknown>;
}

export interface AcceptanceConfigFile {
  default_profile?: string;
  profiles?: Record<string, ProjectAcceptanceProfile>;
}

export interface ProjectSignal {
  kind: string;
  path: string;
  detail: string;
}

export interface AgentsRuleFile {
  path: string;
  title: string;
  text: string;
  bytes: number;
}

export interface AgentsRulesSummary {
  files: AgentsRuleFile[];
  rules: string[];
  high_risk_paths: string[];
  test_commands: string[];
  commit_rules: string[];
  warnings: string[];
}

export interface DetectedProjectProfile {
  name: string;
  root: string;
  kind: string;
  adapters: string[];
  package_manager?: string;
  primary_language?: string;
  frameworks: string[];
  signals: ProjectSignal[];
  important_paths: string[];
  suggested_acceptance_commands: ProjectCommand[];
  start_commands: ProjectCommand[];
  build_commands: ProjectCommand[];
  test_commands: ProjectCommand[];
  lint_commands: ProjectCommand[];
  docker_services: string[];
  env_files: string[];
  risk_paths: string[];
  entrypoints: string[];
  has_docker: boolean;
  has_database: boolean;
  has_frontend: boolean;
  has_backend: boolean;
  has_browser_app: boolean;
}

export interface ProjectConfigValidationIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface ProjectConfigLoadResult {
  path: string;
  existed: boolean;
  config: ProjectConfigFile;
  detected: DetectedProjectProfile;
  agents: AgentsRulesSummary;
  validation: ProjectConfigValidationIssue[];
}

export interface ProjectMapResult {
  path: string;
  profile: DetectedProjectProfile;
  content: string;
}
