const providerBaseUrlMessage="Enter a valid HTTPS URL without credentials, query parameters, or a fragment.";

export function providerBaseUrlError(value:string):string|null{
  try{
    const url=new URL(value.trim());
    return url.protocol==="https:"&&!url.username&&!url.password&&!url.search&&!url.hash
      ?null
      :providerBaseUrlMessage;
  }catch{
    return providerBaseUrlMessage;
  }
}

export function isValidEndpointRequestTimeout(value:number):boolean{
  return Number.isSafeInteger(value)&&value>=1&&value<=600;
}
