import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeSettingsDraft,
  encodeSettingsDraft,
  rebaseSettingsDraft,
  resolveSettingsDraftSnapshot,
  settingsDraftStorageKey,
  settingsDraftUpdateInput
} from "../../src/components/settings/settings-draft-state.ts";

test("settings refresh advances the baseline without replacing a local name", () => {
  const rebased = rebaseSettingsDraft("Workspace", "Local workspace", "Remote workspace");
  assert.deepEqual(rebased, {
    baselineName: "Remote workspace",
    draftName: "Local workspace",
    conflicted: true
  });
  assert.deepEqual(settingsDraftUpdateInput(rebased.baselineName, rebased.draftName), {
    name: "Local workspace",
    expectedName: "Remote workspace"
  });
  assert.deepEqual(rebaseSettingsDraft("Workspace", "Workspace", "Remote workspace"), {
    baselineName: "Remote workspace",
    draftName: "Remote workspace",
    conflicted: false
  });
});

test("settings snapshots consume the full rebase result for restore, refresh, and conflict reload", () => {
  const stored = { baselineName: "Workspace", draftName: "Saved workspace" };
  assert.deepEqual(resolveSettingsDraftSnapshot("Remote workspace", stored), {
    baselineName: "Remote workspace",
    draftName: "Saved workspace",
    conflicted: true
  });

  const current = { baselineName: "Remote workspace", draftName: "Local workspace" };
  assert.deepEqual(resolveSettingsDraftSnapshot("New remote workspace", current), {
    baselineName: "New remote workspace",
    draftName: "Local workspace",
    conflicted: true
  });

  assert.deepEqual(resolveSettingsDraftSnapshot("Latest workspace"), {
    baselineName: "Latest workspace",
    draftName: "Latest workspace",
    conflicted: false
  });
});

test("settings draft codec is narrow and scoped to actor, kind, and resource", () => {
  const encoded = encodeSettingsDraft({
    actorId: "user_1",
    resourceKind: "workspace",
    resourceId: "workspace_1",
    baselineName: "Workspace",
    name: "Unsaved workspace"
  });

  assert.equal(
    settingsDraftStorageKey("user_1", "workspace", "workspace_1"),
    "agentsmith:settings-draft:user_1:workspace:workspace_1"
  );
  assert.deepEqual(
    decodeSettingsDraft(encoded, {
      actorId: "user_1",
      resourceKind: "workspace",
      resourceId: "workspace_1"
    }),
    { baselineName: "Workspace", name: "Unsaved workspace" }
  );
  assert.equal(
    decodeSettingsDraft(encoded, {
      actorId: "user_2",
      resourceKind: "workspace",
      resourceId: "workspace_1"
    }),
    null
  );
  assert.equal(
    decodeSettingsDraft(encoded, {
      actorId: "user_1",
      resourceKind: "project",
      resourceId: "workspace_1"
    }),
    null
  );
  assert.equal(
    decodeSettingsDraft(encoded, {
      actorId: "user_1",
      resourceKind: "workspace",
      resourceId: "workspace_2"
    }),
    null
  );
  assert.equal(
    decodeSettingsDraft(
      JSON.stringify({
        version: 1,
        actorId: "user_1",
        resourceKind: "workspace",
        resourceId: "workspace_1",
        baselineName: "Workspace",
        name: 42
      }),
      { actorId: "user_1", resourceKind: "workspace", resourceId: "workspace_1" }
    ),
    null
  );
  assert.equal(
    decodeSettingsDraft("{", {
      actorId: "user_1",
      resourceKind: "workspace",
      resourceId: "workspace_1"
    }),
    null
  );
});
