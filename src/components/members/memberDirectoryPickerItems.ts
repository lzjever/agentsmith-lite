export function memberDirectoryPickerItems<T extends {userId:string}>({
  page,
  pinned,
  selected,
  excludeUserId
}:{
  page:T[];
  pinned:T[];
  selected?:T;
  excludeUserId?:string;
}):T[]{
  const items:T[]=[];
  const seen=new Set<string>();
  for(const item of [...pinned,...(selected?[selected]:[]),...page]){
    if(item.userId===excludeUserId||seen.has(item.userId))continue;
    seen.add(item.userId);
    items.push(item);
  }
  return items;
}
