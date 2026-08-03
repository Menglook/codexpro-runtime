import type { CoreToolDefinition } from "../../server/coreToolRegistry.js";

export interface ModernMcpAppDescriptor {
  toolName: string;
  resourceUri: string;
  outputTemplateUri?: string;
  sandbox: {
    allowScripts: boolean;
    allowSameOrigin: boolean;
    allowForms: boolean;
    allowedConnectOrigins: string[];
  };
}

export function listModernMcpApps(definitions: CoreToolDefinition[], widgetDomain: string): ModernMcpAppDescriptor[] {
  const origin = new URL(widgetDomain).origin;
  return definitions.flatMap((definition) => {
    const presentation = definition.presentation;
    if (!presentation?.widgetResourceUri) return [];
    validateAppResourceUri(presentation.widgetResourceUri, widgetDomain);
    if (presentation.outputTemplateUri) validateAppResourceUri(presentation.outputTemplateUri, widgetDomain);
    return [{
      toolName: definition.name,
      resourceUri: presentation.widgetResourceUri,
      ...(presentation.outputTemplateUri ? { outputTemplateUri: presentation.outputTemplateUri } : {}),
      sandbox: {
        allowScripts: true,
        allowSameOrigin: false,
        allowForms: false,
        allowedConnectOrigins: [origin]
      }
    }];
  });
}

export function validateAppResourceUri(uri: string, widgetDomain: string): void {
  const resource = new URL(uri, widgetDomain);
  if (resource.protocol === "ui:") {
    if (resource.hostname !== "widget" || !resource.pathname.startsWith("/") || resource.pathname.includes("..")) {
      throw new Error("MCP App ui resource URI is not allowed.");
    }
    return;
  }
  const expected = new URL(widgetDomain);
  if (resource.origin !== expected.origin) throw new Error("MCP App resource origin is not allowed.");
  if (!/^https:$/.test(resource.protocol) && expected.hostname !== "127.0.0.1" && expected.hostname !== "localhost") {
    throw new Error("MCP App resources must use HTTPS outside loopback.");
  }
}
