import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeProfileDraft,
  encodeProfileDraft,
  profileDraftPatch,
  profileDraftStorageKey,
  rebaseProfileDraft,
  type ProfileDraft
} from "../../src/components/profile/profile-draft-state.js";

const baseline: ProfileDraft = {
  displayName: "Ada",
  timezone: "UTC",
  bio: "Builds systems.",
  jobTitle: "Engineer",
  company: "Analytical Engines",
  greeting: "professional",
  interests: "Math, Engines"
};

test("profile patches contain only semantically changed fields", () => {
  const draft: ProfileDraft = {
    ...baseline,
    displayName: "  Ada Lovelace  ",
    greeting: "unset",
    interests: "Math, Programming"
  };

  assert.deepEqual(profileDraftPatch(baseline, draft, "2026-07-24T10:00:00.000Z"), {
    displayName: "Ada Lovelace",
    greetingPreference: null,
    interests: ["Math", "Programming"],
    expectedUpdatedAt: "2026-07-24T10:00:00.000Z"
  });
  assert.deepEqual(profileDraftPatch(baseline, { ...baseline, displayName: " Ada " }, "version"), {
    expectedUpdatedAt: "version"
  });
});

test("profile three-way rebase adopts untouched remote fields and retains local edits", () => {
  const local = { ...baseline, bio: "Local biography", company: "Local company" };
  const remote = {
    ...baseline,
    timezone: "America/Los_Angeles",
    company: "Remote company",
    jobTitle: "Principal engineer"
  };

  const rebased = rebaseProfileDraft(baseline, local, remote);

  assert.deepEqual(rebased.draft, {
    ...remote,
    bio: "Local biography",
    company: "Local company"
  });
  assert.deepEqual(rebased.conflicts, ["Company"]);
});

test("profile rebase does not report a conflict when both sides reached the same value", () => {
  const local = { ...baseline, timezone: "Europe/London" };
  const remote = { ...baseline, timezone: "Europe/London" };
  assert.deepEqual(rebaseProfileDraft(baseline, local, remote), {
    draft: remote,
    conflicts: []
  });
});

test("profile draft codec is narrow and scoped to actor and resource", () => {
  const encoded = encodeProfileDraft({
    actorId: "user_1",
    resourceId: "profile",
    baseline,
    draft: { ...baseline, bio: "Unsaved" }
  });

  assert.equal(profileDraftStorageKey("user_1"), "agentsmith:profile-draft:user_1");
  assert.deepEqual(
    decodeProfileDraft(encoded, { actorId: "user_1", resourceId: "profile" }),
    { baseline, draft: { ...baseline, bio: "Unsaved" } }
  );
  assert.equal(decodeProfileDraft(encoded, { actorId: "user_2", resourceId: "profile" }), null);
  assert.equal(decodeProfileDraft(encoded, { actorId: "user_1", resourceId: "other" }), null);
  assert.equal(decodeProfileDraft("{", { actorId: "user_1", resourceId: "profile" }), null);
  assert.equal(
    decodeProfileDraft(
      JSON.stringify({ version: 1, actorId: "user_1", resourceId: "profile", baseline, draft: { ...baseline, greeting: "chatty" } }),
      { actorId: "user_1", resourceId: "profile" }
    ),
    null
  );
  assert.equal(
    decodeProfileDraft(
      JSON.stringify({ version: 1, actorId: "user_1", resourceId: "profile", baseline, draft: { ...baseline, bio: "x".repeat(1_001) } }),
      { actorId: "user_1", resourceId: "profile" }
    ),
    null
  );
});
