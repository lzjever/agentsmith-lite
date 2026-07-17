import { type FormEvent } from "react";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "../ui/dialog";
import { Input } from "../ui/input";
import { CredentialSecretField } from "./CredentialSecretField";

export function CredentialDialog({open,onOpenChange,title,busy,onSubmit,submit,includeName=false}:{open:boolean;onOpenChange:(open:boolean)=>void;title:string;busy:boolean;onSubmit:(event:FormEvent<HTMLFormElement>)=>void;submit:string;includeName?:boolean}) { return <Dialog open={open} onOpenChange={(next)=>{if(!busy)onOpenChange(next);}}><DialogContent><form onSubmit={onSubmit}><DialogHeader title={title} description="The secret is sent once and is never displayed again."/><div className="grid gap-4 px-5 py-5">{includeName?<label className="grid gap-2 text-sm">Name<Input required name="name" autoFocus disabled={busy}/></label>:null}{includeName?<label className="grid gap-2 text-sm">Base URL<Input required name="baseUrl" type="url" placeholder="https://api.example.com/v1" disabled={busy}/></label>:null}<CredentialSecretField disabled={busy}/></div><DialogFooter><Button type="button" variant="quiet" onClick={()=>onOpenChange(false)} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy}>{busy?"Working...":submit}</Button></DialogFooter></form></DialogContent></Dialog>; }
