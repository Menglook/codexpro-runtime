import type { ProjectCommand, ProjectSignal } from "../project/types.js";

export interface AdapterDetectionContext {
  root: string;
  fileExists(relPath: string): Promise<boolean>;
  readText(relPath: string, maxBytes?: number): Promise<string | undefined>;
  readJson(relPath: string): Promise<Record<string, unknown> | undefined>;
  collectExisting(relPaths: string[]): Promise<string[]>;
}

export interface AdapterCommandGroups {
  start?: ProjectCommand[];
  build?: ProjectCommand[];
  test?: ProjectCommand[];
  lint?: ProjectCommand[];
  suggested?: ProjectCommand[];
}

export interface AdapterDetection {
  adapter: string;
  enabled: boolean;
  signals?: ProjectSignal[];
  package_manager?: string;
  primary_language?: string;
  frameworks?: string[];
  important_paths?: string[];
  risk_paths?: string[];
  entrypoints?: string[];
  docker_services?: string[];
  commands?: AdapterCommandGroups;
  has_docker?: boolean;
  has_database?: boolean;
  has_frontend?: boolean;
  has_backend?: boolean;
  has_browser_app?: boolean;
  metadata?: Record<string, unknown>;
}

export interface CodexProAdapter {
  id: string;
  name: string;
  description?: string;
  detect(context: AdapterDetectionContext): Promise<AdapterDetection>;
}

export interface AdapterProfile {
  adapters: string[];
  signals: ProjectSignal[];
  package_manager?: string;
  primary_language?: string;
  frameworks: string[];
  important_paths: string[];
  risk_paths: string[];
  entrypoints: string[];
  docker_services: string[];
  commands: Required<AdapterCommandGroups>;
  has_docker: boolean;
  has_database: boolean;
  has_frontend: boolean;
  has_backend: boolean;
  has_browser_app: boolean;
}
