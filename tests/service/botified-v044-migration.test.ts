import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

describe("Botified v0.4.44 protocol cleanup migration",()=>{
  it("removes only obsolete message delivery and exact-control storage",async()=>{
    const sql=await readFile("infra/db/migrations/080_botified_v044_protocol_cleanup.sql","utf8");

    assert.match(sql,/delete from task_idempotency_records\s+where operation in \('abort-turn','work-stop'\)/);
    for(const column of [
      "expected_run_id","interaction_id","downstream_command_key","downstream_target_id",
      "delivery_key","request_hash","receipt","timeline_cursor","attempt_count","next_retry_at"
    ]){
      assert.match(sql,new RegExp(`drop column if exists ${column}`));
    }
    assert.match(sql,/where delivery_status='dispatching'/);
    assert.match(sql,/set delivery_status = 'failed'/);
    assert.match(sql,/where delivery_status in \('pending','dispatching'\)/);
    assert.doesNotMatch(sql,/drop column if exists request_hash[\s\S]*task_idempotency_records/);
    assert.doesNotMatch(sql,/update task_messages\s+set delivery_status='pending'/);
  });
});
