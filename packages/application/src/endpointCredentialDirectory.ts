import { ProductError } from "../../domain/src/errors.js";

export const DEFAULT_PROVIDER_DIRECTORY_LIMIT=20;
export const MAX_PROVIDER_DIRECTORY_LIMIT=50;

export interface ProviderDirectoryScope {
  actorId:string;
  projectId:string;
  kind:"credentials"|"endpoints"|"endpoint-usage";
  q:string;
  mode:string|null;
}

export interface ProviderDirectoryAfter {createdAt:string;id:string}

export function providerDirectoryLimit(value:number|undefined):number{
  if(value===undefined)return DEFAULT_PROVIDER_DIRECTORY_LIMIT;
  if(!Number.isInteger(value)||value<1||value>MAX_PROVIDER_DIRECTORY_LIMIT)throw new ProductError(`limit must be between 1 and ${MAX_PROVIDER_DIRECTORY_LIMIT}`,400);
  return value;
}

export function normalizeProviderDirectoryQuery(value:string|undefined):string{
  const q=value?.trim().toLowerCase()??"";
  if(q.length>160)throw new ProductError("q must be 160 characters or less",400);
  if(/[\u0000-\u001f\u007f]/u.test(q))throw new ProductError("q must not contain control characters",400);
  return q;
}

export function encodeProviderDirectoryCursor(scope:ProviderDirectoryScope,after:ProviderDirectoryAfter):string{
  return Buffer.from(JSON.stringify({v:1,...scope,after}),"utf8").toString("base64url");
}

export function decodeProviderDirectoryCursor(cursor:string,scope:ProviderDirectoryScope):ProviderDirectoryAfter{
  const invalid=()=>new ProductError("Provider directory cursor is invalid",400);
  if(cursor.length===0||cursor.length>4096)throw invalid();
  let value:unknown;
  try{value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"))}catch{throw invalid()}
  if(!record(value)||!keys(value,["v","actorId","projectId","kind","q","mode","after"])||value.v!==1||!record(value.after))throw invalid();
  if(!keys(value.after,["createdAt","id"])||typeof value.after.createdAt!=="string"||typeof value.after.id!=="string")throw invalid();
  const after={createdAt:value.after.createdAt,id:value.after.id};
  const timestamp=Date.parse(after.createdAt);
  if(!Number.isFinite(timestamp)||new Date(timestamp).toISOString()!==after.createdAt||after.id.length===0||after.id.length>1024||/[\u0000-\u001f\u007f]/u.test(after.id))throw invalid();
  const canonical={v:1,...scope,after};
  if(JSON.stringify(value)!==JSON.stringify(canonical)||encodeProviderDirectoryCursor(scope,after)!==cursor)throw invalid();
  return after;
}

function record(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value)}
function keys(value:Record<string,unknown>,expected:string[]):boolean{const actual=Object.keys(value);return actual.length===expected.length&&expected.every((key,index)=>actual[index]===key)}
