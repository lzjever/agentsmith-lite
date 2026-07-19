import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { apiClient } from "../../src/lib/api/client.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("task creation API client", () => {
  it("sends exactly the create-new File Library union", async () => {
    const request = await createWith({ mode:"create_new", name:"Release workspace" });
    assert.deepEqual(await request.json(), { prompt:"Prepare release", endpointId:"endpoint_1", title:"Release", fileLibrary:{ mode:"create_new", name:"Release workspace" } });
  });

  it("sends exactly the use-existing File Library union", async () => {
    const request = await createWith({ mode:"use_existing", id:"library_1" });
    assert.deepEqual(await request.json(), { prompt:"Prepare release", endpointId:"endpoint_1", title:"Release", fileLibrary:{ mode:"use_existing", id:"library_1" } });
  });
});

async function createWith(fileLibrary: { mode:"create_new"; name:string } | { mode:"use_existing"; id:string }): Promise<Request> {
  const requests: Request[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url, "http://localhost"), init);
    requests.push(request);
    if (request.url.endsWith("/me")) return Response.json({ user:{ id:"user_1",email:"user@example.test" }, csrfToken:"csrf" });
    return Response.json({ id:"task_1" });
  };
  await apiClient.currentIdentity();
  await apiClient.createTask("project_1", { prompt:"Prepare release", endpointId:"endpoint_1", title:"Release", fileLibrary }, "create-key");
  assert.equal(requests[1]?.url, "http://localhost/api/v1/projects/project_1/tasks");
  assert.equal(requests[1]?.headers.get("idempotency-key"), "create-key");
  return requests[1]!;
}
