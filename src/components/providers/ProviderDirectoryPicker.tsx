"use client";

import { Button, Selector, Text, TextInput } from "@astryxdesign/core";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type Endpoint, type ProjectCredential } from "../../lib/api/client";
import { providerDirectoryPickerItems } from "./providerDirectoryPickerItems";

type DirectoryItem={id:string};
type DirectoryPage<T extends DirectoryItem>={items:T[];nextCursor:string|null};

export function CredentialPicker({projectId,value,selected,label="Credential",disabled=false,onChange}:{projectId:string;value:string;selected?:ProjectCredential;label?:string;disabled?:boolean;onChange:(credential:ProjectCredential)=>void}){
  const load=useCallback((query:{q?:string;cursor?:string;limit:number})=>apiClient.credentials(projectId,query),[projectId]);
  return <ProviderPicker<ProjectCredential> scopeKey={`credential:${projectId}`} label={label} value={value} {...(selected?{selected}:{})} disabled={disabled} load={load} loadExact={(id)=>apiClient.credential(projectId,id)} optionLabel={(item)=>`${item.name} (${item.fingerprint})`} onChange={onChange}/>;
}

export function EndpointPicker({projectId,value,selected,label="Endpoint",mode="all",disabled=false,onChange}:{projectId:string;value:string;selected?:Endpoint;label?:string;mode?:"all"|"task_ready";disabled?:boolean;onChange:(endpoint:Endpoint)=>void}){
  const load=useCallback((query:{q?:string;cursor?:string;limit:number})=>apiClient.endpoints(projectId,{...query,mode}),[mode,projectId]);
  return <ProviderPicker<Endpoint> scopeKey={`endpoint:${projectId}:${mode}`} label={label} value={value} {...(selected?{selected}:{})} disabled={disabled} load={load} loadExact={(id)=>apiClient.endpoint(projectId,id)} optionLabel={(item)=>`${item.name} (${item.model})`} onChange={onChange}/>;
}

function ProviderPicker<T extends DirectoryItem>({scopeKey,label,value,selected,disabled,load,loadExact,optionLabel,onChange}:{scopeKey:string;label:string;value:string;selected?:T;disabled:boolean;load:(query:{q?:string;cursor?:string;limit:number})=>Promise<DirectoryPage<T>>;loadExact:(id:string)=>Promise<T>;optionLabel:(item:T)=>string;onChange:(item:T)=>void}){
  const [query,setQuery]=useState(""),[committedQuery,setCommittedQuery]=useState("");
  const [page,setPage]=useState<DirectoryPage<T>>({items:[],nextCursor:null}),[history,setHistory]=useState<Array<string|undefined>>([]);
  const [cursor,setCursor]=useState<string|undefined>(),[fixed,setFixed]=useState<T|undefined>(selected);
  const [loadedHistory,setLoadedHistory]=useState<Array<string|undefined>>([]),[loadedCursor,setLoadedCursor]=useState<string|undefined>();
  const [state,setState]=useState<"loading"|"ready"|"error">("loading"),[refreshing,setRefreshing]=useState(false),[error,setError]=useState("");
  const pageRequest=useRef(0),exactRequest=useRef(0),exactValue=useRef(""),hasContent=useRef(false);

  useEffect(()=>{const timer=window.setTimeout(()=>{setCommittedQuery(query.trim());setHistory([]);setCursor(undefined)},250);return()=>window.clearTimeout(timer)},[query]);
  useEffect(()=>{pageRequest.current+=1;exactRequest.current+=1;exactValue.current="";hasContent.current=false;setQuery("");setCommittedQuery("");setHistory([]);setLoadedHistory([]);setCursor(undefined);setLoadedCursor(undefined);setPage({items:[],nextCursor:null});setFixed(selected)},[scopeKey]);
  useEffect(()=>{if(selected?.id===value)setFixed(selected)},[selected,value]);
  useEffect(()=>{
    if(!value||fixed?.id===value||page.items.some((item)=>item.id===value)||exactValue.current===value)return;
    exactValue.current=value;
    const revision=++exactRequest.current;
    void loadExact(value).then((item)=>{if(revision===exactRequest.current)setFixed(item)}).catch(()=>{});
  },[fixed?.id,loadExact,page.items,value]);

  const fetchPage=useCallback(async()=>{
    const revision=++pageRequest.current,preserve=hasContent.current;
    preserve?setRefreshing(true):setState("loading");setError("");
    try{
      const loaded=await load({q:committedQuery,...(cursor!==undefined?{cursor}:{}),limit:20});
      if(revision!==pageRequest.current)return;
      setPage(loaded);setLoadedHistory(history);setLoadedCursor(cursor);setState("ready");hasContent.current=true;
    }catch(reason){
      if(revision!==pageRequest.current)return;
      setError(reason instanceof Error?reason.message:`${label} options could not be loaded.`);
      if(!preserve)setState("error");
    }finally{if(revision===pageRequest.current)setRefreshing(false)}
  },[committedQuery,cursor,history,label,load]);
  useEffect(()=>{void fetchPage()},[fetchPage]);

  const items=useMemo(()=>providerDirectoryPickerItems(page.items,[fixed,selected]),[fixed,page.items,selected]);
  const options=useMemo(()=>items.map((item)=>({value:item.id,label:optionLabel(item)})),[items,optionLabel]);
  function select(id:string){const item=items.find((candidate)=>candidate.id===id);if(item){setFixed(item);onChange(item)}}
  function next(){if(!page.nextCursor)return;setHistory([...loadedHistory,loadedCursor]);setCursor(page.nextCursor)}
  function previous(){if(loadedHistory.length===0)return;setCursor(loadedHistory.at(-1));setHistory(loadedHistory.slice(0,-1))}

  return <div className="grid gap-2">
    <TextInput label={`Search ${label.toLowerCase()}s`} isLabelHidden startIcon={<Search size={15}/>} value={query} onChange={(value)=>{pageRequest.current+=1;setQuery(value)}} placeholder={`Search ${label.toLowerCase()}s`} isDisabled={disabled} size="lg"/>
    <Selector label={label} options={options} value={options.some((option)=>option.value===value)?value:""} onChange={select} placeholder={state==="loading"?"Loading...":`Select ${label.toLowerCase()}`} isDisabled={disabled||state==="loading"||options.length===0} size="lg" width="100%"/>
    {error?<div className="flex items-center justify-between gap-2"><Text type="supporting" className="text-error">{error}</Text><Button label="Retry" variant="ghost" size="sm" onClick={()=>void fetchPage()}/></div>:null}
    {state==="ready"&&options.length===0&&!refreshing?<Text type="supporting" color="secondary">No matching {label.toLowerCase()}s.</Text>:null}
    {loadedHistory.length>0||page.nextCursor?<div className="flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="sm" isDisabled={disabled||refreshing||Boolean(error)||loadedHistory.length===0} onClick={previous}/><Text type="supporting" color="secondary">Page {loadedHistory.length+1}</Text><Button label="Next" variant="secondary" size="sm" isDisabled={disabled||refreshing||Boolean(error)||query.trim()!==committedQuery||!page.nextCursor} onClick={next}/></div>:null}
  </div>;
}
