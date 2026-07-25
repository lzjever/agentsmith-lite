import {
  type AlertRuleMetric,
  type CreateProjectInput,
  type Project,
  type ProjectAlertType,
  type ProjectResourcePolicy,
  type ProjectResourceUsage,
} from "../../packages/contracts/src/api.js";

function compilePublicSandboxVocabulary(): void {
  const project = null as unknown as Project;
  const policy = null as unknown as ProjectResourcePolicy;
  const usage = null as unknown as ProjectResourceUsage;
  const createInput: CreateProjectInput = { name: "Project", sandboxLimit: 2 };
  const alertType: ProjectAlertType = "sandbox_capacity";
  const alertMetric: AlertRuleMetric = "active_sandboxes";
  void [project.sandboxLimit, policy.sandboxLimit, usage.activeSandboxes, createInput, alertType, alertMetric];

  // @ts-expect-error legacy Project property is not public
  project.taskConcurrencyLimit;
  // @ts-expect-error legacy policy property is not public
  policy.activeTasksLimit;
  // @ts-expect-error legacy usage property is not public
  usage.activeTasks;
  // @ts-expect-error legacy project input is not public
  const legacyCreateInput: CreateProjectInput = { name: "Project", taskConcurrencyLimit: 2 };
  // @ts-expect-error legacy alert type is not public
  const legacyAlertType: ProjectAlertType = "active_tasks_limit";
  // @ts-expect-error legacy alert metric is not public
  const legacyAlertMetric: AlertRuleMetric = "active_tasks";
  void [legacyCreateInput, legacyAlertType, legacyAlertMetric];
}

void compilePublicSandboxVocabulary;
