#!/usr/bin/env node
import { readFile } from "node:fs/promises";

class UsageError extends Error {}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "status") {
    requireOption(args.baseUrl, "--base-url");
    requireOption(args.cookieFile, "--cookie-file");
    const result = await requestJson("GET", sandboxStatusPath(args), args);
    printStatus(result);
  } else if (args.command === "reap") {
    requireOption(args.baseUrl, "--base-url");
    requireOption(args.cookieFile, "--cookie-file");
    requireOption(args.csrfToken, "--csrf-token");
    if (args.dryRun && args.apply) {
      throw new UsageError("--dry-run and --apply cannot be used together");
    }
    const body = {
      ...(args.apply ? { apply: true } : {}),
      ...(args.runId ? { runId: args.runId } : {})
    };
    const result = await requestJson("POST", "/api/operator/sandbox/reap", args, body);
    printReap(result);
  } else {
    throw new UsageError("usage: operator-sandbox.mjs <status|reap> --base-url <url> --cookie-file <file> [--csrf-token <token>] [--dry-run|--apply] [--run-id <id>]");
  }
} catch (error) {
  console.error(error instanceof UsageError ? error.message : `operator sandbox API request failed: ${errorMessage(error)}`);
  process.exit(error instanceof UsageError ? 2 : 1);
}

function parseArgs(argv) {
  const parsed = {
    command: argv[0] ?? ""
  };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base-url") {
      parsed.baseUrl = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--cookie-file") {
      parsed.cookieFile = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--csrf-token") {
      parsed.csrfToken = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--run-id") {
      parsed.runId = requireValue(argv, index, arg);
      index += 1;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--apply") {
      parsed.apply = true;
    } else {
      throw new UsageError(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function requireOption(value, flag) {
  if (!value) {
    throw new UsageError(`${flag} is required`);
  }
}

async function requestJson(method, pathname, args, body) {
  const cookie = await readCookieFile(args.cookieFile);
  const headers = {
    accept: "application/json",
    cookie
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (args.csrfToken) {
    headers["x-csrf-token"] = args.csrfToken;
  }
  const response = await fetch(joinUrl(args.baseUrl, pathname), {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
  if (!response.ok) {
    throw new Error(`${method} ${pathname} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function readCookieFile(cookieFile) {
  const content = await readFile(cookieFile, "utf8");
  const cookies = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("#HttpOnly_")) {
      line = line.slice("#HttpOnly_".length);
    } else if (line.startsWith("#")) {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length >= 7) {
      cookies.push(`${fields[5]}=${fields[6]}`);
      continue;
    }
    cookies.push(line.replace(/^Cookie:\s*/i, ""));
  }
  if (cookies.length === 0) {
    throw new UsageError(`cookie file has no cookies: ${cookieFile}`);
  }
  return cookies.join("; ");
}

function printStatus(result) {
  console.log("Sandbox operator status");
  printCommon(result);
}

function sandboxStatusPath(args) {
  if (!args.runId) {
    return "/api/operator/sandbox/status";
  }
  const query = new URLSearchParams({ runId: args.runId });
  return `/api/operator/sandbox/status?${query.toString()}`;
}

function printReap(result) {
  console.log(result.dryRun ? "Sandbox cleanup dry-run" : "Sandbox cleanup apply");
  console.log(`Dry-run: ${String(result.dryRun)}`);
  printCommon(result);
}

function printCommon(result) {
  console.log(`Namespace: ${result.namespace ?? "unknown"}`);
  console.log(`Active task count: ${numberValue(result.activeTaskCount)}`);
  printCounts("Run counts", result.runCounts);
  printCounts("Observed resource counts", result.observedResourceCounts);
  printTargets(result.cleanupPlan?.targets ?? []);
  printFailures(result.recentCleanupFailures ?? result.cleanupPlan?.recentFailures ?? []);
  printErrors(result.errors ?? []);
}

function printCounts(title, counts) {
  console.log(`${title}:`);
  const entries = Object.entries(counts ?? {}).filter(([, value]) => typeof value === "number");
  if (entries.length === 0) {
    console.log("  none");
    return;
  }
  for (const [key, value] of entries) {
    console.log(`  ${key}: ${value}`);
  }
}

function printTargets(targets) {
  const sandboxTargets = targets.filter((target) => target.source !== "runtime");
  const runtimeTargets = targets.filter((target) => target.type === "runtime_directory");
  console.log("Cleanup targets:");
  if (sandboxTargets.length === 0) {
    console.log("  none");
  } else {
    for (const target of sandboxTargets) {
      console.log(`  - ${formatSandboxTarget(target)}`);
    }
  }
  console.log("Runtime directories:");
  if (runtimeTargets.length === 0) {
    console.log("  none");
  } else {
    for (const target of runtimeTargets) {
      console.log(`  - ${formatRuntimeTarget(target)}`);
    }
  }
}

function formatSandboxTarget(target) {
  if (target.type === "delete_resource") {
    return `would delete ${target.kind}/${target.name} for run ${target.runId}`;
  }
  if (target.type === "mark_cleanup") {
    return `would mark ${target.kind}/${target.name} cleanup pending (${target.reason})`;
  }
  if (target.type === "store_run_state") {
    return `would store run ${target.runId} phase=${target.phase} cleanupStatus=${target.cleanupStatus} (${target.reason})`;
  }
  return `would handle ${target.type}`;
}

function formatRuntimeTarget(target) {
  if (target.action === "retain") {
    return `would retain artifacts for ${target.runId}: ${target.path} (${target.reason})`;
  }
  return `would delete runtime dir ${target.directory} for ${target.runId}: ${target.path} (${target.reason})`;
}

function printFailures(failures) {
  console.log("Recent cleanup failures:");
  if (failures.length === 0) {
    console.log("  none");
    return;
  }
  for (const failure of failures) {
    console.log(`  - ${failure.runId} ${failure.target} at ${failure.at}: ${failure.message}`);
  }
}

function printErrors(errors) {
  if (errors.length === 0) {
    return;
  }
  console.log("Errors:");
  for (const error of errors) {
    console.log(`  - ${error}`);
  }
}

function numberValue(value) {
  return typeof value === "number" ? value : 0;
}

function joinUrl(baseUrl, pathname) {
  const base = new URL(baseUrl);
  const request = new URL(pathname, "http://agentsmith-lite.local");
  const basePath = base.pathname.replace(/\/+$/, "");
  base.pathname = `${basePath}${request.pathname}`;
  base.search = request.search;
  base.hash = "";
  return base.toString();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
