import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { apiClient, type Endpoint, type ProjectCapabilities } from "../../src/lib/api/client.js";
installDom(); const {cleanup,fireEvent,render,screen,waitFor}=await import("@testing-library/react"); const {EndpointsPage}=await import("../../src/components/endpoints/EndpointsPage.js"); afterEach(()=>cleanup());
const endpoint:Endpoint={id:"endpoint_1",projectId:"project_1",name:"DeepSeek",protocol:"openai_chat_completions",baseUrl:"https://api.example.test/v1",model:"model",credentialId:"credential_1",capabilities:["text"],requestTimeoutSecs:30,health:{status:"healthy",checkedAt:"2026-07-12T00:00:00.000Z",errorCategory:null},hasCredentialRef:true,taskEligible:true,createdAt:"x",updatedAt:"x"}; const viewer:ProjectCapabilities={canManageEndpoints:false,canManageMembers:false,canManagePolicy:false,canWriteFiles:false,canCreateTasks:false,canCancelTasks:false,canSendChat:false};
describe("endpoint summary",()=>it("shows configured summary and read-only health status",async()=>{const original={endpoints:apiClient.endpoints,credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities};apiClient.endpoints=async()=>[endpoint];apiClient.credentials=async()=>[];apiClient.projectCapabilities=async()=>viewer;try{render(<EndpointsPage projectId="project_1"/>);await screen.findByText(/1 endpoint configured · 1 configured/);assert.ok(screen.getByText("Read-only access."));assert.ok(screen.getAllByText("Healthy").length>0);}finally{apiClient.endpoints=original.endpoints;apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;}}));
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
const credential={id:"credential_1",projectId:"project_1",name:"Provider",type:"api_key" as const,baseUrl:"https://api.example.test/v1",fingerprint:"fingerprint",version:1,createdAt:"x",lastRotatedAt:null,updatedAt:"x"}; const manager={...viewer,canManageEndpoints:true};
function installDom(){const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost"});Object.assign(globalThis,{window:dom.window,self:dom.window,document:dom.window.document,Element:dom.window.Element,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLFormElement:dom.window.HTMLFormElement,Node:dom.window.Node,NodeFilter:dom.window.NodeFilter,DocumentFragment:dom.window.DocumentFragment,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,MutationObserver:dom.window.MutationObserver,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,"navigator",{configurable:true,value:dom.window.navigator});Object.assign(dom.window,{PointerEvent:dom.window.MouseEvent});Object.assign(dom.window.HTMLElement.prototype,{scrollIntoView(){}});if(!("ResizeObserver" in globalThis))Object.assign(globalThis,{ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});}
