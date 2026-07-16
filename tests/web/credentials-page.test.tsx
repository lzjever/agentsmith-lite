import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { afterEach, describe, it } from "node:test";
import React from "react";
import { ApiError, apiClient } from "../../src/lib/api/client.js";

installDom();
const { cleanup, fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
const { CredentialsPage } = await import("../../src/components/credentials/CredentialsPage.js");
afterEach(()=>cleanup());

describe("CredentialsPage",()=>{
  it("keeps credential metadata readable for viewers and reserves mutations for managers",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities};
    apiClient.credentials=async()=>[credential]; apiClient.projectCapabilities=async()=>viewer;
    try{render(<CredentialsPage projectId="project_1"/>);await screen.findByText("DeepSeek");assert.ok(screen.getByText("fingerprint"));assert.equal(screen.queryByRole("button",{name:/New credential/}),null);assert.equal(screen.queryByRole("button",{name:/Rotate/}),null);}finally{apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;}
  });
  it("uses a shared rotate dialog for managers",async()=>{
    const original={credentials:apiClient.credentials,projectCapabilities:apiClient.projectCapabilities,rotateCredential:apiClient.rotateCredential};let rotated="";
    apiClient.credentials=async()=>[credential];apiClient.projectCapabilities=async()=>manager;apiClient.rotateCredential=async(_project,_credential,secret)=>{rotated=secret;return credential;};
    try{render(<CredentialsPage projectId="project_1"/>);fireEvent.click(await screen.findByRole("button",{name:/Rotate/}));await screen.findByRole("heading",{name:"Rotate DeepSeek"});fireEvent.change(screen.getByLabelText("API key"),{target:{value:"new-key"}});fireEvent.click(screen.getByRole("button",{name:"Rotate credential"}));await waitFor(()=>assert.equal(rotated,"new-key"));}finally{apiClient.credentials=original.credentials;apiClient.projectCapabilities=original.projectCapabilities;apiClient.rotateCredential=original.rotateCredential;}
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
});

const credential={id:"credential_1",projectId:"project_1",name:"DeepSeek",type:"api_key" as const,baseUrl:"https://api.example.test/v1",fingerprint:"fingerprint",version:1,createdAt:"2026-01-01T00:00:00.000Z",lastRotatedAt:null,updatedAt:"2026-01-01T00:00:00.000Z"};
const viewer={canManageEndpoints:false,canManageMembers:false,canManagePolicy:false,canWriteFiles:false,canCreateTasks:false,canCancelTasks:false,canSendChat:false}; const manager={...viewer,canManageEndpoints:true};
function installDom(){const dom=new JSDOM("<!doctype html><html><body></body></html>",{url:"http://localhost"});Object.assign(globalThis,{window:dom.window,self:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,HTMLInputElement:dom.window.HTMLInputElement,HTMLButtonElement:dom.window.HTMLButtonElement,HTMLFormElement:dom.window.HTMLFormElement,Node:dom.window.Node,NodeFilter:dom.window.NodeFilter,Event:dom.window.Event,CustomEvent:dom.window.CustomEvent,MutationObserver:dom.window.MutationObserver,FormData:dom.window.FormData,getComputedStyle:dom.window.getComputedStyle,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(globalThis,"navigator",{configurable:true,value:dom.window.navigator});Object.assign(dom.window,{PointerEvent:dom.window.MouseEvent});if(!("ResizeObserver" in globalThis))Object.assign(globalThis,{ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});}
