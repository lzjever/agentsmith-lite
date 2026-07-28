import type { KubernetesResource } from "../../contracts/src/api.js";
import { ProductError } from "../../domain/src/errors.js";
import type {
  PersistedSandboxRunState,
  ProductStore
} from "../../ports/src/store.js";
import {
  type KubernetesResourceRef,
  type SandboxKubernetesInspectionPort,
  type SandboxKubernetesMutationPort
} from "../../sandbox-controller/src/kubernetesPort.js";
import {
  reconcileSandboxRuns,
  sandboxIdentityLabels,
  sandboxRunCoreResourceRefs,
  type SandboxCoreResourceKind,
  type SandboxReconcileAction,
  type SandboxRunState
} from "../../sandbox-controller/src/reconciler.js";
import { SANDBOX_LABEL_KEYS } from "../../sandbox-controller/src/labels.js";
import { emitProjectAlert, evaluateProjectAlertRules, recoverProjectAlerts } from "./projectAlertEvaluator.js";

export interface SandboxKubernetesInventoryPort {
  listManagedResources(namespace: string): Promise<KubernetesResource[]>;
}

export type SandboxLifecycleKubernetesPort =
  & SandboxKubernetesMutationPort
  & SandboxKubernetesInspectionPort
  & SandboxKubernetesInventoryPort;

export interface SandboxLifecycleServiceConfig {
  namespace: string;
  port?: SandboxLifecycleKubernetesPort;
  now?: () => Date;
  hasLocalStartupOperation?: (runId:string)=>boolean;
}

export interface SandboxLifecycleScope {
  runId?: string;
}

export interface SandboxLifecycleActionSummary {
  type: SandboxReconcileAction["type"];
  runId?: string;
  kind?: string;
  name?: string;
  reason?: string;
}

export type SandboxCleanupPlanTarget =
  | {
      type: "delete_resource";
      source: "kubernetes";
      runId: string;
      kind: string;
      name: string;
    }
  | {
      type: "store_run_state";
      source: "store";
      runId: string;
      reason: string;
      state: PersistedSandboxRunState["state"];
    };

export interface SandboxRecentCleanupFailure {
  runId: string;
  at: string;
  target: string;
  message: string;
}

export interface SandboxCleanupPlan {
  targets: SandboxCleanupPlanTarget[];
  recentFailures: SandboxRecentCleanupFailure[];
}

export interface SandboxLifecycleRunCounts {
  total: number;
  starting: number;
  active: number;
  releaseRequested: number;
  failed: number;
  released: number;
}

export interface SandboxStatusResult {
  namespace: string;
  activeTaskCount: number;
  runCounts: SandboxLifecycleRunCounts;
  observedResourceCounts: Record<string, number>;
  cleanupPlan: SandboxCleanupPlan;
  recentCleanupFailures: SandboxRecentCleanupFailure[];
  actionSummary: SandboxLifecycleActionSummary[];
  errors: string[];
}

export interface SandboxReapInput extends SandboxLifecycleScope {
  dryRun?: boolean;
  apply?: boolean;
}

export interface SandboxReapResult extends SandboxStatusResult {
  dryRun: boolean;
  storedRunIds: string[];
}

export class SandboxLifecycleService {
  constructor(
    private readonly store: ProductStore,
    private readonly config: SandboxLifecycleServiceConfig
  ) {}

  async getSandboxStatus(scope: SandboxLifecycleScope = {}): Promise<SandboxStatusResult> {
    const runs = await this.loadRuns(scope);
    const activeTaskCount = await this.activeTaskCount(scope);
    const observed = await this.observe(scope);
    const plan = this.plan(runs.activeRuns, observed.resources, runs.allRuns, !scope.runId);
    const cleanupPlan = this.cleanupPlan(plan.actions, runs.allRuns);
    return {
      namespace: this.config.namespace,
      activeTaskCount,
      runCounts: runCounts(runs.allRuns),
      observedResourceCounts: resourceCounts(observed.resources),
      cleanupPlan,
      recentCleanupFailures: cleanupPlan.recentFailures,
      actionSummary: plan.actions.map(actionSummary),
      errors: [...observed.errors, ...plan.errors]
    };
  }

  async reapSandboxRunsOnce(input: SandboxReapInput = {}): Promise<SandboxReapResult> {
    const dryRun = input.apply === true && input.dryRun !== true ? false : true;
    const runs = await this.loadRuns(input);
    const startupDrainRunIds=new Set(runs.activeRuns.filter((run)=>this.startupActionDrainEligible(run,(this.config.now?.()??new Date()).toISOString())).map((run)=>run.runId));
    const activeTaskCount = await this.activeTaskCount(input);
    const observed = await this.observe(input);
    const plan = this.plan(runs.activeRuns, observed.resources, runs.allRuns, !input.runId);
    const cleanupPlan = this.cleanupPlan(plan.actions, runs.allRuns);
    const result: SandboxReapResult = {
      namespace: this.config.namespace,
      activeTaskCount,
      runCounts: runCounts(runs.allRuns),
      observedResourceCounts: resourceCounts(observed.resources),
      cleanupPlan,
      recentCleanupFailures: cleanupPlan.recentFailures,
      actionSummary: plan.actions.map(actionSummary),
      errors: [...observed.errors, ...plan.errors],
      dryRun,
      storedRunIds: []
    };

    if (observed.errors.length > 0 && !dryRun) {
      await this.persistCleanupObservationFailure(runs.activeRuns, observed.errors[0]!);
    }
    if (dryRun || observed.errors.length > 0) {
      return result;
    }
    if (!this.config.port) {
      throw new ProductError("Sandbox lifecycle Kubernetes port is not configured", 409);
    }

    const blockedRunIds = new Set<string>();
    const terminalFailureTransitions = await this.persistTerminalFailureTransitions(plan.actions, result);
    result.errors.push(...terminalFailureTransitions.errors);
    for (const runId of terminalFailureTransitions.blockedRunIds) blockedRunIds.add(runId);

    const preparedRuns = await this.loadRuns(input);
    const cleanupReconcilePlan = this.plan(
      preparedRuns.activeRuns,
      observed.resources,
      preparedRuns.allRuns,
      !input.runId
    );
    result.cleanupPlan = this.cleanupPlan(cleanupReconcilePlan.actions, preparedRuns.allRuns);
    result.recentCleanupFailures = result.cleanupPlan.recentFailures;
    if (plan.actions.some((action) => action.type === "store_run_state" && action.reason === "terminal_runner_failure")) {
      result.actionSummary.push(...cleanupReconcilePlan.actions.map(actionSummary));
    }
    const lifecycleCandidates = cleanupReconcilePlan.actions.filter((action) => !blockedRunIds.has(reconcileActionRunId(action)));
    const inventoryFenceFailures=await this.validateInventoryPodFences(
      lifecycleCandidates,
      preparedRuns.allRuns,
      observed.resources
    );
    for(const [runId,failure] of inventoryFenceFailures){
      blockedRunIds.add(runId);
      result.errors.push(failure.message);
    }
    const fencedLifecycleCandidates=lifecycleCandidates.filter((action)=>!blockedRunIds.has(reconcileActionRunId(action)));
    const cleanupClaims = await this.claimRunsBeforeDestructiveCleanup(fencedLifecycleCandidates, preparedRuns.allRuns);
    for (const runId of cleanupClaims.rejectedRunIds) blockedRunIds.add(runId);
    const claimedOrOrphanActions = lifecycleCandidates.filter((action) =>
      cleanupClaims.claimedRuns.has(reconcileActionRunId(action)) || cleanupClaims.orphanRunIds.has(reconcileActionRunId(action))
    );
    let cleanupActions = claimedOrOrphanActions.filter((action) => !blockedRunIds.has(reconcileActionRunId(action)));
    cleanupActions = await this.deferNewlyPersistedOrphanActions(cleanupActions, cleanupClaims.orphanRunIds);
    const mutations = await this.applyCleanupActions(this.config.port, cleanupActions);
    for(const [runId,failure] of mutations.failures){
      if(cleanupClaims.orphanRunIds.has(runId))result.errors.push(failure.message);
    }
    const cleanupFailures=new Map<string,CleanupFailure>();
    for(const [runId,claimed] of cleanupClaims.claimedRuns){
      const inspection=await this.inspectRunResources(this.config.port,claimed);
      if(inspection.failure){
        blockedRunIds.add(runId);
        cleanupFailures.set(runId,inspection.failure);
        result.errors.push(inspection.failure.message);
        continue;
      }
      const mutationFailure=mutations.failures.get(runId);
      if(mutationFailure&&!deleteFailureResolved(mutationFailure,inspection.resources)){
        blockedRunIds.add(runId);
        cleanupFailures.set(runId,mutationFailure);
        result.errors.push(mutationFailure.message);
        continue;
      }
      const current=await this.store.sandboxRuns.get(runId);
      if(!current||current.fencingToken!==claimed.fencingToken){
        blockedRunIds.add(runId);
        cleanupFailures.set(runId,{target:"Sandbox Run",message:`Sandbox run ${runId} fencing token changed during cleanup`});
        result.errors.push(`Sandbox run ${runId} fencing token changed during cleanup`);
        continue;
      }
      const exactPlan=this.plan(
        [current as PersistedSandboxRunState & SandboxRunState],
        inspection.resources,
        [current],
        false
      );
      result.actionSummary.push(...exactPlan.actions.map(actionSummary));
      const action=exactPlan.actions.find((candidate)=>
        candidate.type==="store_run_state"&&
        (candidate.reason==="cleanup_complete"||candidate.reason==="cleanup_in_progress")
      );
      if (!action || action.type !== "store_run_state") {
        blockedRunIds.add(runId);
        cleanupFailures.set(runId,{target:"Sandbox reconciliation",message:`Sandbox run ${runId} produced no cleanup state`});
        result.errors.push(`Sandbox run ${runId} produced no cleanup state`);
        continue;
      }
      if (action.reason === "cleanup_complete") {
        if(startupDrainRunIds.has(action.run.runId)){
          const current=await this.store.sandboxRuns.get(action.run.runId);
          const drainedAt=(this.config.now?.()??new Date()).toISOString();
          const drained=current?.startupClaimToken&&current.startupActionDeadlineAt
            ?await this.store.drainSandboxStartupAction({
                taskId:current.taskId,runId:current.runId,expectedFencingToken:current.fencingToken,
                claimToken:current.startupClaimToken,actionDeadlineAt:current.startupActionDeadlineAt,
                drainedAt,
                failureCode:"startup_failed",
                failureMessage:"Sandbox startup mutation result remained unknown after its deadline and cleanup.",
                auditEvent:{
                  id:`audit_sandbox_failed_startup_drain_${current.runId}`,projectId:current.projectId,
                  actorId:null,subjectUserId:current.startedByUserId,action:"sandbox.failed",status:"accepted",
                  resourceKind:"sandbox",resourceId:current.taskId,
                  detail:{taskId:current.taskId,runId:current.runId},createdAt:drainedAt
                }
              })
            :null;
          if(drained)result.storedRunIds.push(drained.runId);
          else await this.resolveCleanupCasConflict(
            current??claimed,
            {
              target:"Sandbox startup drain",
              message:`Sandbox run ${action.run.runId} startup deadline changed before drain could complete`
            },
            result
          );
          continue;
        }
        const transition = await this.completeReleasedRun(action.run);
        if (transition) {
          result.storedRunIds.push(transition.stored.runId);
        } else {
          await this.resolveCleanupCasConflict(
            current,
            {
              target:"Sandbox release settlement",
              message:`Sandbox run ${action.run.runId} fencing token changed before state could be stored`
            },
            result
          );
        }
        continue;
      }
      const transition = await this.clearSuccessfulCleanupClaim(current);
      if (transition) {
        result.storedRunIds.push(transition.stored.runId);
      } else {
        await this.resolveCleanupCasConflict(
          current,
          {
            target:"Sandbox cleanup claim",
            message:`Sandbox run ${action.run.runId} fencing token changed before state could be stored`
          },
          result
        );
      }
    }
    await this.releaseBlockedCleanupClaims(cleanupClaims.claimedRuns, blockedRunIds, cleanupFailures);
    const afterRuns = await this.loadRuns(input);
    result.runCounts = runCounts(afterRuns.allRuns);
    const afterPlan = this.plan(afterRuns.activeRuns, observed.resources, afterRuns.allRuns, !input.runId);
    result.cleanupPlan = this.cleanupPlan(afterPlan.actions, afterRuns.allRuns);
    result.recentCleanupFailures = result.cleanupPlan.recentFailures;
    return result;
  }

  private async activeTaskCount(scope: SandboxLifecycleScope): Promise<number> {
    const tasks = await this.store.listActiveTasks();
    if (!scope.runId) {
      return tasks.length;
    }
    return tasks.filter((task) => task.currentRunId === scope.runId).length;
  }

  private async loadRuns(scope: SandboxLifecycleScope): Promise<{
    allRuns: PersistedSandboxRunState[];
    activeRuns: Array<PersistedSandboxRunState & SandboxRunState>;
  }> {
    if (scope.runId) {
      const run = await this.store.sandboxRuns.get(scope.runId);
      const allRuns = run ? [run] : [];
      return {
        allRuns,
        activeRuns: allRuns.filter(isActiveRun) as Array<PersistedSandboxRunState & SandboxRunState>
      };
    }
    const allRuns = await this.store.sandboxRuns.list();
    return {
      allRuns,
      activeRuns: allRuns.filter(isActiveRun) as Array<PersistedSandboxRunState & SandboxRunState>
    };
  }

  private async observe(scope: SandboxLifecycleScope = {}): Promise<{ resources: KubernetesResource[]; errors: string[] }> {
    if (!this.config.port) {
      return { resources: [], errors: [] };
    }
    try {
      const resources = await this.config.port.listManagedResources(this.config.namespace);
      return { resources: filterObservedResourcesForScope(resources, scope), errors: [] };
    } catch (error) {
      return { resources: [], errors: [errorMessage(error)] };
    }
  }

  private plan(
    runs: Array<PersistedSandboxRunState & SandboxRunState>,
    observedResources: KubernetesResource[],
    allRuns: PersistedSandboxRunState[],
    includeOrphanCleanup: boolean
  ): { actions: SandboxReconcileAction[]; errors: string[] } {
    const now=this.config.now?.()??new Date();
    const plannedRuns=runs.map((run)=>this.startupActionDrainEligible(run,now.toISOString())
      ?{...run,state:"release_requested" as const,releaseReason:"failed" as const,releaseRequestedAt:run.startupActionDeadlineAt}
      :run);
    return reconcileSandboxRuns({
      namespace: this.config.namespace,
      desiredRuns: plannedRuns,
      ...(includeOrphanCleanup ? { persistedRunIds: allRuns.map((run) => run.runId) } : {}),
      observedResources,
      now
    });
  }

  private startupActionDrainEligible(run:PersistedSandboxRunState,now:string):boolean{
    return !this.config.hasLocalStartupOperation?.(run.runId)&&startupActionDrainEligible(run,now);
  }

  private cleanupPlan(
    actions: SandboxReconcileAction[],
    allRuns: PersistedSandboxRunState[]
  ): SandboxCleanupPlan {
    const targets: SandboxCleanupPlanTarget[] = actions.flatMap((action) => cleanupTargetsForAction(action));
    return {
      targets,
      recentFailures: recentCleanupFailures(allRuns)
    };
  }

  private async applyCleanupActions(
    port: SandboxLifecycleKubernetesPort,
    actions: SandboxReconcileAction[]
  ): Promise<{ failures:Map<string,CleanupFailure> }> {
    const blockedRunIds = new Set<string>();
    const failures=new Map<string,CleanupFailure>();
    for (const action of actions) {
      if (action.type === "delete_resource") {
        if (blockedRunIds.has(action.runId)) continue;
        let ref: KubernetesResourceRef;
        try {
          ref = resourceRef(action.resource);
        } catch (error) {
          blockedRunIds.add(action.runId);
          const message=sanitizeCleanupError(errorMessage(error));failures.set(action.runId,{target:`${action.kind}/${action.name}`,message,action});
          continue;
        }
        try {
          const result = await port.deleteResource(ref, action.labels);
          if (result !== "fence_mismatch") {
            continue;
          }
          blockedRunIds.add(action.runId);
          const message=`Kubernetes delete fence mismatch for ${action.kind}/${action.name}`;failures.set(action.runId,{target:`${action.kind}/${action.name}`,message,action});
        } catch (error) {
          blockedRunIds.add(action.runId);
          const message=sanitizeCleanupError(errorMessage(error));failures.set(action.runId,{target:`${action.kind}/${action.name}`,message,action});
        }
      }
    }
    return { failures };
  }

  private async inspectRunResources(
    port:SandboxLifecycleKubernetesPort,
    run:PersistedSandboxRunState
  ):Promise<{resources:KubernetesResource[];failure:CleanupFailure|null}>{
    const resources:KubernetesResource[]=[];
    let failure:CleanupFailure|null=null;
    const labels=sandboxIdentityLabels(run);
    for(const ref of sandboxRunCoreResourceRefs(run)){
      try{
        const inspected=await port.inspectResource(ref,labels);
        if(inspected==="fence_mismatch"){
          failure??={target:`${ref.kind}/${ref.name}`,message:`Kubernetes inspect fence mismatch for ${ref.kind}/${ref.name}`};
        }else if(inspected!=="not_found"){
          resources.push(inspected.resource);
        }
      }catch(error){
        failure??={target:`${ref.kind}/${ref.name}`,message:sanitizeCleanupError(errorMessage(error))};
      }
    }
    return{resources,failure};
  }

  private async validateInventoryPodFences(
    actions:SandboxReconcileAction[],
    runs:PersistedSandboxRunState[],
    observedResources:KubernetesResource[]
  ):Promise<Map<string,CleanupFailure>>{
    const failures=new Map<string,CleanupFailure>();
    const runsById=new Map(runs.map((run)=>[run.runId,run]));
    for(const runId of cleanupActionRunIds(actions)){
      const run=runsById.get(runId);
      if(!run)continue;
      const pod=observedResources.find((resource)=>
        resource.kind==="Pod"&&
        resource.metadata.namespace===run.namespace&&
        resource.metadata.name===run.resourceNames.pod
      );
      if(!pod)continue;
      const expectedLabels=sandboxIdentityLabels(run);
      const uid=typeof pod.metadata.uid==="string"&&pod.metadata.uid.length>0?pod.metadata.uid:null;
      if(
        Object.entries(expectedLabels).some(([key,value])=>pod.metadata.labels[key]!==value)||
        !uid||
        run.startupPodUid!==null&&run.startupPodUid!==undefined&&uid!==run.startupPodUid
      ){
        const failure={
          target:`Pod/${run.resourceNames.pod}`,
          message:`Sandbox run ${runId} Pod UID fence mismatch before cleanup`
        };
        failures.set(runId,failure);
        await this.persistUnclaimedCleanupFailure(run,failure);
      }
    }
    return failures;
  }

  private async persistUnclaimedCleanupFailure(
    run:PersistedSandboxRunState,
    failure:CleanupFailure
  ):Promise<void>{
    const updatedAt=(this.config.now?.()??new Date()).toISOString();
    await this.store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,{
      ...run,
      cleanupClaimedAt:null,
      lastCleanupAt:updatedAt,
      lastCleanupError:{
        at:updatedAt,
        target:failure.target,
        message:sanitizeCleanupError(failure.message)
      },
      fencingToken:run.fencingToken+1,
      updatedAt
    });
  }

  private async resolveCleanupCasConflict(
    claimed:PersistedSandboxRunState,
    failure:CleanupFailure,
    result:SandboxReapResult
  ):Promise<void>{
    const current=await this.store.sandboxRuns.get(claimed.runId);
    if(!current||current.cleanupClaimedAt===null||current.fencingToken!==claimed.fencingToken)return;
    const claimedRuns=new Map([[current.runId,current]]);
    const failures=new Map([[current.runId,failure]]);
    await this.releaseBlockedCleanupClaims(claimedRuns,new Set([current.runId]),failures);
    const after=await this.store.sandboxRuns.get(current.runId);
    if(!after||after.cleanupClaimedAt===null||after.fencingToken!==current.fencingToken){
      result.errors.push(failure.message);
      return;
    }
    result.errors.push(`${failure.message}; cleanup claim could not be cleared`);
  }

  private async deferNewlyPersistedOrphanActions(
    actions: SandboxReconcileAction[],
    orphanRunIds: ReadonlySet<string>
  ): Promise<SandboxReconcileAction[]> {
    const newlyPersistedRunIds = new Set<string>();
    for (const runId of orphanRunIds) {
      if (await this.store.sandboxRuns.get(runId)) {
        newlyPersistedRunIds.add(runId);
      }
    }
    return actions.filter((action) => !newlyPersistedRunIds.has(reconcileActionRunId(action)));
  }

  private async claimRunsBeforeDestructiveCleanup(
    actions: SandboxReconcileAction[],
    runs: PersistedSandboxRunState[]
  ): Promise<{
    claimedRuns: Map<string, PersistedSandboxRunState>;
    rejectedRunIds: Set<string>;
    orphanRunIds: Set<string>;
  }> {
    const claimedRuns = new Map<string, PersistedSandboxRunState>();
    const rejectedRunIds = new Set<string>();
    const runsById = new Map(runs.map((run) => [run.runId, run]));
    const candidateRunIds = cleanupActionRunIds(actions);
    const orphanRunIds = new Set([...candidateRunIds].filter((runId) => !runsById.has(runId)));
    const claimedAt = (this.config.now?.() ?? new Date()).toISOString();
    for (const runId of candidateRunIds) {
      const run = runsById.get(runId);
      if (!run) continue;
      if(this.config.hasLocalStartupOperation?.(runId)){
        rejectedRunIds.add(runId);
        continue;
      }
      const claimed = await this.store.sandboxRuns.claimForCleanup({
        runId,
        expectedFencingToken: run.fencingToken,
        claimedAt
      });
      if (claimed) claimedRuns.set(runId, claimed);
      else rejectedRunIds.add(runId);
    }
    return { claimedRuns, rejectedRunIds, orphanRunIds };
  }

  private async releaseBlockedCleanupClaims(
    claimedRuns: Map<string, PersistedSandboxRunState>,
    blockedRunIds: Set<string>,
    failures:Map<string,CleanupFailure>
  ): Promise<void> {
    const updatedAt = (this.config.now?.() ?? new Date()).toISOString();
    for (const runId of blockedRunIds) {
      const claimed = claimedRuns.get(runId);
      if (!claimed) continue;
      const failure=failures.get(runId)??{target:"Kubernetes cleanup",message:"Sandbox cleanup could not be completed"};
      await this.store.sandboxRuns.updateWithFencing(runId, claimed.fencingToken, {
        ...claimed,
        cleanupClaimedAt: null,
        lastCleanupAt:updatedAt,
        lastCleanupError:{at:updatedAt,target:failure.target,message:sanitizeCleanupError(failure.message)},
        fencingToken: claimed.fencingToken + 1,
        updatedAt
      });
    }
  }

  private async persistCleanupObservationFailure(runs:PersistedSandboxRunState[],message:string):Promise<void>{
    const updatedAt=(this.config.now?.()??new Date()).toISOString();
    for(const run of runs){
      if(run.state!=="release_requested"&&run.state!=="failed")continue;
      await this.store.sandboxRuns.updateWithFencing(run.runId,run.fencingToken,{
        ...run,
        cleanupClaimedAt:null,
        lastCleanupAt:updatedAt,
        lastCleanupError:{at:updatedAt,target:"Kubernetes inventory",message:sanitizeCleanupError(message)},
        fencingToken:run.fencingToken+1,
        updatedAt
      });
    }
  }

  private async clearSuccessfulCleanupClaim(current:PersistedSandboxRunState): Promise<{
    previous: PersistedSandboxRunState;
    stored: PersistedSandboxRunState;
  } | null> {
    const now = (this.config.now?.() ?? new Date()).toISOString();
    const stored = await this.store.sandboxRuns.updateWithFencing(current.runId, current.fencingToken, {
      ...current,
      cleanupClaimedAt:null,
      lastCleanupAt:now,
      lastCleanupError:null,
      fencingToken: current.fencingToken + 1,
      updatedAt: now
    });
    return stored ? { previous: current, stored } : null;
  }

  private async completeReleasedRun(run:SandboxRunState):Promise<{previous:PersistedSandboxRunState;stored:PersistedSandboxRunState}|null>{
    const current=await this.store.sandboxRuns.get(run.runId);if(!current)return null;
    const releasedAt=(this.config.now?.()??new Date()).toISOString();
    const stored={...(run as PersistedSandboxRunState),state:"released" as const,releaseReason:releaseReason(current),releasedAt,startupClaimToken:null,startupLeaseExpiresAt:null,startupActionDeadlineAt:null,cleanupClaimedAt:null,lastCleanupAt:releasedAt,lastCleanupError:null,fencingToken:current.fencingToken+1,updatedAt:releasedAt};
    const startedAt=current.startedAt;
    const durationSeconds=startedAt===null?0:Math.max(0,(Date.parse(releasedAt)-Date.parse(startedAt))/1000);
    const settlement={runId:current.runId,workspaceId:current.workspaceId,projectId:current.projectId,taskId:current.taskId,fileLibraryId:current.fileLibraryId,startedByUserId:current.startedByUserId,startedAt,releasedAt,durationSeconds,resources:structuredClone(current.resourceSnapshot),releaseReason:stored.releaseReason!};
    const result=await this.store.completeSandboxRunRelease({
      runId:current.runId,expectedFencingToken:current.fencingToken,run:stored,settlement,
      auditEvent:{id:`audit_sandbox_released_${current.runId}`,projectId:current.projectId,actorId:null,subjectUserId:current.startedByUserId,action:"sandbox.released",status:"accepted",resourceKind:"sandbox",resourceId:current.taskId,detail:{taskId:current.taskId,runId:current.runId,releaseReason:settlement.releaseReason},createdAt:releasedAt},
      releaseReceipt:{
        responseStatus:200,
        responseBody:{outcome:"completed",keyDisposition:"retire",taskId:current.taskId,runId:current.runId},
        updatedAt:releasedAt
      }
    });
    if(result==="conflict")return null;
    try{
      await evaluateProjectAlertRules(this.store,current.projectId,"sandbox_capacity");
      await recoverProjectAlerts(this.store,current.projectId,"sandbox_capacity",{unconfiguredFallback:true});
      if(stored.releaseReason!=="failed"){
        const endpointId=(await this.store.findTask(current.taskId))?.endpointId;
        await evaluateProjectAlertRules(this.store,current.projectId,"sandbox_failure",endpointId?{endpointId}:{});
        await recoverProjectAlerts(this.store,current.projectId,"sandbox_failure",{...(endpointId?{endpointId}:{}),unconfiguredFallback:true});
      }
    }
    catch(error){console.error(`Sandbox capacity alert refresh failed: ${sanitizeCleanupError(errorMessage(error))}`);}
    return{previous:current,stored:await this.store.sandboxRuns.get(current.runId)??stored};
  }

  private async persistTerminalFailureTransitions(
    actions: SandboxReconcileAction[],
    result: SandboxReapResult
  ): Promise<{ blockedRunIds: Set<string>; errors: string[] }> {
    const blockedRunIds = new Set<string>();
    const errors: string[] = [];
    for (const action of actions) {
      if (action.type !== "store_run_state" || action.reason !== "terminal_runner_failure") {
        continue;
      }
      let transition:Awaited<ReturnType<SandboxLifecycleService["persistTerminalFailureTransition"]>>;
      try{transition=await this.persistTerminalFailureTransition(action.run);}catch(error){blockedRunIds.add(action.run.runId);errors.push(`Sandbox run ${action.run.runId} failure recording failed: ${sanitizeCleanupError(errorMessage(error))}`);continue;}
      if (transition === "conflict") {
        blockedRunIds.add(action.run.runId);
        errors.push(`Sandbox run ${action.run.runId} fencing token changed before terminal failure could be stored`);
        continue;
      }
      if (transition !== "skipped") {
        result.storedRunIds.push(transition.stored.runId);
      }
    }
    return { blockedRunIds, errors };
  }

  private async persistTerminalFailureTransition(
    actionRun: SandboxRunState
  ): Promise<{ previous: PersistedSandboxRunState; stored: PersistedSandboxRunState } | "skipped" | "conflict"> {
    if (!actionRun.terminalFailure && actionRun.failureCode!=="startup_failed") {
      return "skipped";
    }
    const current = await this.store.sandboxRuns.get(actionRun.runId);
    if (!current || !isTerminalFailureEligibleRun(current, actionRun)) return "skipped";
    const now = (this.config.now?.() ?? new Date()).toISOString();
    const task=await this.store.findTask(current.taskId);
    const endpointId=task?.endpointId;
    const stored=await this.store.failSandboxRun({
      runId:current.runId,
      expectedFencingToken:current.fencingToken,
      code:actionRun.failureCode==="startup_failed"?"startup_failed":"runner_failed",
      message:actionRun.failureCause??"The sandbox runtime stopped unexpectedly. Retry release to remove its resources.",
      failedAt:actionRun.failedAt??now,
      ...(actionRun.terminalFailure?{terminalFailure:structuredClone(actionRun.terminalFailure)}:{}),
      auditEvent:{id:`audit_sandbox_failed_${current.runId}`,projectId:current.projectId,actorId:null,subjectUserId:current.startedByUserId,action:"sandbox.failed",status:"accepted",resourceKind:"sandbox",resourceId:current.taskId,detail:{taskId:current.taskId,runId:current.runId,...(endpointId?{endpointId}:{})},createdAt:now}
    });
    if(!stored)return "conflict";
    try{await emitProjectAlert(this.store,current.projectId,"sandbox_failure",endpointId?{endpointId}:{});}
    catch(error){console.error(`Sandbox failure alert refresh failed: ${sanitizeCleanupError(errorMessage(error))}`);}
    return { previous: current, stored };
  }

}

function isActiveRun(run: PersistedSandboxRunState): boolean {
  return run.state !== "released";
}

function isTerminalFailureEligibleRun(run: PersistedSandboxRunState, actionRun: SandboxRunState): boolean {
  return Boolean(actionRun.terminalFailure||actionRun.failureCode==="startup_failed") && (run.state === "starting" || run.state === "active");
}

function releaseReason(run:PersistedSandboxRunState):import("../../contracts/src/api.js").SandboxReleaseReason{return run.releaseReason??(run.state==="failed"?"failed":"cleanup")}
function startupActionDrainEligible(run:PersistedSandboxRunState,now:string):boolean{return run.state==="starting"&&run.startupActionDeadlineAt!==null&&run.startupActionDeadlineAt<=now}

function cleanupTargetsForAction(action: SandboxReconcileAction): SandboxCleanupPlanTarget[] {
  switch (action.type) {
    case "delete_resource":
      return [{
        type: "delete_resource",
        source: "kubernetes",
        runId: action.runId,
        kind: action.kind,
        name: action.name
      }];
    case "store_run_state":
      return [{
        type: "store_run_state",
        source: "store",
        runId: action.run.runId,
        reason: action.reason,
        state: action.run.state
      }];
    case "create_resource":
    case "adopt_resource":
      return [];
  }
}

function reconcileActionRunId(action: SandboxReconcileAction): string {
  return action.type === "store_run_state" ? action.run.runId : action.runId;
}

function cleanupActionRunIds(actions: SandboxReconcileAction[]): Set<string> {
  const runIds = new Set<string>();
  for (const action of actions) {
    if (action.type === "delete_resource") runIds.add(action.runId);
    if (action.type === "store_run_state" && (action.reason === "cleanup_in_progress" || action.reason === "cleanup_complete")) {
      runIds.add(action.run.runId);
    }
  }
  return runIds;
}

function recentCleanupFailures(runs: PersistedSandboxRunState[]): SandboxRecentCleanupFailure[] {
  return runs
    .flatMap((run) => {
      if (!run.lastCleanupError) {
        return [];
      }
      return [{
        runId: run.runId,
        at: run.lastCleanupError.at,
        target: run.lastCleanupError.target,
        message: sanitizeCleanupError(run.lastCleanupError.message)
      }];
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, 10);
}

function sanitizeCleanupError(message: string): string {
  return message
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(
      /\b([A-Za-z0-9_-]*?(?:API[-_]?KEY|TOKEN|PASSWORD|PASSWD|SECRET))\s*(?:=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=<redacted>"
    )
    .replace(/\bbsk_[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/\blbk_[A-Za-z0-9_-]+/g, "<redacted>")
    .replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]*/g, "<redacted>")
    .replace(/\bMODEL_API_KEY\b(?!\s*(?:=|:))/g, "<redacted>")
    .slice(0, 300);
}

function runCounts(runs: PersistedSandboxRunState[]): SandboxLifecycleRunCounts {
  return {
    total: runs.length,
    starting: runs.filter((run) => run.state === "starting").length,
    active: runs.filter((run) => run.state === "active").length,
    releaseRequested: runs.filter((run) => run.state === "release_requested").length,
    failed: runs.filter((run) => run.state === "failed").length,
    released: runs.filter((run) => run.state === "released").length
  };
}

function resourceCounts(resources: KubernetesResource[]): Record<string, number> {
  const counts: Record<string, number> = {
    Secret: 0,
    ConfigMap: 0,
    ServiceAccount: 0,
    NetworkPolicy: 0,
    Service: 0,
    Pod: 0
  };
  for (const resource of resources) {
    counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
  }
  return counts;
}

function filterObservedResourcesForScope(
  resources: KubernetesResource[],
  scope: SandboxLifecycleScope
): KubernetesResource[] {
  if (!scope.runId) {
    return resources;
  }
  return resources.filter((resource) => resource.metadata.labels[SANDBOX_LABEL_KEYS.runId] === scope.runId);
}

function hasDeletionTimestamp(resource: KubernetesResource): boolean {
  const value = resource.metadata.deletionTimestamp;
  return typeof value === "string" && value.length > 0;
}

type CleanupFailure={
  target:string;
  message:string;
  action?:Extract<SandboxReconcileAction,{type:"delete_resource"}>;
};

function deleteFailureResolved(failure:CleanupFailure,resources:KubernetesResource[]):boolean{
  const action=failure.action;
  if(!action)return false;
  const matching=resources.find((resource)=>
    resource.kind===action.kind&&
    resource.metadata.namespace===action.resource.metadata.namespace&&
    resource.metadata.name===action.name
  );
  return !matching||hasDeletionTimestamp(matching);
}

function actionSummary(action: SandboxReconcileAction): SandboxLifecycleActionSummary {
  switch (action.type) {
    case "create_resource":
    case "adopt_resource":
    case "delete_resource":
      return {
        type: action.type,
        runId: action.runId,
        kind: action.kind,
        name: action.name
      };
    case "store_run_state":
      return {
        type: action.type,
        runId: action.run.runId,
        reason: action.reason
      };
  }
}

const sandboxCoreKinds: SandboxCoreResourceKind[] = ["Pod", "Service", "Secret", "ConfigMap", "ServiceAccount", "NetworkPolicy"];

function resourceRef(resource: KubernetesResource): KubernetesResourceRef {
  if (!sandboxCoreKinds.includes(resource.kind as SandboxCoreResourceKind)) {
    throw new ProductError(`Sandbox lifecycle resource kind is not supported: ${resource.kind}`, 500);
  }
  if (!resource.metadata.namespace) {
    throw new ProductError(`Sandbox lifecycle resource is missing namespace: ${resource.metadata.name}`, 500);
  }
  return {
    kind: resource.kind as SandboxCoreResourceKind,
    namespace: resource.metadata.namespace,
    name: resource.metadata.name,
    labels: { ...resource.metadata.labels },
    ...(typeof resource.metadata.uid === "string" ? { uid: resource.metadata.uid } : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown sandbox lifecycle error";
}
