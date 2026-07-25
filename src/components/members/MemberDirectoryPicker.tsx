"use client";

import { Button, Selector, Text, TextInput } from "@astryxdesign/core";
import { Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient, type ProjectMemberCandidate } from "../../lib/api/client";
import { useMemberDirectory } from "./useMemberDirectory";

type PickerKind="workspace"|"project"|"projectCandidates";
type PickerItem=ProjectMemberCandidate;

export function MemberDirectoryPicker({kind,scopeId,label,value,onChange,excludeUserId,disabled=false,pinned=[]}:{kind:PickerKind;scopeId:string;label:string;value:string;onChange:(member:PickerItem)=>void;excludeUserId?:string;disabled?:boolean;pinned?:PickerItem[]}) {
  const fetchPage=useCallback(async(query:{q?:string;cursor?:string;limit:number})=>{
    if(kind==="workspace")return apiClient.workspaceMembers(scopeId,query);
    if(kind==="project")return apiClient.members(scopeId,query);
    return apiClient.memberCandidates(scopeId,query);
  },[kind,scopeId]);
  const directory=useMemberDirectory<PickerItem>(fetchPage,`${kind}:${scopeId}`);
  const [selected,setSelected]=useState<PickerItem|undefined>(pinned.find((item)=>item.userId===value));
  const pinnedValue=pinned.find((item)=>item.userId===value);
  useEffect(()=>{
    if(!value){setSelected(undefined);return;}
    const found=directory.page.items.find((item)=>item.userId===value)??pinnedValue;
    if(found)setSelected((current)=>sameMember(current,found)?current:found);
  },[directory.page.items,pinnedValue?.displayName,pinnedValue?.email,pinnedValue?.userId,value]);
  const options=useMemo(()=>{
    const items=directory.page.items.filter((item)=>item.userId!==excludeUserId);
    const fixed=[...pinned,...(selected?[selected]:[])].filter((item,index,all)=>item.userId!==excludeUserId&&all.findIndex((candidate)=>candidate.userId===item.userId)===index);
    return [...fixed,...items.filter((item)=>!fixed.some((candidate)=>candidate.userId===item.userId))].map((item)=>({value:item.userId,label:memberLabel(item)}));
  },[directory.page.items,excludeUserId,pinned,selected]);
  function select(userId:string){const member=(selected?.userId===userId?selected:directory.page.items.find((item)=>item.userId===userId));if(member){setSelected(member);onChange(member);}}
  return <div className="grid gap-2">
    <TextInput label={`Search ${label.toLowerCase()}`} isLabelHidden startIcon={<Search size={15}/>} value={directory.query} onChange={directory.setSearch} placeholder={`Search ${label.toLowerCase()}`} isDisabled={disabled} size="lg"/>
    <Selector label={label} options={options} value={options.some((option)=>option.value===value)?value:""} onChange={select} placeholder={directory.state==="loading"?"Loading members...":"Select a member"} isDisabled={disabled||directory.state!=="ready"||options.length===0} size="lg" width="100%"/>
    {directory.refreshError||directory.state==="error"?<div className="flex items-center justify-between gap-2"><Text type="supporting" className="text-error">{directory.refreshError||directory.error}</Text><Button label="Retry" variant="ghost" size="sm" onClick={()=>void directory.retry()}/></div>:null}
    {directory.state==="ready"&&options.length===0&&!directory.refreshing?<Text type="supporting" color="secondary">No members match this search.</Text>:null}
    {directory.history.length>0||directory.page.nextCursor?<div className="flex items-center justify-end gap-2"><Button label="Previous" variant="secondary" size="sm" isDisabled={disabled||directory.refreshing||directory.history.length===0} onClick={directory.previous}/><Text type="supporting" color="secondary">Page {directory.history.length+1}</Text><Button label="Next" variant="secondary" size="sm" isDisabled={disabled||directory.refreshing||!directory.page.nextCursor} onClick={directory.next}/></div>:null}
  </div>;
}

function memberLabel(member:PickerItem):string{return member.displayName||member.email||member.userId}
function sameMember(left:PickerItem|undefined,right:PickerItem):boolean{return left?.userId===right.userId&&left.displayName===right.displayName&&left.email===right.email}
