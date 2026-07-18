import type { Endpoint, EndpointCapability, EndpointInput } from "../../lib/api/client.js";

export const endpointCapabilities: EndpointCapability[] = ["text", "tool_calls", "image"];

export function emptyEndpointInput(): EndpointInput {
  return { name: "", baseUrl: "", model: "", credentialId: "", capabilities: ["text"], requestTimeoutSecs: 60 };
}

export function endpointInputForEdit(endpoint: Endpoint): EndpointInput {
  return { name: endpoint.name, baseUrl: endpoint.baseUrl, model: endpoint.model, credentialId: endpoint.credentialId, capabilities: endpoint.capabilities, requestTimeoutSecs: endpoint.requestTimeoutSecs };
}

export function endpointSummary(endpoints: Endpoint[]): string {
  const missingCredentials = endpoints.filter((endpoint) => !endpoint.hasCredentialRef).length;
  const configured = `${endpoints.length} ${endpoints.length === 1 ? "endpoint" : "endpoints"} configured`;
  return missingCredentials === 0
    ? configured
    : `${configured} · ${missingCredentials} missing ${missingCredentials === 1 ? "credential" : "credentials"}`;
}

export function endpointSupportsTasks(endpoint: Endpoint): boolean {
  return endpoint.capabilities.includes("text") && endpoint.capabilities.includes("tool_calls");
}

export function applyEndpointSave(endpoints: Endpoint[], saved: Endpoint, editing: boolean): Endpoint[] {
  return editing ? endpoints.map((endpoint) => endpoint.id === saved.id ? saved : endpoint) : [...endpoints, saved];
}

export function removeEndpoint(endpoints: Endpoint[], endpointId: string): Endpoint[] {
  return endpoints.filter((endpoint) => endpoint.id !== endpointId);
}
