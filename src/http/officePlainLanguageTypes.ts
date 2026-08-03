export interface OfficePlainSummaryV1 {
  version: 1;
  task_status: string;
  current_work: string;
  latest_result: string;
  next_step: string;
  owner_action: string;
  background_continuation: string;
  delivery_status: string;
  validation_status: string;
  risk_status: string;
}

export interface OfficePlainLanguageFeatureFlag {
  enabled: boolean;
  tech_view_enabled: boolean;
}
