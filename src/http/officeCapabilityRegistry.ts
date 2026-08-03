import { createHash } from "node:crypto";
import type { CodexProConfig } from "../config.js";
import { toolNamesForMode } from "../server/toolRegistry.js";
import { buildToolContract, type ToolContractMetadataV1 } from "../tools/toolContract.js";

export interface OfficeCapabilityEntryV1 extends ToolContractMetadataV1 {
  available: boolean;
  availability_reason: string;
}

export interface OfficeCapabilityRegistryV1 {
  version: 1;
  schema_version: "office-capability-registry-v1";
  source: "mcp-tool-contract-registry";
  tool_mode: CodexProConfig["toolMode"];
  count: number;
  registry_hash: string;
  capabilities: OfficeCapabilityEntryV1[];
}

export function officeCapabilityRegistry(config: CodexProConfig): OfficeCapabilityRegistryV1 {
  const capabilities = toolNamesForMode(config)
    .map((name) => ({
      ...buildToolContract(name),
      available: true,
      availability_reason: `当前 ${config.toolMode} 工具模式已公开`
    }))
    .sort((left, right) => left.office_zone.localeCompare(right.office_zone, "zh-CN") || left.tool_name.localeCompare(right.tool_name));
  const registryHash = createHash("sha256")
    .update(JSON.stringify(capabilities.map((item) => [item.tool_name, item.schema_version, item.side_effect_level, item.office_zone, item.available])))
    .digest("hex");
  return {
    version: 1,
    schema_version: "office-capability-registry-v1",
    source: "mcp-tool-contract-registry",
    tool_mode: config.toolMode,
    count: capabilities.length,
    registry_hash: registryHash,
    capabilities
  };
}
