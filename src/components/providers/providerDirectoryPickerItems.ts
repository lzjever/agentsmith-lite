export function providerDirectoryPickerItems<T extends {id:string}>(page:T[],pinned:Array<T|undefined>):T[]{
  const items=new Map<string,T>();
  for(const item of pinned)if(item&&!items.has(item.id))items.set(item.id,item);
  for(const item of page)if(!items.has(item.id))items.set(item.id,item);
  return [...items.values()];
}

export function providerDirectoryExactItemAvailable(
  mode:"all"|"task_ready",
  item:{id:string;taskEligible?:boolean}
):boolean{
  return mode!=="task_ready"||item.taskEligible===true;
}

export function providerDirectoryExactResultApplies(requestId:string,currentValue:string,revision:number,currentRevision:number):boolean{
  return requestId===currentValue&&revision===currentRevision;
}

export interface ProviderDirectoryExactFailure {message:string;unavailable:boolean}

export function providerDirectoryExactFailure(label:string,status:number|undefined,message:string):ProviderDirectoryExactFailure{
  return status===404
    ?{message:`Selected ${label.toLowerCase()} is no longer available.`,unavailable:true}
    :{message:message||`Selected ${label.toLowerCase()} could not be loaded.`,unavailable:false};
}

export function providerDirectoryRetryTargets(pageError:string,exactError:ProviderDirectoryExactFailure|null):{page:boolean;exact:boolean}{
  return{page:Boolean(pageError),exact:exactError!==null};
}
