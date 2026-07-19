import { createHash } from "node:crypto";
import { lstat,mkdir,readdir,rename,rmdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require=createRequire(import.meta.url);
const {Pool}=require("pg") as {Pool:new(input:{connectionString:string})=>UpgradePool&{end():Promise<void>}};
const UPGRADE_ID="app_061_project_files_filesystem";
const UPGRADE_CHECKSUM="filesystem-v1";

interface ProjectRow{id:string;workspace_id:string;owner_user_id:string;root_path:string;}
interface LibraryRow{id:string;workspace_id:string;project_id:string;name:string;root_sub_path:string;}
interface UpgradeClient{query<T=Record<string,unknown>>(sql:string,values?:unknown[]):Promise<{rows:T[]}>;release():void;}
export interface UpgradePool{connect():Promise<UpgradeClient>;}

export async function upgradeProjectFiles(connectionString:string,dataRoot:string):Promise<void>{
  if(!connectionString.trim())throw new Error("POSTGRES_APP_URL is required");
  const pool=new Pool({connectionString});
  try{await upgradeProjectFilesWithPool(pool,dataRoot);}finally{await pool.end();}
}

export async function upgradeProjectFilesWithPool(pool:UpgradePool,dataRoot:string):Promise<void>{
  if(await upgradeApplied(pool))return;
  const client=await pool.connect();
  let projects:ProjectRow[];
  try{projects=(await client.query<ProjectRow>("select id,workspace_id,owner_user_id,root_path from projects order by id")).rows;}finally{client.release();}
  const resolvedDataRoot=path.resolve(dataRoot);
  for(const project of projects)await upgradeProject(pool,project,resolvedDataRoot);
  await markUpgradeApplied(pool);
}

async function upgradeApplied(pool:UpgradePool):Promise<boolean>{
  const client=await pool.connect();
  try{
    const row=(await client.query<{checksum:string}>("select checksum from agentsmith_migrations where id=$1",[UPGRADE_ID])).rows[0];
    if(row&&row.checksum!==UPGRADE_CHECKSUM)throw new Error(`Project files upgrade checksum mismatch: ${row.checksum}`);
    return Boolean(row);
  }finally{client.release();}
}

async function markUpgradeApplied(pool:UpgradePool):Promise<void>{
  const client=await pool.connect();
  try{await client.query("insert into agentsmith_migrations(id,checksum) values($1,$2) on conflict (id) do nothing",[UPGRADE_ID,UPGRADE_CHECKSUM]);}finally{client.release();}
}

async function upgradeProject(pool:UpgradePool,project:ProjectRow,dataRoot:string):Promise<void>{
  const projectRoot=path.resolve(dataRoot,project.root_path);
  assertInside(dataRoot,projectRoot);
  const source=path.resolve(projectRoot,"files");
  const id=`library_project_files_${createHash("sha256").update(project.id).digest("hex").slice(0,24)}`;
  const rootSubPath=`libraries/${id}/home`;
  const destination=path.resolve(projectRoot,rootSubPath);
  assertInside(projectRoot,source);assertInside(projectRoot,destination);
  const sourceState=await directoryState(source),destinationState=await directoryState(destination);
  const hasMigratedIdentity=sourceState!=="missing"&&sourceState!=="empty"||destinationState!=="missing";
  const library=await ensureImportedLibrary(pool,project,id,rootSubPath,hasMigratedIdentity);
  if(!library){if(sourceState==="empty")await rmdir(source);return;}

  if(sourceState==="nonempty"){
    if(destinationState==="missing"){
      await mkdir(path.dirname(destination),{recursive:true});
      await rename(source,destination);
    }else if(destinationState==="empty"){
      await rmdir(destination);
      await rename(source,destination);
    }else{
      throw new Error(`Legacy files and imported files Library both contain data for ${project.id}`);
    }
  }else if(sourceState==="empty")await rmdir(source);
  await mkdir(path.join(destination,"workspace",".artifacts"),{recursive:true});
}

async function ensureImportedLibrary(pool:UpgradePool,project:ProjectRow,id:string,rootSubPath:string,createIfMissing:boolean):Promise<LibraryRow|null>{
  const client=await pool.connect();
  try{
    await client.query("begin");
    await client.query("select id from projects where id=$1 for update",[project.id]);
    const existing=(await client.query<LibraryRow>("select id,workspace_id,project_id,name,root_sub_path from file_libraries where id=$1 for update",[id])).rows;
    if(existing.some((row)=>row.workspace_id!==project.workspace_id||row.project_id!==project.id||row.root_sub_path!==rootSubPath))throw new Error(`Imported files Library identity conflict for ${project.id}`);
    if(existing[0]){await client.query("commit");return existing[0];}
    if(!createIfMissing){await client.query("commit");return null;}
    const names=(await client.query<{name:string}>("select name from file_libraries where project_id=$1 for update",[project.id])).rows.map((row)=>row.name);
    const name=availableImportName(names);
    await client.query("insert into file_libraries(id,workspace_id,project_id,root_sub_path,name,created_by_user_id,created_at,updated_at) values($1,$2,$3,$4,$5,$6,now(),now())",[id,project.workspace_id,project.id,rootSubPath,name,project.owner_user_id]);
    await client.query("commit");
    return{id,workspace_id:project.workspace_id,project_id:project.id,name,root_sub_path:rootSubPath};
  }catch(error){await client.query("rollback");throw error;}finally{client.release();}
}

function availableImportName(existing:string[]):string{
  const names=new Set(existing.map((name)=>name.trim().toLocaleLowerCase("en-US")));
  const base="Imported project files";
  if(!names.has(base.toLowerCase()))return base;
  for(let suffix=2;;suffix+=1){const candidate=`${base} (${suffix})`;if(!names.has(candidate.toLowerCase()))return candidate;}
}

async function directoryState(directory:string):Promise<"missing"|"empty"|"nonempty">{
  try{const stat=await lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error(`Expected ordinary directory: ${directory}`);return(await readdir(directory)).length===0?"empty":"nonempty";}catch(error){if(error instanceof Error&&"code" in error&&(error as NodeJS.ErrnoException).code==="ENOENT")return"missing";throw error;}
}
function assertInside(root:string,candidate:string):void{const relative=path.relative(root,candidate);if(!relative||relative.startsWith("..")||path.isAbsolute(relative))throw new Error(`Upgrade path escapes its root: ${candidate}`);}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  await upgradeProjectFiles(process.env.POSTGRES_APP_URL??"",process.env.AGENTSMITH_LITE_DATA_DIR??"/data");
}
