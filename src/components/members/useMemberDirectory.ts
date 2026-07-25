"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface DirectoryPage<T> {
  items: T[];
  nextCursor: string | null;
}

interface DirectoryAttempt {
  q: string;
  role?: string;
  cursor?: string;
  history: string[];
}

export function useMemberDirectory<T>(loadPage:(query:{q?:string;role?:string;cursor?:string;limit:number})=>Promise<DirectoryPage<T>>,resetKey:string) {
  const active=useRef(true),request=useRef(0),mountedSearch=useRef(false);
  const hasContent=useRef(false);
  const intent=useRef({q:"",role:undefined as string|undefined});
  const displayed=useRef<DirectoryAttempt>({q:"",history:[]});
  const [page,setPage]=useState<DirectoryPage<T>>({items:[],nextCursor:null});
  const [state,setState]=useState<"loading"|"ready"|"error">("loading");
  const [refreshing,setRefreshing]=useState(false);
  const [error,setError]=useState("");
  const [refreshError,setRefreshError]=useState("");
  const [failed,setFailed]=useState<DirectoryAttempt>();
  const [query,setQuery]=useState("");
  const [role,setRoleState]=useState<string>();
  const [history,setHistory]=useState<string[]>([]);

  const load=useCallback(async(attempt:DirectoryAttempt)=>{
    const id=++request.current,preserve=hasContent.current;
    setFailed(undefined);
    if(preserve){setRefreshing(true);setRefreshError("");}else{setState("loading");setError("");}
    try{
      const result=await loadPage({...(attempt.q?{q:attempt.q}:{}),...(attempt.role?{role:attempt.role}:{}),...(attempt.cursor?{cursor:attempt.cursor}:{}),limit:20});
      if(!active.current||id!==request.current)return;
      displayed.current=attempt;hasContent.current=true;
      setPage(result);setHistory(attempt.history);setState("ready");setRefreshError("");
    }catch(reason){
      if(!active.current||id!==request.current)return;
      const message=reason instanceof Error?reason.message:"Members could not be loaded.";
      setFailed(attempt);
      if(hasContent.current){setRefreshError(message);setState("ready");}else{setError(message);setState("error");}
    }finally{if(active.current&&id===request.current)setRefreshing(false);}
  },[loadPage]);

  useEffect(()=>{active.current=true;return()=>{active.current=false;request.current+=1;};},[]);
  useEffect(()=>{
    hasContent.current=false;displayed.current={q:"",history:[]};intent.current={q:"",role:undefined};mountedSearch.current=false;
    setQuery("");setRoleState(undefined);setPage({items:[],nextCursor:null});setHistory([]);
    void load({q:"",history:[]});
  },[resetKey,load]);
  useEffect(()=>{
    if(!mountedSearch.current){mountedSearch.current=true;return;}
    const timer=window.setTimeout(()=>{
      const scope=intent.current;
      if(scope.q===displayed.current.q&&scope.role===displayed.current.role&&displayed.current.cursor===undefined)return;
      void load({q:scope.q,...(scope.role?{role:scope.role}:{}),history:[]});
    },250);
    return()=>window.clearTimeout(timer);
  },[query,role,load]);

  function invalidateIntent(){
    request.current+=1;setRefreshing(false);setRefreshError("");setFailed(undefined);
  }
  function setSearch(value:string){intent.current={...intent.current,q:value.trim().toLowerCase()};invalidateIntent();setQuery(value);}
  function setRole(value:string|undefined){intent.current={...intent.current,role:value};invalidateIntent();setRoleState(value);}
  function firstAttempt():DirectoryAttempt{const scope=intent.current;return{q:scope.q,...(scope.role?{role:scope.role}:{}),history:[]};}
  return{
    page,state,refreshing,error,refreshError,query,role,history,
    setSearch,setRole,
    retry:()=>load(failed??firstAttempt()),
    reloadFirst:()=>load(firstAttempt()),
    next:()=>{const cursor=page.nextCursor;if(!cursor)return;const scope=displayed.current;void load({q:scope.q,...(scope.role?{role:scope.role}:{}),cursor,history:[...scope.history,scope.cursor??""]});},
    previous:()=>{const scope=displayed.current,cursor=scope.history.at(-1);void load({q:scope.q,...(scope.role?{role:scope.role}:{}),...(cursor?{cursor}:{}),history:scope.history.slice(0,-1)});}
  };
}
