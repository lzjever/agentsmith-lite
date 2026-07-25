import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("File Library deletion migration",()=>{
  it("pairs public lifecycle with one deterministic claimed physical operation",async()=>{
    const sql=await readFile("infra/db/migrations/076_file_library_deletion_lifecycle.sql","utf8");

    assert.match(sql,/lifecycle_status text not null default 'active'/);
    assert.match(sql,/lifecycle_status in \('active', 'deleting'\)/);
    assert.match(sql,/deletion_operation_id = 'file-library-delete:' \|\| id/);
    assert.doesNotMatch(sql,/deletion_request_hash/);
    assert.match(sql,/deletion_phase in \('isolated', 'removed'\)/);
    assert.match(sql,/deletion_entry_type in \('file', 'directory', 'symlink', 'unsupported'\)/);
    assert.match(sql,/deletion_claim_token is null\s+and deletion_claim_expires_at is null/);
    assert.match(sql,/deletion_claim_token is not null\s+and deletion_claim_expires_at is not null/);
    assert.match(sql,/create unique index file_libraries_deletion_operation_unique/);
    assert.match(sql,/create index file_libraries_deletion_claim_expiry/);
    assert.match(sql,/drop constraint if exists project_audit_events_action_check/);
    assert.match(sql,/'file\.upload','file\.delete','file_library\.delete','file\.quota'/);
  });
});
