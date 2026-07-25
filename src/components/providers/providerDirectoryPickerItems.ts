export function providerDirectoryPickerItems<T extends {id:string}>(page:T[],pinned:Array<T|undefined>):T[]{
  const items=new Map<string,T>();
  for(const item of pinned)if(item&&!items.has(item.id))items.set(item.id,item);
  for(const item of page)if(!items.has(item.id))items.set(item.id,item);
  return [...items.values()];
}
