export function endpointLocationWithoutFocus(pathname:string,search:string,endpointId:string):string{
  const params=new URLSearchParams(search);
  if(params.get("endpointId")===endpointId)params.delete("endpointId");
  const query=params.toString();
  return query?`${pathname}?${query}`:pathname;
}
