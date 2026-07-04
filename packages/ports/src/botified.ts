export interface BotifiedRuntimeHttpClient {
  health(baseUrl: string, serviceKey: string): Promise<{ status: "ok" }>;
  postMessage(baseUrl: string, serviceKey: string, message: string): Promise<{ accepted: boolean; cursor?: string }>;
  readTimeline(baseUrl: string, serviceKey: string, cursor?: string): Promise<unknown[]>;
  abort(baseUrl: string, serviceKey: string): Promise<{ aborted: boolean }>;
}

export class DryRunBotifiedRuntimeHttpClient implements BotifiedRuntimeHttpClient {
  async health(): Promise<{ status: "ok" }> {
    return { status: "ok" };
  }

  async postMessage(): Promise<{ accepted: boolean; cursor?: string }> {
    return { accepted: true, cursor: "dry-run" };
  }

  async readTimeline(): Promise<unknown[]> {
    return [];
  }

  async abort(): Promise<{ aborted: boolean }> {
    return { aborted: true };
  }
}

