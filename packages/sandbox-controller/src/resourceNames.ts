import { createHash } from "node:crypto";

const DNS_LABEL_MAX_LENGTH = 63;
const HASH_LENGTH = 8;

export interface SandboxGeneratedResourceNames {
  pod: string;
  service: string;
  configMap: string;
  secret: string;
  serviceAccount: string;
  networkPolicy: string;
}

export function sandboxResourceNamesForTask(taskId: string): SandboxGeneratedResourceNames {
  const taskResourceName = kubernetesResourceName("asl-task", taskId);
  return {
    pod: taskResourceName,
    service: taskResourceName,
    configMap: kubernetesResourceName("asl-task", taskId, "config"),
    secret: kubernetesResourceName("asl-botified", taskId),
    serviceAccount: taskResourceName,
    networkPolicy: taskResourceName
  };
}

export function sandboxServiceNameForTask(taskId: string): string {
  return sandboxResourceNamesForTask(taskId).service;
}

export function kubernetesResourceName(prefix: string, value: string, suffix?: string): string {
  return kubernetesDnsLabelName([prefix, value, suffix].filter((part): part is string => part !== undefined).join("-"));
}

export function kubernetesDnsLabelName(rawName: string): string {
  const sanitized = sanitizeDnsLabel(rawName);
  if (sanitized.length > 0 && sanitized === rawName && sanitized.length <= DNS_LABEL_MAX_LENGTH) {
    return sanitized;
  }

  const hash = shortHash(rawName);
  const readable = sanitized || "x";
  const readableLength = DNS_LABEL_MAX_LENGTH - HASH_LENGTH - 1;
  const truncated = trimDnsLabel(readable.slice(0, readableLength)) || "x";
  return `${truncated}-${hash}`;
}

function sanitizeDnsLabel(value: string): string {
  return trimDnsLabel(value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-"));
}

function trimDnsLabel(value: string): string {
  return value.replace(/^-+|-+$/g, "");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH);
}
