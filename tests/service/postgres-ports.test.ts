import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInMemoryProductStore } from "../../packages/adapters-postgres/src/inMemoryProductStore.js";
import { readPostgresMigrations } from "../../packages/adapters-postgres/src/migrations.js";

describe("postgres adapter ports", () => {
  it("exposes JSONB document and fenced lease semantics without Redis or Mongo", async () => {
    const store = createInMemoryProductStore();

    await store.jsonDocs.put("project_settings", "p1", { concurrency: 2 });
    assert.deepEqual(await store.jsonDocs.get("project_settings", "p1"), { concurrency: 2 });
    assert.equal(await store.jsonDocs.get("project_settings", "missing"), null);

    const acquired = await store.leases.acquire({
      name: "sandbox:t1",
      holder: "api-1",
      ttlMs: 1000,
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    assert.equal(acquired.acquired, true);
    assert.equal(acquired.lease?.fencingToken, 1);

    const stale = await store.leases.compareAndSet("sandbox:t1", 0, { phase: "running" });
    assert.equal(stale, false);
    const current = await store.leases.compareAndSet("sandbox:t1", 1, { phase: "running" });
    assert.equal(current, true);
  });

  it("keeps product schema migrations sourced from SQL files and separate from substrate metadata", async () => {
    const migrations = await readPostgresMigrations();
    const migrationSql = migrations.map((migration) => migration.sql).join("\n");
    assert.deepEqual(migrations.map((migration) => migration.id), [
      "001_initial_product_schema",
      "002_task_artifact_sha256",
      "003_task_event_cursor_uniqueness",
      "004_identity_and_project_memberships",
      "005_remove_global_user_role",
      "006_project_owner_memberships",
      "007_project_resource_policy",
      "008_project_chat_threads",
      "009_phase5_audit_metadata",
      "010_provider_settlements_and_task_finalization_intents",
      "011_provider_settlement_and_finalization_constraints",
      "012_task_execution_mode",
      "013_retained_data_foundation",
      "014_context_scope_foundation",
      "015_notification_alert_rule_constraints",
      "017_chat_task_artifact_metadata",
      "018_context_scope_integrity",
      "019_workspace_project_deletion_lifecycle",
      "020_project_credential_encryption",
      "021_workspace_memberships",
      "022_profile_archive_owner_transfer",
      "023_legacy_endpoint_alias_nullable",
      "024_task_follow_up_linkage",
      "025_project_alert_notifications",
      "026_project_alert_event_history",
      "027_notification_context",
      "028_audit_alert_resource_kind",
      "029_task_terminal_and_delivery_identity",
      "030_task_start_followup_and_delivery_receipts",
      "031_task_artifact_projection_stages",
      "032_task_policy_alert_projections",
      "033_endpoint_health",
      "034_context_versions",
      "038_project_chat_retained_actions",
      "039_policy_alert_audit_completion",
      "040_chat_response_recovery",
      "041_retained_resource_audit",
      "042_provider_settlement_project_scope",
      "043_profile_picture_and_lifecycle_idempotency",
      "044_endpoint_deletion_boundaries",
      "045_project_credential_binding_correctness",
      "046_chat_message_thread_sequence",
      "047_task_interaction_changes",
      "048_task_interaction_source_revision_bigint",
      "049_agent_execution_context",
      "050_task_actor_and_usage_repair"
    ]);
    assert.match(migrationSql, /create table if not exists workspaces/i);
    assert.match(migrationSql, /create table if not exists agent_tasks/i);
    assert.doesNotMatch(migrationSql, /juicefs/i);
    assert.doesNotMatch(migrationSql, /redis/i);
    assert.doesNotMatch(migrationSql, /mongo/i);
  });
});
