import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient } from "../../src/lib/api/client.js";

installDom();
const { act, cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { CredentialsPage } = await import("../../src/components/credentials/CredentialsPage.js");
afterEach(()=>cleanup());

describe("CredentialsPage",()=>{
  it("ignores credentials loaded for a project that is no longer active", async () => {
    const original = { credentials: apiClient.credentials, projectCapabilities: apiClient.projectCapabilities };
    let finishOldLoad!: (value: typeof credential[]) => void;
    let oldLoadStarted = false;
    const second = { ...credential, id: "credential_2", projectId: "project_2", name: "Project Two Key" };
    apiClient.credentials = async (projectId) => projectId === "project_1" ? new Promise((resolve) => { oldLoadStarted = true; finishOldLoad = resolve; }) : [second];
    apiClient.projectCapabilities = async () => manager;
    try {
      const view = render(<CredentialsPage projectId="project_1" />);
      await waitFor(() => assert.equal(oldLoadStarted, true));
      view.rerender(<CredentialsPage projectId="project_2" />);
      await screen.findByText("Project Two Key");
      await act(async () => finishOldLoad([credential]));
      assert.ok(screen.getByText("Project Two Key"));
      assert.equal(screen.queryByText("DeepSeek"), null);
    } finally { Object.assign(apiClient, original); }
  });

  it("keeps credential metadata readable for viewers and reserves mutations for managers",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities};
    apiClient.credentials=async()=>[credential]; apiClient.projectCapabilities=async()=>viewer;
    try{render(<CredentialsPage projectId="project_1"/>);await screen.findByText("DeepSeek");assert.ok(screen.getByText("fingerprint"));assert.ok(screen.getByText("API key"));assert.ok(screen.getByText("Version 1"));assert.ok(screen.getByText("Never rotated"));assert.equal(screen.queryByRole("button",{name:/New credential/}),null);assert.equal(screen.queryByRole("button",{name:/Rotate/}),null);}finally{apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;}
  });
  it("uses a shared rotate dialog for managers",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities,rotateCredential:apiClient.rotateCredential};let rotated="";
    apiClient.credentials=async()=>[credential];apiClient.projectCapabilities=async()=>manager;apiClient.rotateCredential=async(_project,_credential,secret)=>{rotated=secret;return {...credential,version:2,lastRotatedAt:"2026-01-02T00:00:00.000Z"};};
    try{render(<CredentialsPage projectId="project_1"/>);fireEvent.click(await screen.findByRole("button",{name:/Rotate/}));await screen.findByRole("heading",{name:"Rotate DeepSeek"});fireEvent.change(screen.getByLabelText("API key"),{target:{value:"new-key"}});fireEvent.click(screen.getByRole("button",{name:"Rotate credential"}));await waitFor(()=>assert.equal(rotated,"new-key"));assert.ok(await screen.findByText("Version 2"));assert.match(screen.getByText(/^Rotated /).textContent??"",/2026/);}finally{apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;apiClient.rotateCredential=original.rotateCredential;}
  });
  it("submits the create dialog through the credential API",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities,createCredential:apiClient.createCredential};const created:string[]=[];
    apiClient.credentials=async()=>[];apiClient.projectCapabilities=async()=>manager;apiClient.createCredential=async(_project,input)=>{created.push(`${input.name}|${input.baseUrl}|${input.secret}`);return {...credential,name:input.name,baseUrl:input.baseUrl};};
    try{render(<CredentialsPage projectId="project_1"/>);fireEvent.click((await screen.findAllByRole("button",{name:"New credential"}))[0]!);const dialog=await screen.findByRole("dialog",{name:"New credential"});fireEvent.change(within(dialog).getByRole("textbox",{name:"Name"}),{target:{value:"New key"}});fireEvent.change(within(dialog).getByRole("textbox",{name:"Base URL"}),{target:{value:"https://api.example.test/v1"}});fireEvent.change(within(dialog).getByLabelText("API key"),{target:{value:"secret-value"}});fireEvent.click(within(dialog).getByRole("button",{name:"Create credential"}));await waitFor(()=>assert.deepEqual(created,["New key|https://api.example.test/v1|secret-value"]));}finally{apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;apiClient.createCredential=original.createCredential;}
  });
  it("shows a safe API error and retries loading credentials",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities};let attempts=0;
    apiClient.credentials=async()=>{attempts+=1;if(attempts===1)throw new ApiError(503,"Credential service unavailable");return [credential];};apiClient.projectCapabilities=async()=>manager;
    try{render(<CredentialsPage projectId="project_1"/>);await screen.findByText("Credential service unavailable");fireEvent.click(screen.getByRole("button",{name:"Try again"}));await screen.findByText("DeepSeek");assert.equal(attempts,2);}finally{apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;}
  });
  it("keeps credential metadata readable but disables mutations when permissions fail",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities};
    apiClient.credentials=async()=>[credential];apiClient.projectCapabilities=async()=>{throw new ApiError(503,"Permissions unavailable");};
    try{render(<CredentialsPage projectId="project_1"/>);await screen.findByText("DeepSeek");assert.match(screen.getByRole("alert").textContent??"",/read-only until refreshed/i);assert.equal(screen.queryByRole("button",{name:/New credential/}),null);assert.equal(screen.queryByRole("button",{name:/Rotate/}),null);assert.ok(screen.getByText("fingerprint"));}finally{apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;}
  });
  it("becomes read-only when credential management permission is revoked during a mutation",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities,createCredential:apiClient.createCredential};
    apiClient.credentials=async()=>[credential];apiClient.projectCapabilities=async()=>manager;apiClient.createCredential=async()=>{throw new ApiError(403,"Credential management permission was revoked.");};
    try{render(<CredentialsPage projectId="project_1"/>);fireEvent.click(await screen.findByRole("button",{name:"New credential"}));const dialog=await screen.findByRole("dialog",{name:"New credential"});fireEvent.change(within(dialog).getByRole("textbox",{name:"Name"}),{target:{value:"New key"}});fireEvent.change(within(dialog).getByRole("textbox",{name:"Base URL"}),{target:{value:"https://api.example.test/v1"}});fireEvent.change(within(dialog).getByLabelText("API key"),{target:{value:"secret-value"}});await act(async()=>{fireEvent.click(within(dialog).getByRole("button",{name:"Create credential"}));await new Promise(resolve=>setTimeout(resolve,0));});assert.equal(screen.queryByRole("dialog",{name:"New credential"}),null);assert.equal(screen.queryByRole("button",{name:"New credential"}),null);assert.equal(screen.queryByRole("button",{name:/Rotate/}),null);}finally{Object.assign(apiClient,original);}
  });
  it("keeps delete confirmation open when the credential is still in use",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities,deleteCredential:apiClient.deleteCredential};let attempts=0;
    apiClient.credentials=async()=>[credential];apiClient.projectCapabilities=async()=>manager;apiClient.deleteCredential=async()=>{attempts+=1;throw new ApiError(409,"Credential is used by endpoint DeepSeek.");};
    try{render(<CredentialsPage projectId="project_1"/>);fireEvent.click(await screen.findByRole("button",{name:"Delete DeepSeek"}));const dialog=await screen.findByRole("alertdialog",{name:"Delete DeepSeek"});await act(async()=>{fireEvent.click(within(dialog).getByRole("button",{name:"Delete credential"}));await new Promise(resolve=>setTimeout(resolve,0));});assert.equal(attempts,1);assert.ok(screen.getByRole("alertdialog",{name:"Delete DeepSeek"}));}finally{Object.assign(apiClient,original);}
  });
});

const credential={id:"credential_1",projectId:"project_1",name:"DeepSeek",type:"api_key" as const,baseUrl:"https://api.example.test/v1",fingerprint:"fingerprint",version:1,createdAt:"2026-01-01T00:00:00.000Z",lastRotatedAt:null,updatedAt:"2026-01-01T00:00:00.000Z"};
const viewer={canManageEndpoints:false,canManageMembers:false,canManagePolicy:false,canWriteFiles:false,canCreateTasks:false,canCancelTasks:false,canSendChat:false}; const manager={...viewer,canManageEndpoints:true};
function installDom(){const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost"});Object.assign(globalThis,{window:dom.window,self:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLButtonElement:dom.window.HTMLButtonElement,HTMLFormElement:dom.window.HTMLFormElement,Node:dom.window.Node,NodeFilter:dom.window.NodeFilter,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,MutationObserver:dom.window.MutationObserver,FormData:dom.window.FormData,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,"navigator",{configurable:true,value:dom.window.navigator});Object.assign(dom.window,{PointerEvent:dom.window.MouseEvent});if(!("ResizeObserver" in globalThis))Object.assign(globalThis,{ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});}
