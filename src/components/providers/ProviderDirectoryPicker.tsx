"use client";

import { Button, Selector, Text, TextInput } from "@astryxdesign/core";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, apiClient, type Endpoint, type ProjectCredential } from "../../lib/api/client";
import { providerDirectoryExactFailure, providerDirectoryPickerItems, providerDirectoryRetryTargets, type ProviderDirectoryExactFailure } from "./providerDirectoryPickerItems";

type DirectoryItem={id:string};
type DirectoryPage<T extends DirectoryItem>={items:T[];nextCursor:string|null};

export function CredentialPicker({projectId,value,selected,label="Credential",disabled=false,onChange,onUnavailable}:{projectId:string;value:string;selected?:ProjectCredential;label?:string;disabled?:boolean;onChange:(credential:ProjectCredential)=>void;onUnavailable?:(id:string)=>void}){
  const load=useCallback((query:{q?:string;cursor?:string;limit:number})=>apiClient.credentials(projectId,query),[projectId]);
  return <ProviderPicker<ProjectCredential> scopeKey={`credential:${projectId}`} label={label} value={value} {...(selected?{selected}:{})} disabled={disabled} load={load} loadExact={(id)=>apiClient.credential(projectId,id)} optionLabel={(item)=>`${item.name} (${item.fingerprint})`} onChange={onChange} {...(onUnavailable?{onUnavailable}:{})}/>;
}

export function EndpointPicker({projectId,value,selected,label="Endpoint",mode="all",disabled=false,onChange,onUnavailable}:{projectId:string;value:string;selected?:Endpoint;label?:string;mode?:"all"|"task_ready";disabled?:boolean;onChange:(endpoint:Endpoint)=>void;onUnavailable?:(id:string)=>void}){
  const load=useCallback((query:{q?:string;cursor?:string;limit:number})=>apiClient.endpoints(projectId,{...query,mode}),[mode,projectId]);
  return <ProviderPicker<Endpoint> scopeKey={`endpoint:${projectId}:${mode}`} label={label} value={value} {...(selected?{selected}:{})} disabled={disabled} load={load} loadExact={(id)=>apiClient.endpoint(projectId,id)} optionLabel={(item)=>`${item.name} (${item.model})`} onChange={onChange} {...(onUnavailable?{onUnavailable}:{})}/>;
}

function ProviderPicker<T extends DirectoryItem>({scopeKey,label,value,selected,disabled,load,loadExact,optionLabel,onChange,onUnavailable}:{scopeKey:string;label:string;value:string;selected?:T;disabled:boolean;load:(query:{q?:string;cursor?:string;limit:number})=>Promise<DirectoryPage<T>>;loadExact:(id:string)=>Promise<T>;optionLabel:(item:T)=>string;onChange:(item:T)=>void;onUnavailable?:(id:string)=>void}){
  const [query,setQuery]=useState(""),[committedQuery,setCommittedQuery]=useState("");
  const [page,setPage]=useState<DirectoryPage<T>>({items:[],nextCursor:null}),[history,setHistory]=useState<Array<string|undefined>>([]);
  const [cursor,setCursor]=useState<string|undefined>(),[fixed,setFixed]=useState<T|undefined>(selected);
  const [loadedHistory,setLoadedHistory]=useState<Array<string|undefined>>([]),[loadedCursor,setLoadedCursor]=useState<string|undefined>();
  const [state,setState]=useState<"loading"|"ready"|"error">("loading"),[refreshing,setRefreshing]=useState(false),[pageError,setPageError]=useState("");
  const [exactError,setExactError]=useState<(ProviderDirectoryExactFailure&{id:string})|null>(null),[exactLoading,setExactLoading]=useState(false);
  const pageRequest=useRef(0),exactRequest=useRef(0),exactValue=useRef(""),hasContent=useRef(false);

  useEffect(()=>{const timer=window.setTimeout(()=>{setCommittedQuery(query.trim());setHistory([]);setCursor(undefined)},250);return()=>window.clearTimeout(timer)},[query]);
  useEffect(()=>{pageRequest.current+=1;exactRequest.current+=1;exactValue.current="";hasContent.current=false;setQuery("");setCommittedQuery("");setHistory([]);setLoadedHistory([]);setCursor(undefined);setLoadedCursor(undefined);setPage({items:[],nextCursor:null});setFixed(selected);setPageError("");setExactError(null);setExactLoading(false)},[scopeKey]);
  useEffect(()=>{if(selected?.id===value)setFixed(selected)},[selected,value]);
  const fetchExact=useCallback(async(id:string,force=false)=>{
    if(!id||!force&&exactValue.current===id)return undefined;
    exactValue.current=id;
    const revision=++exactRequest.current;
    setExactLoading(true);setExactError(null);
    try{
      const item=await loadExact(id);
      if(revision!==exactRequest.current)return undefined;
      setFixed(item);
      return item;
    }catch(reason){
      if(revision!==exactRequest.current)return undefined;
      const failure=providerDirectoryExactFailure(label,reason instanceof ApiError?reason.status:undefined,reason instanceof Error?reason.message:"");
      setExactError({...failure,id});
      if(failure.unavailable){setFixed((current)=>current?.id===id?undefined:current);onUnavailable?.(id)}
      return undefined;
    }finally{if(revision===exactRequest.current)setExactLoading(false)}
  },[label,loadExact,onUnavailable]);
  useEffect(()=>{
    if(!value){exactRequest.current+=1;exactValue.current="";setExactError((current)=>current?.unavailable?current:null);setExactLoading(false);return}
    const pageItem=page.items.find((item)=>item.id===value);
    if(pageItem){setFixed(pageItem);setExactError(null);exactValue.current=value;return}
    if(fixed?.id===value)return;
    void fetchExact(value);
  },[fetchExact,fixed?.id,page.items,value]);

  const fetchPage=useCallback(async()=>{
    const revision=++pageRequest.current,preserve=hasContent.current;
    preserve?setRefreshing(true):setState("loading");setPageError("");
    try{
      const loaded=await load({q:committedQuery,...(cursor!==undefined?{cursor}:{}),limit:20});
      if(revision!==pageRequest.current)return;
      setPage(loaded);setLoadedHistory(history);setLoadedCursor(cursor);setState("ready");hasContent.current=true;
    }catch(reason){
      if(revision!==pageRequest.current)return;
      setPageError(reason instanceof Error?reason.message:`${label} options could not be loaded.`);
      if(!preserve)setState("error");
    }finally{if(revision===pageRequest.current)setRefreshing(false)}
  },[committedQuery,cursor,history,label,load]);
  useEffect(()=>{void fetchPage()},[fetchPage]);

  const items=useMemo(()=>providerDirectoryPickerItems(page.items,[fixed,selected]),[fixed,page.items,selected]);
  const options=useMemo(()=>items.map((item)=>({value:item.id,label:optionLabel(item)})),[items,optionLabel]);
  function select(id:string){const item=items.find((candidate)=>candidate.id===id);if(item){setExactError(null);setFixed(item);onChange(item)}}
  function next(){if(!page.nextCursor)return;setHistory([...loadedHistory,loadedCursor]);setCursor(page.nextCursor)}
  function previous(){if(loadedHistory.length===0)return;setCursor(loadedHistory.at(-1));setHistory(loadedHistory.slice(0,-1))}
  async function retry(){
    const targets=providerDirectoryRetryTargets(pageError,exactError);
    if(targets.page)await fetchPage();
    if(targets.exact&&exactError){
      const item=await fetchExact(exactError.id,true);
      if(item&&exactError.unavailable)onChange(item);
    }
  }
  const errorMessage=exactError?.message||pageError;

  return <div className="grid gap-2">
    <TextInput label={`Search ${label.toLowerCase()}s`} startIcon={<Search size={15}/>} value={query} onChange={(value)=>{pageRequest.current+=1;setQuery(value)}} placeholder={`Search ${label.toLowerCase()}s`} isDisabled={disabled} size="lg"/>
    <Selector label={label} options={options} value={options.some((option)=>option.value===value)?value:""} onChange={select} placeholder={state==="loading"||exactLoading?"Loading...":`Select ${label.toLowerCase()}`} isDisabled={disabled||state==="loading"||options.length===0} size="lg" width="100%"/>
    {errorMessage?<div role="alert" className="flex items-center justify-between gap-2"><Text type="supporting" className="text-error">{errorMessage}</Text><Button label="Retry" variant="ghost" size="sm" isDisabled={refreshing||exactLoading} onClick={()=>void retry()}/></div>:null}
    {state==="ready"&&options.length===0&&!refreshing&&!exactLoading&&!exactError?<Text type="supporting" color="secondary">No matching {label.toLowerCase()}s.</Text>:null}
    {loadedHistory.length>0||page.nextCursor?<div className="flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="sm" isDisabled={disabled||refreshing||Boolean(pageError)||loadedHistory.length===0} onClick={previous}/><Text type="supporting" color="secondary">Page {loadedHistory.length+1}</Text><Button label="Next" variant="secondary" size="sm" isDisabled={disabled||refreshing||Boolean(pageError)||query.trim()!==committedQuery||!page.nextCursor} onClick={next}/></div>:null}
  </div>;
}
