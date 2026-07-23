import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RuntimeService } from "../../packages/application/src/runtimeService.js";
import type { SandboxReapInput, SandboxReapResult } from "../../packages/application/src/sandboxLifecycleService.js";

describe("runtime service coordination", () => {
  it("ticks immediately, suppresses overlap, and keeps sync and reap failures independent", async () => {
    const callbacks: Array<() => void> = [];
    let syncCalls = 0;
    let reapCalls = 0;
    let releaseFirstSync!: () => void;
    const firstSync = new Promise<void>((resolve) => { releaseFirstSync = resolve; });
    const runtime = new RuntimeService(
      {
        async syncActiveTasksOnce() {
          syncCalls += 1;
          if (syncCalls === 1) await firstSync;
          if (syncCalls === 2) throw new Error("sync unavailable");
          return { activeTaskCount:1, syncedTaskIds:["task_ok"], failedTaskIds:[] };
        }
      },
      {
        async reapSandboxRunsOnce(input:SandboxReapInput) {
          reapCalls += 1;
          if (reapCalls === 1) return emptyReap(input);
          throw new Error("reap unavailable");
        }
      },
      {
        tickIntervalMs:25,
        setInterval(callback,intervalMs) {
          assert.equal(intervalMs,25);
          callbacks.push(callback);
          return "runtime-timer";
        },
        clearInterval() {}
      }
    );

    runtime.startLoop();
    assert.equal(syncCalls,1);
    callbacks[0]?.();
    await flushAsyncWork();
    assert.equal(syncCalls,1);
    assert.equal(reapCalls,0);

    releaseFirstSync();
    await flushAsyncWork();
    assert.equal(reapCalls,1);

    callbacks[0]?.();
    await flushAsyncWork();
    assert.equal(syncCalls,2);
    assert.equal(reapCalls,2);
    const third=await runtime.tickOnce();
    assert.deepEqual(third.taskSync.syncedTaskIds,["task_ok"]);
    assert.deepEqual(third.sandboxReap.errors,["Sandbox reap failed"]);
    runtime.stopLoop();
  });
});

function emptyReap(input:SandboxReapInput):SandboxReapResult {
  return {
    namespace:"agentsmith",
    activeTaskCount:0,
    runCounts:{total:0,starting:0,active:0,releaseRequested:0,failed:0,released:0},
    observedResourceCounts:{},
    cleanupPlan:{targets:[],recentFailures:[]},
    recentCleanupFailures:[],
    actionSummary:[],
    errors:[],
    dryRun:input.apply!==true,
    storedRunIds:[]
  };
}

async function flushAsyncWork():Promise<void> {
  await new Promise<void>((resolve)=>setImmediate(resolve));
}
