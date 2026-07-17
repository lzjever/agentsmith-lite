import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type Endpoint, type EndpointInput, type ProjectCapabilities } from "../../src/lib/api/client.js";
installDom(); const {act,cleanup,fireEvent,render,screen,waitFor,within}=await import("@testing-library/react"); const {EndpointsPage}=await import("../../src/components/endpoints/EndpointsPage.js"); afterEach(()=>cleanup());
const endpoint:Endpoint={id:"endpoint_1",projectId:"project_1",name:"DeepSeek",protocol:"openai_chat_completions",baseUrl:"https://api.example.test/v1",model:"model",credentialId:"credential_1",capabilities:["text"],requestTimeoutSecs:30,health:{status:"healthy",checkedAt:"2026-07-12T00:00:00.000Z",errorCategory:null},hasCredentialRef:true,taskEligible:true,createdAt:"x",updatedAt:"x"}; const viewer:ProjectCapabilities={canManageEndpoints:false,canManageMembers:false,canManagePolicy:false,canWriteFiles:false,canCreateTasks:false,canCancelTasks:false,canSendChat:false};
describe("endpoint summary",()=>it("shows configured summary and read-only health status",async()=>{const original={endpoints:apiClient.endpoints,credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities};apiClient.endpoints=async()=>[endpoint];apiClient.credentials=async()=>[];apiClient.projectCapabilities=async()=>viewer;try{render(<EndpointsPage projectId="project_1"/>);await screen.findByText(/1 endpoint configured · 1 configured/);assert.ok(screen.getByText("Read-only access."));assert.ok(screen.getAllByText("Healthy").length>0);}finally{apiClient.endpoints=original.endpoints;apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;}}));
describe("endpoint dependencies", () => {
  it("reuses an endpoint creation key after an unknown network result", async () => {
    const original = { endpoints:apiClient.endpoints,credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities,createEndpoint:apiClient.createEndpoint };
    const keys:string[]=[];let attempts=0;
    apiClient.endpoints=async()=>[];apiClient.credentials=async()=>[credential];apiClient.projectCapabilities=async()=>manager;
    apiClient.createEndpoint=(async(_projectId:string,input:EndpointInput,key:string)=>{keys.push(key);if(++attempts===1)throw new Error("connection closed");return{...endpoint,...input};}) as typeof apiClient.createEndpoint;
    try {
      render(<EndpointsPage projectId="project_1" />);
      fireEvent.click((await screen.findAllByRole("button",{name:"Create endpoint"}))[0]!);
      const dialog=await screen.findByRole("dialog",{name:"Create endpoint"});
      fireEvent.change(within(dialog).getByLabelText("Name"),{target:{value:"Provider"}});
      fireEvent.change(within(dialog).getByLabelText("Model"),{target:{value:"model"}});
      fireEvent.change(document.querySelector("select")!,{target:{value:credential.id}});
      fireEvent.click(within(dialog).getByRole("button",{name:"Save"}));
      await waitFor(()=>assert.equal(attempts,1));
      fireEvent.click(within(dialog).getByRole("button",{name:"Save"}));
      await waitFor(()=>assert.equal(attempts,2));
      assert.equal(keys[0],keys[1]);assert.ok(keys[0]);
    } finally { Object.assign(apiClient,original); }
  });

  it("closes project-scoped actions and ignores an old save after switching projects", async () => {
    const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities, updateEndpoint: apiClient.updateEndpoint };
    let finishSave!: (value: Endpoint) => void;
    let saves = 0;
    apiClient.endpoints = async (projectId) => projectId === "project_1" ? [endpoint] : [];
    apiClient.credentials = async (projectId) => [{ ...credential, projectId }];
    apiClient.projectCapabilities = async () => manager;
    apiClient.updateEndpoint = async () => { saves += 1; return new Promise((resolve) => { finishSave = resolve; }); };
    try {
      const view = render(<EndpointsPage projectId="project_1" />);
      fireEvent.click((await screen.findAllByRole("button", { name: "Edit DeepSeek" }))[0]!);
      await screen.findByRole("dialog", { name: "Edit endpoint" });
      const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
      assert.equal(save.disabled, true);
      fireEvent.submit(save.closest("form")!);
      assert.equal(saves, 0);
      fireEvent.change(screen.getByLabelText("Model"), { target: { value: "updated-model" } });
      assert.equal(save.disabled, false);
      fireEvent.click(save);
      await waitFor(() => assert.equal(saves, 1));

      view.rerender(<EndpointsPage projectId="project_2" />);
      await waitFor(() => assert.ok(screen.getByText("No endpoints configured")));
      assert.equal(screen.queryByRole("dialog", { name: "Edit endpoint" }), null);

      await act(async () => finishSave(endpoint));
      assert.ok(screen.getByRole("heading", { name: "No endpoints configured" }));
      assert.equal(screen.queryAllByText("DeepSeek").length, 0);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the newest endpoint, credential, and permission refresh", async () => {
    const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities };
    const latest = { ...endpoint, id: "endpoint_latest", name: "Latest endpoint" };
    let endpointReads = 0; let credentialReads = 0; let capabilityReads = 0;
    let resolveOldEndpoints!: (value: Endpoint[]) => void;
    let resolveOldCredentials!: (value: typeof credential[]) => void;
    let resolveOldCapabilities!: (value: ProjectCapabilities) => void;
    apiClient.endpoints = async () => ++endpointReads === 1 ? new Promise((resolve) => { resolveOldEndpoints = resolve; }) : [latest];
    apiClient.credentials = async () => ++credentialReads === 1 ? new Promise((resolve) => { resolveOldCredentials = resolve; }) : [];
    apiClient.projectCapabilities = async () => ++capabilityReads === 1 ? new Promise((resolve) => { resolveOldCapabilities = resolve; }) : viewer;
    try {
      render(<EndpointsPage projectId="project_1" />);
      await waitFor(() => assert.deepEqual([endpointReads, credentialReads, capabilityReads], [1, 1, 1]));
      fireEvent.click(screen.getByRole("button", { name: "Refresh endpoints" }));
      await screen.findAllByText("Latest endpoint");
      assert.ok(screen.getByText("Read-only access."));
      await act(async () => {
        resolveOldEndpoints([{ ...endpoint, name: "Stale endpoint" }]);
        resolveOldCredentials([credential]);
        resolveOldCapabilities(manager);
        await Promise.resolve();
      });
      assert.equal(screen.queryAllByText("Stale endpoint").length, 0);
      assert.ok(screen.getAllByText("Latest endpoint").length > 0);
      assert.equal(screen.queryByRole("button", { name: "Create endpoint" }), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("guides managers to credentials instead of opening a dead create form", async () => {
    const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities };
    apiClient.endpoints = async () => [];
    apiClient.credentials = async () => [];
    apiClient.projectCapabilities = async () => manager;
    try {
      render(<EndpointsPage projectId="project_1" />);
      await screen.findByRole("heading", { name: "Create a credential first" });
      const link = screen.getByRole("link", { name: "Project credentials" });
      assert.equal(link.getAttribute("href"), "credentials");
      assert.equal(screen.queryByRole("button", { name: "Create endpoint" }), null);
      assert.equal(screen.queryByRole("dialog", { name: "Create endpoint" }), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the endpoint list readable when credentials fail and only disables configuration", async () => {
    const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities };
    apiClient.endpoints = async () => [endpoint];
    apiClient.credentials = async () => { throw new ApiError(503, "Credentials unavailable"); };
    apiClient.projectCapabilities = async () => manager;
    try {
      render(<EndpointsPage projectId="project_1" />);
      await screen.findByText(/Creating and editing endpoints is disabled/);
      assert.ok(screen.getAllByText("DeepSeek").length > 0);
      await waitFor(() => assert.ok(screen.getAllByRole("button", { name: "Edit DeepSeek" }).length > 0));
      for (const button of screen.getAllByRole("button", { name: "Edit DeepSeek" })) assert.equal((button as HTMLButtonElement).disabled, true);
      assert.equal((screen.getAllByRole("button", { name: "Check health for DeepSeek" })[0] as HTMLButtonElement).disabled, false);
      assert.equal((screen.getAllByRole("button", { name: "Delete DeepSeek" })[0] as HTMLButtonElement).disabled, false);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the endpoint list readable but hides mutations when permissions fail", async () => {
    const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities };
    apiClient.endpoints = async () => [endpoint];
    apiClient.credentials = async () => [credential];
    apiClient.projectCapabilities = async () => { throw new ApiError(503, "Permissions unavailable"); };
    try {
      render(<EndpointsPage projectId="project_1" />);
      await screen.findByText(/Endpoint management is disabled/);
      assert.ok(screen.getAllByText("DeepSeek").length > 0);
      assert.equal(screen.queryByRole("button", { name: "Edit DeepSeek" }), null);
      assert.equal(screen.queryByRole("button", { name: "Check health for DeepSeek" }), null);
      assert.equal(screen.queryByRole("button", { name: "Delete DeepSeek" }), null);
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("locks endpoint actions while a health recheck is in flight", async () => {
    const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities, recheckEndpoint: apiClient.recheckEndpoint };
    const second = { ...endpoint, id: "endpoint_2", name: "Second endpoint" };
    let finishRecheck!: (value: Endpoint) => void;
    apiClient.endpoints = async () => [endpoint, second];
    apiClient.credentials = async () => [credential];
    apiClient.projectCapabilities = async () => manager;
    apiClient.recheckEndpoint = async () => new Promise((resolve) => { finishRecheck = resolve; });
    try {
      render(<EndpointsPage projectId="project_1" />);
      fireEvent.click((await screen.findAllByRole("button", { name: "Check health for DeepSeek" }))[0]!);
      await waitFor(() => assert.ok(finishRecheck));

      for (const name of ["Refresh endpoints", "Create endpoint", "Check health for DeepSeek", "Check health for Second endpoint", "Edit DeepSeek", "Edit Second endpoint", "Delete DeepSeek", "Delete Second endpoint"]) {
        for (const button of screen.getAllByRole("button", { name })) assert.equal((button as HTMLButtonElement).disabled, true, name);
      }

      await act(async () => finishRecheck(endpoint));
    } finally {
      Object.assign(apiClient, original);
    }
  });

  it("keeps the endpoint form locked and visible while saving", async () => {
    const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities, updateEndpoint: apiClient.updateEndpoint };
    let finishSave!: (value: Endpoint) => void;
    apiClient.endpoints = async () => [endpoint];
    apiClient.credentials = async () => [credential];
    apiClient.projectCapabilities = async () => manager;
    apiClient.updateEndpoint = async () => new Promise((resolve) => { finishSave = resolve; });
    try {
      render(<EndpointsPage projectId="project_1" />);
      fireEvent.click((await screen.findAllByRole("button", { name: "Edit DeepSeek" }))[0]!);
      const dialog = await screen.findByRole("dialog", { name: "Edit endpoint" });
      fireEvent.change(screen.getByLabelText("Model"), { target: { value: "updated-model" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => assert.ok(finishSave));
      for (const name of ["Name", "Model", "Timeout"]) assert.equal((screen.getByLabelText(name) as HTMLInputElement).disabled, true, name);
      fireEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
      assert.ok(screen.getByRole("dialog", { name: "Edit endpoint" }));
      await act(async () => finishSave({ ...endpoint, model:"updated-model" }));
    } finally {
      Object.assign(apiClient, original);
    }
  });
});
describe("endpoint management", () => it("edits and discovers models with the credential binding projected by the API", async () => {
  const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities, discoverEndpointModels: apiClient.discoverEndpointModels, updateEndpoint: apiClient.updateEndpoint, recheckEndpoint: apiClient.recheckEndpoint };
  let checks = 0;
  let discoveryInput: unknown;
  let updateInput: unknown;
  apiClient.endpoints = async () => [{ ...endpoint, health: { status: "unavailable", checkedAt: "2026-07-12T00:00:00.000Z", errorCategory: "auth" } }];
  apiClient.credentials = async () => [credential];
  apiClient.projectCapabilities = async () => manager;
  apiClient.discoverEndpointModels = async (_projectId, input) => {
    discoveryInput = input;
    return { models: ["model-a", "model-b"], health: { status: "healthy", checkedAt: "2026-07-12T00:00:00.000Z", errorCategory: null } };
  };
  apiClient.updateEndpoint = async (_projectId, _endpointId, input) => {
    updateInput = input;
    return { ...endpoint, ...input, protocol: "openai_chat_completions" };
  };
  apiClient.recheckEndpoint = async () => { checks += 1; return { ...endpoint, health: { status: "healthy", checkedAt: "2026-07-12T00:01:00.000Z", errorCategory: null } }; };
  try {
    render(<EndpointsPage projectId="project_1" />);
    await screen.findAllByText("Unavailable: auth");
    fireEvent.click(screen.getAllByRole("button", { name: "Edit DeepSeek" })[0]!);
    await screen.findByRole("dialog", { name: "Edit endpoint" });
    assert.equal((document.querySelector("select") as HTMLSelectElement | null)?.value, "credential_1");
    assert.equal((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled, true);

    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    await waitFor(() => assert.deepEqual(discoveryInput, {
      endpointId: "endpoint_1",
      baseUrl: "https://api.example.test/v1",
      credentialId: "credential_1",
      requestTimeoutSecs: 30
    }));
    await screen.findByRole("combobox", { name: "Discovered models" });
    fireEvent.click(screen.getByRole("combobox", { name: "Discovered models" }));
    fireEvent.click(await screen.findByRole("option", { name: "model-b" }));
    assert.equal((screen.getByLabelText("Model") as HTMLInputElement).value, "model-b");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => assert.deepEqual(updateInput, {
      name: "DeepSeek",
      baseUrl: "https://api.example.test/v1",
      model: "model-b",
      credentialId: "credential_1",
      capabilities: ["text"],
      requestTimeoutSecs: 30
    }));
    await screen.findAllByRole("button", { name: "Check health for DeepSeek" });
    fireEvent.click(screen.getAllByRole("button", { name: "Check health for DeepSeek" })[0]!);
    await waitFor(() => assert.equal(checks, 1));
    await waitFor(() => assert.ok(screen.getAllByText("Healthy").length > 0));
  } finally {
    apiClient.endpoints = original.endpoints;
    apiClient.credentials = original.credentials;
    apiClient.projectCapabilities = original.projectCapabilities;
    apiClient.discoverEndpointModels = original.discoverEndpointModels;
    apiClient.updateEndpoint = original.updateEndpoint;
    apiClient.recheckEndpoint = original.recheckEndpoint;
  }
}));
describe("endpoint model discovery", () => it("ignores models discovered for connection details that have since changed", async () => {
  const original = { endpoints: apiClient.endpoints, credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities, discoverEndpointModels: apiClient.discoverEndpointModels };
  let resolveDiscovery!: (value: Awaited<ReturnType<typeof apiClient.discoverEndpointModels>>) => void;
  const otherCredential = { ...credential, id: "credential_2", name: "Other provider", baseUrl: "https://other.example.test/v1" };
  apiClient.endpoints = async () => [endpoint];
  apiClient.credentials = async () => [credential, otherCredential];
  apiClient.projectCapabilities = async () => manager;
  apiClient.discoverEndpointModels = async () => new Promise((resolve) => { resolveDiscovery = resolve; });
  try {
    render(<EndpointsPage projectId="project_1" />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Edit DeepSeek" }))[0]!);
    await screen.findByRole("dialog", { name: "Edit endpoint" });
    fireEvent.click(screen.getByRole("button", { name: "Discover models" }));
    fireEvent.change(document.querySelector("select")!, { target: { value: otherCredential.id } });
    assert.equal((screen.getByLabelText("Base URL") as HTMLInputElement).value, otherCredential.baseUrl);
    resolveDiscovery({ models: ["model-from-old-connection"], health: { status: "healthy", checkedAt: "2026-07-12T00:00:00.000Z", errorCategory: null } });
    await waitFor(() => assert.equal(screen.getByRole("button", { name: "Discover models" }).textContent?.includes("Checking"), false));
    assert.equal(screen.queryByRole("combobox", { name: "Discovered models" }), null);
  } finally {
    Object.assign(apiClient, original);
  }
}));
const credential={id:"credential_1",projectId:"project_1",name:"Provider",type:"api_key" as const,baseUrl:"https://api.example.test/v1",fingerprint:"fingerprint",version:1,createdAt:"x",lastRotatedAt:null,updatedAt:"x"}; const manager={...viewer,canManageEndpoints:true};
function installDom(){const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost"});Object.assign(globalThis,{window:dom.window,self:dom.window,document:dom.window.document,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLFormElement:dom.window.HTMLFormElement,Node:dom.window.Node,NodeFilter:dom.window.NodeFilter,DocumentFragment:dom.window.DocumentFragment,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,"navigator",{configurable:true,value:dom.window.navigator});Object.assign(dom.window,{PointerEvent:dom.window.MouseEvent});Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView(){}});if(!("ResizeObserver" in globalThis))Object.assign(globalThis,{ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});}
