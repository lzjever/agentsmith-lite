"use client";

import { Maximize2, RefreshCw, TerminalSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "../../lib/api/client";
import { Button } from "../ui/button";

type TerminalState = "connecting" | "ready" | "closed" | "error";
const AUTO_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

export function TaskTerminalPanel({ taskId }: { taskId: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const terminalInstance=useRef<import("@xterm/xterm").Terminal|null>(null);
  const fitInstance=useRef<import("@xterm/addon-fit").FitAddon|null>(null);
  const socketInstance=useRef<WebSocket|null>(null);
  const reconnectAttempt=useRef(0);
  const terminalTaskId=useRef(taskId);
  const [generation,setGeneration]=useState(0);
  const [state,setState]=useState<TerminalState>("connecting");
  const [error,setError]=useState("");

  useEffect(()=>{
    if(terminalTaskId.current!==taskId){terminalTaskId.current=taskId;reconnectAttempt.current=0;}
    let disposed=false;
    let retryScheduled=false;
    let shellExited=false;
    let retryTimer:ReturnType<typeof setTimeout>|undefined;
    let socket:WebSocket|undefined;
    let terminal:import("@xterm/xterm").Terminal|undefined;
    let fit:import("@xterm/addon-fit").FitAddon|undefined;
    let observer:ResizeObserver|undefined;
    void Promise.all([import("@xterm/xterm"),import("@xterm/addon-fit")]).then(([xterm,addon])=>{
      if(disposed||!viewport.current)return;
      terminal=new xterm.Terminal({cursorBlink:true,fontFamily:"ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",fontSize:13,scrollback:5000,theme:{background:"#111315",foreground:"#e8e8e5",cursor:"#e8e8e5",selectionBackground:"#3f5368"}});
      fit=new addon.FitAddon();terminal.loadAddon(fit);terminal.open(viewport.current);fit.fit();terminal.focus();
      terminalInstance.current=terminal;fitInstance.current=fit;
      terminal.writeln("\x1b[90mConnecting to the task workspace...\x1b[0m");
      socket=new WebSocket(apiClient.taskTerminalWebSocketUrl(taskId));socketInstance.current=socket;
      const retryOrFail=(message:string)=>{
        if(disposed||retryScheduled||shellExited)return;
        const delay=AUTO_RECONNECT_DELAYS_MS[reconnectAttempt.current];
        if(delay===undefined){setError(message);setState("error");return;}
        retryScheduled=true;reconnectAttempt.current+=1;setState("connecting");
        terminal?.writeln(`\r\n\x1b[90mWorkspace is starting. Reconnecting in ${delay/1_000}s...\x1b[0m`);
        retryTimer=setTimeout(()=>{if(!disposed)setGeneration((value)=>value+1);},delay);
      };
      socket.onmessage=(event)=>{
        let frame:{op?:string;data?:string;message?:string;exit_code?:number|null};
        try{frame=JSON.parse(String(event.data)) as typeof frame;}catch{return;}
        if(frame.op==="ready"){reconnectAttempt.current=0;setError("");setState("ready");terminal?.clear();sendSize(socket,terminal);return;}
        if(frame.op==="output"&&frame.data){terminal?.write(decodeBase64(frame.data));return;}
        if(frame.op==="completed"){shellExited=true;terminal?.writeln(`\r\n\x1b[90mShell exited${frame.exit_code===null||frame.exit_code===undefined?"":` with code ${frame.exit_code}`}.\x1b[0m`);setState("closed");return;}
        if(frame.op==="error"){retryOrFail(frame.message??"Task terminal failed.");socket?.close();}
      };
      socket.onerror=()=>retryOrFail("Task terminal connection failed.");
      socket.onclose=()=>{if(shellExited)setState("closed");else retryOrFail("Task terminal connection failed.");};
      terminal.onData((data)=>{if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({op:"stdin",data:encodeBase64(data)}));});
      observer=new ResizeObserver(()=>{fit?.fit();sendSize(socket,terminal);});observer.observe(viewport.current);
    }).catch(()=>{setError("Task terminal could not be loaded.");setState("error");});
    return()=>{disposed=true;if(retryTimer)clearTimeout(retryTimer);observer?.disconnect();if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({op:"cancel"}));socket?.close();terminal?.dispose();terminalInstance.current=null;fitInstance.current=null;socketInstance.current=null;};
  },[generation,taskId]);

  function fitTerminal(){fitInstance.current?.fit();sendSize(socketInstance.current,terminalInstance.current);terminalInstance.current?.focus();}

  return <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#111315]" aria-label="Task terminal">
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-white/10 bg-[#181b1e] px-3 text-white"><div className="flex items-center gap-2"><TerminalSquare size={16}/><span className="text-sm">Task terminal</span><span className="font-mono text-[10px] uppercase text-white/55">{state}</span></div><div className="flex items-center gap-1"><Button variant="quiet" size="icon" aria-label="Fit terminal" title="Fit terminal" onClick={fitTerminal}><Maximize2 size={15}/></Button>{state==="closed"||state==="error"?<Button variant="quiet" size="icon" aria-label="Reconnect terminal" title="Reconnect terminal" onClick={()=>{reconnectAttempt.current=0;setError("");setState("connecting");setGeneration((value)=>value+1);}}><RefreshCw size={15}/></Button>:null}</div></div>
    {error?<p className="border-b border-error/30 bg-error/10 px-3 py-2 text-xs text-error" role="alert">{error}</p>:null}
    <div ref={viewport} className="min-h-0 w-full flex-1 p-2" />
  </section>;
}

function decodeBase64(value:string):string{
  const raw=atob(value);const bytes=Uint8Array.from(raw,(character)=>character.charCodeAt(0));return new TextDecoder().decode(bytes);
}
function encodeBase64(value:string):string{
  const bytes=new TextEncoder().encode(value);let raw="";for(const byte of bytes)raw+=String.fromCharCode(byte);return btoa(raw);
}

function sendSize(socket:WebSocket|null|undefined,terminal:import("@xterm/xterm").Terminal|null|undefined):void{
  if(socket?.readyState===WebSocket.OPEN&&terminal)socket.send(JSON.stringify({op:"resize",rows:terminal.rows,cols:terminal.cols}));
}
