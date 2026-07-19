import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir,mkdtemp,readFile,readdir,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach,describe,it } from "node:test";
import { upgradeProjectFilesWithPool } from "../../packages/api-entry-node/src/upgradeProjectFiles.js";

describe("Project files filesystem upgrade",()=>{
  const roots:string[]=[];
  afterEach(async()=>Promise.all(roots.splice(0).map((root)=>rm(root,{recursive:true,force:true}))));

  it("runs once, resumes a pre-renamed destination, skips new Projects, and chooses an available deterministic name",async()=>{
    const dataRoot=await mkdtemp(path.join(tmpdir(),"asl-project-files-upgrade-"));roots.push(dataRoot);
    const legacy={id:"project_legacy",workspace_id:"workspace",owner_user_id:"owner",root_path:"workspaces/workspace/projects/legacy"};
    const fresh={id:"project_fresh",workspace_id:"workspace",owner_user_id:"owner",root_path:"workspaces/workspace/projects/fresh"};
    const crashed={id:"project_crashed",workspace_id:"workspace",owner_user_id:"owner",root_path:"workspaces/workspace/projects/crashed"};
    await mkdir(path.join(dataRoot,legacy.root_path,"files"),{recursive:true});
    await writeFile(path.join(dataRoot,legacy.root_path,"files","kept.txt"),"kept");
    const crashedLibraryId=`library_project_files_${createHash("sha256").update(crashed.id).digest("hex").slice(0,24)}`;
    const crashedDestination=path.join(dataRoot,crashed.root_path,"libraries",crashedLibraryId,"home");
    await mkdir(crashedDestination,{recursive:true});
    await writeFile(path.join(crashedDestination,"already-moved.txt"),"moved");
    const database=new UpgradeDatabase([legacy,fresh,crashed]);
    database.userLibraryNames.set(legacy.id,["Imported project files","Imported project files (2)"]);

    await upgradeProjectFilesWithPool(database,dataRoot);
    const libraryId=`library_project_files_${createHash("sha256").update(legacy.id).digest("hex").slice(0,24)}`;
    assert.equal(await readFile(path.join(dataRoot,legacy.root_path,"libraries",libraryId,"home","kept.txt"),"utf8"),"kept");
    assert.deepEqual(database.insertedLibraries.map((item)=>item.projectId).sort(),[crashed.id,legacy.id].sort());
    assert.equal(database.insertedLibraries.find((item)=>item.projectId===legacy.id)?.name,"Imported project files (3)");
    assert.equal(await readFile(path.join(crashedDestination,"already-moved.txt"),"utf8"),"moved");
    assert.deepEqual(await readdir(path.join(crashedDestination,"workspace",".artifacts")),[]);

    await mkdir(path.join(dataRoot,fresh.root_path),{recursive:true});
    await upgradeProjectFilesWithPool(database,dataRoot);
    assert.deepEqual(database.insertedLibraries.map((item)=>item.projectId).sort(),[crashed.id,legacy.id].sort());
    assert.equal(database.projectListReads,1);
  });

  it("resumes an existing deterministic Library identity after the source was renamed",async()=>{
    const dataRoot=await mkdtemp(path.join(tmpdir(),"asl-project-files-resume-"));roots.push(dataRoot);
    const project={id:"project_resume",workspace_id:"workspace",owner_user_id:"owner",root_path:"workspaces/workspace/projects/resume"};
    const libraryId=`library_project_files_${createHash("sha256").update(project.id).digest("hex").slice(0,24)}`;
    const destination=path.join(dataRoot,project.root_path,"libraries",libraryId,"home");
    await mkdir(destination,{recursive:true});
    await writeFile(path.join(destination,"moved.txt"),"moved");
    const database=new UpgradeDatabase([project]);
    database.insertedLibraries.push({id:libraryId,projectId:project.id,name:"Existing imported files"});

    await upgradeProjectFilesWithPool(database,dataRoot);

    assert.equal(database.insertedLibraries.length,1);
    assert.deepEqual(await readdir(path.join(destination,"workspace",".artifacts")),[]);
    assert.equal(database.marker,true);
  });
});

class UpgradeDatabase{
  marker=false;projectListReads=0;insertedLibraries:Array<{id:string;projectId:string;name:string}>=[];userLibraryNames=new Map<string,string[]>();
  constructor(private readonly projects:Array<{id:string;workspace_id:string;owner_user_id:string;root_path:string}>){ }
  async connect(){return new UpgradeClient(this)}
  async query(sql:string,values:unknown[]=[]):Promise<{rows:any[]}>{
    const normalized=sql.replace(/\s+/g," ").trim().toLowerCase();
    if(normalized.startsWith("select checksum from agentsmith_migrations"))return{rows:this.marker?[{checksum:"filesystem-v1"}]:[]};
    if(normalized.startsWith("select id,workspace_id,owner_user_id,root_path from projects")){this.projectListReads+=1;return{rows:this.projects};}
    if(normalized.startsWith("select id from projects"))return{rows:[{id:values[0]}]};
    if(normalized.startsWith("select id,workspace_id,project_id,name,root_sub_path from file_libraries"))return{rows:this.insertedLibraries.filter((item)=>item.id===values[0]).map((item)=>({...item,workspace_id:"workspace",project_id:item.projectId,root_sub_path:`libraries/${item.id}/home`}))};
    if(normalized.startsWith("select name from file_libraries"))return{rows:[...(this.userLibraryNames.get(String(values[0]))??[]),...this.insertedLibraries.filter((item)=>item.projectId===values[0]).map((item)=>item.name)].map((name)=>({name}))};
    if(normalized.startsWith("insert into file_libraries")){const projectId=String(values[2]),name=String(values[4]);if(this.userLibraryNames.get(projectId)?.some((item)=>item.trim().toLowerCase()===name.trim().toLowerCase()))throw new Error("duplicate Library name");this.insertedLibraries.push({id:String(values[0]),projectId,name});return{rows:[]};}
    if(normalized.startsWith("insert into agentsmith_migrations")){this.marker=true;return{rows:[]};}
    if(["begin","commit","rollback"].includes(normalized))return{rows:[]};
    throw new Error(`Unexpected SQL: ${sql}`);
  }
}
class UpgradeClient{constructor(private readonly database:UpgradeDatabase){}query(sql:string,values?:unknown[]){return this.database.query(sql,values)}release(){} }
