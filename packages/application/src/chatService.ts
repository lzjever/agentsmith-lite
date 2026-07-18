import type { ChatMessage, ChatResponse, ModelEndpoint, ProjectChatMessage, ProjectChatThread } from "../../contracts/src/api.js";
import { NotFoundError, ProductError } from "../../domain/src/errors.js";
import { newId, nowIso } from "../../domain/src/ids.js";
import { requireNonEmptyString } from "../../domain/src/validation.js";
import type { ProductStore } from "../../ports/src/store.js";
import { EndpointService } from "./endpointService.js";
import { ProjectPolicyService } from "./projectPolicyService.js";
import { WorkspaceService } from "./workspaceService.js";
import { CredentialService } from "./credentialService.js";
import { OpenAIProviderBroker } from "./openAIProviderBroker.js";
import { runIdempotentMutation } from "./idempotentMutation.js";
import { ContextService } from "./contextService.js";

export interface ProjectChatSendResult {
  message: ProjectChatMessage;
  endpointSnapshot: ChatResponse["endpointSnapshot"];
}

const THREAD_TITLE_MAX_LENGTH = 200;

function requireChatEndpoint(endpoint: ModelEndpoint): void {
  if (!endpoint.capabilities.includes("text")) throw new ProductError("Chat endpoint must support the text capability", 409);
}

export class ChatService {
  constructor(
    private readonly store: ProductStore,
    private readonly workspaces: WorkspaceService,
    private readonly endpointService: EndpointService,
    private readonly client: OpenAIProviderBroker,
    private readonly credentials: CredentialService,
    private readonly policies: ProjectPolicyService,
    private readonly contexts: ContextService
  ) {}

  async listThreads(userId: string, projectId: string): Promise<ProjectChatThread[]> {
    await this.workspaces.requireProjectForUser(userId, projectId, "view");
    return this.store.listProjectChatThreads(projectId, userId);
  }

  async searchThreads(userId: string, projectId: string, query: string): Promise<ProjectChatThread[]> {
    await this.workspaces.requireProjectForUser(userId, projectId, "view");
    return this.store.searchProjectChatThreads(projectId, userId, query);
  }

  async createThread(userId: string, projectId: string, endpointId: string, idempotencyKey?: string): Promise<ProjectChatThread> {
    const normalizedEndpointId=requireNonEmptyString(endpointId,"chat.endpointId");
    await this.workspaces.requireProjectForUser(userId,projectId,"write");
    const create=async(id:string)=>{requireChatEndpoint(await this.endpointService.requireCredentialEndpointForUser(userId,projectId,normalizedEndpointId));const existing=await this.store.findProjectChatThread(id);if(existing&&existing.projectId===projectId&&existing.ownerUserId===userId)return existing;const timestamp=nowIso();const thread=await this.store.createProjectChatThread({id,projectId,ownerUserId:userId,endpointId:normalizedEndpointId,title:null,pinnedAt:null,starredAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp});await this.policies.recordOperation(projectId,userId,"chat.thread.create","accepted",thread.id);return thread;};
    if(!idempotencyKey)return create(newId("chat"));
    return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.chat-thread.create",key:idempotencyKey,request:{projectId,endpointId:normalizedEndpointId},resourceId:newId("chat"),failureMessage:"Conversation could not be created",run:create});
  }

  async updateThreadMetadata(userId: string, projectId: string, threadId: string, input: { title?: string | null; pinned?: boolean; starred?: boolean }, idempotencyKey?: string): Promise<ProjectChatThread> {
    await this.workspaces.requireProjectForUser(userId, projectId, "write");
    const update = async () => {
      const thread = await this.requireThreadForUser(userId, projectId, threadId, "write");
      const title = input.title === undefined ? thread.title ?? null : normalizeThreadTitle(input.title);
      const pinnedAt = input.pinned === undefined ? thread.pinnedAt ?? null : input.pinned ? nowIso() : null;
      const starredAt = input.starred === undefined ? thread.starredAt ?? null : input.starred ? nowIso() : null;
      const updated = await this.store.updateProjectChatThreadMetadata(thread.id, { title, pinnedAt, starredAt }, nowIso());
      if (!updated) throw new NotFoundError("Chat thread not found");
      await this.policies.recordOperation(projectId, userId, "chat.thread.update", "accepted", thread.id);
      return updated;
    };
    if (!idempotencyKey) return update();
    return runIdempotentMutation({ store: this.store, actorId: userId, scopeId: projectId, operation: "project.chat-thread.update", key: idempotencyKey, request: { threadId, input }, resourceId: threadId, failureMessage: "Conversation could not be updated", run: update });
  }

  async deleteThread(userId: string, projectId: string, threadId: string, idempotencyKey?: string): Promise<{ deleted: true }> {
    await this.workspaces.requireProjectForUser(userId, projectId, "write");
    const remove = async () => {
      const thread = await this.requireThreadForUser(userId, projectId, threadId, "write");
      const deleted=await this.store.deleteProjectChatThread(thread.id,nowIso());
      if(deleted==="request_running")throw new ProductError("Stop the active response before deleting this conversation",409);
      if(!deleted)throw new NotFoundError("Chat thread not found");
      await this.policies.recordOperation(projectId, userId, "chat.thread.delete", "accepted", thread.id);
      return { deleted: true as const };
    };
    if (!idempotencyKey) return remove();
    return runIdempotentMutation({ store: this.store, actorId: userId, scopeId: projectId, operation: "project.chat-thread.delete", key: idempotencyKey, request: { threadId }, resourceId: threadId, failureMessage: "Conversation could not be deleted", run: remove });
  }

  async listMessages(userId: string, projectId: string, threadId: string): Promise<ProjectChatMessage[]> {
    await this.requireThreadForUser(userId, projectId, threadId, "view");
    await this.recoverPendingResponses(threadId);
    return this.store.listProjectChatMessages(threadId);
  }

  async sendMessage(userId: string, projectId: string, threadId: string, content: string, afterMessageId: string | null = null): Promise<ProjectChatSendResult> {
    return this.streamMessage(userId, projectId, threadId, content, afterMessageId, undefined, () => undefined);
  }
  async streamMessage(userId: string, projectId: string, threadId: string, content: string, afterMessageId: string | null, signal: AbortSignal | undefined, onDelta: (value: string) => void): Promise<ProjectChatSendResult> {
    const thread = await this.requireThreadForUser(userId, projectId, threadId, "write");
    const text = requireNonEmptyString(content, "chat.content");
    const endpoint = await this.endpointService.requireCredentialEndpointForUser(userId, projectId, requireThreadEndpointId(thread));
    requireChatEndpoint(endpoint);
    await this.recoverPendingResponses(thread.id);
    const history = await this.store.listProjectChatMessages(thread.id);
    const latest = history.at(-1);
    if (latest?.role === "user" && (latest.deliveryStatus === "failed" || latest.deliveryStatus === "stopped")) {
      throw new ProductError("Retry, edit, or delete the failed message before continuing", 409);
    }
    const credential = await this.credentials.resolve(projectId, endpoint.credentialId);
    const context = await this.contexts.resolveForAgent(userId, projectId);
    const input = withAgentContext(context, [...history.map(({ role, content: saved }) => ({ role, content: saved })), { role: "user", content: text }]);
    let responseStaged = false;
    let userMessage: ProjectChatMessage | undefined;
    try {
      const timestamp = nowIso();
      userMessage = { id: newId("chatmsg"), threadId: thread.id, sequence:(history.at(-1)?.sequence??0)+1,version:1,deliveryStatus:"pending",role: "user", content: text, createdAt: timestamp,updatedAt:timestamp };
      const admission=await this.store.appendProjectChatMessageIfCurrent(thread.id,afterMessageId,userMessage,text.slice(0,40));
      if(admission==="request_running")throw new ProductError("A chat request is already running",409);
      if(admission==="history_changed")throw new ProductError("Chat history changed; reload and try again",409);
      await this.policies.recordOperation(projectId,userId,"chat.message.send","accepted",userMessage.id);
      const response = await this.client.streamChat({ endpoint, settlementEndpointId: endpoint.id, apiKey: credential.apiKey, actorId: userId, ...(signal ? { signal } : {}), onDelta }, input);
      const assistantMessage: ProjectChatMessage = { id: newId("chatmsg"), threadId: thread.id,sequence:userMessage.sequence+1,version:1,deliveryStatus:"completed",role: "assistant", content: response.message.content, createdAt: timestamp,updatedAt:timestamp };
      if(!await this.store.stageProjectChatResponse(userMessage.id,assistantMessage))throw new Error("Chat response could not be staged");
      responseStaged=true;
      const finalized=await this.store.finalizeProjectChatResponse(userMessage.id);if(!finalized)throw new Error("Chat response could not be finalized");
      await this.store.touchProjectChatThread(thread.id, timestamp);
      return { message: finalized, endpointSnapshot: response.endpointSnapshot };
    } catch (error) {
      if(userMessage&&!responseStaged)await this.store.updateProjectChatMessageDelivery(userMessage.id,isAbortError(error)?"stopped":"failed",nowIso());
      if(isAbortError(error)&&userMessage)await this.policies.recordOperation(projectId,userId,"chat.message.stop","accepted",userMessage.id);
      throw error;
    }
  }

  async editMessage(userId:string,projectId:string,threadId:string,messageId:string,expectedVersion:number,content:string,idempotencyKey?:string):Promise<ProjectChatMessage>{const normalized=requireNonEmptyString(content,"chat.content");await this.workspaces.requireProjectForUser(userId,projectId,"write");const edit=async()=>{await this.requireThreadForUser(userId,projectId,threadId,"write");const messages=await this.store.listProjectChatMessages(threadId);const target=requireMessage(messages,messageId,expectedVersion);if(target.role!=="user")throw new ProductError("Only user messages can be edited",409);if(normalized===target.content)return target;const updated=await this.store.editProjectChatMessageAndTruncate(threadId,messageId,expectedVersion,normalized,nowIso());if(!updated)throw new ProductError("Chat history changed; reload and try again",409);await this.store.touchProjectChatThread(threadId,nowIso());await this.policies.recordOperation(projectId,userId,"chat.message.edit","accepted",messageId);return updated;};if(!idempotencyKey)return edit();return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.chat-message.edit",key:idempotencyKey,request:{threadId,messageId,expectedVersion,content:normalized},resourceId:messageId,failureMessage:"Message could not be edited",run:edit});}
  async deleteMessage(userId:string,projectId:string,threadId:string,messageId:string,expectedVersion:number,idempotencyKey?:string):Promise<{deleted:true}>{await this.workspaces.requireProjectForUser(userId,projectId,"write");const remove=async()=>{await this.requireThreadForUser(userId,projectId,threadId,"write");const messages=await this.store.listProjectChatMessages(threadId);requireMessage(messages,messageId,expectedVersion);if(!await this.store.deleteProjectChatMessageAndFollowing(threadId,messageId,expectedVersion))throw new ProductError("Chat history changed; reload and try again",409);await this.store.touchProjectChatThread(threadId,nowIso());await this.policies.recordOperation(projectId,userId,"chat.message.delete","accepted",messageId);return{deleted:true as const};};if(!idempotencyKey)return remove();return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.chat-message.delete",key:idempotencyKey,request:{threadId,messageId,expectedVersion},resourceId:messageId,failureMessage:"Message could not be deleted",run:remove});}
  async branchMessage(userId:string,projectId:string,threadId:string,messageId:string,expectedVersion:number,idempotencyKey?:string):Promise<ProjectChatThread>{
    await this.workspaces.requireProjectForUser(userId,projectId,"write");
    const branch=async(branchId:string)=>{
      const source=await this.requireThreadForUser(userId,projectId,threadId,"write");
      const messages=await this.store.listProjectChatMessages(threadId);
      const target=requireMessage(messages,messageId,expectedVersion);
      if(target.deliveryStatus!=="completed")throw new ProductError("Only completed history can be branched",409);
      const copiedMessages=messages.filter((message)=>message.sequence<=target.sequence);
      const existing=await this.store.findProjectChatThread(branchId);
      if(existing){
        const existingMessages=await this.store.listProjectChatMessages(branchId);
        if(existing.projectId===projectId&&existing.ownerUserId===userId&&!existing.deletedAt&&existingMessages.length===copiedMessages.length)return existing;
        throw new ProductError("Conversation branch is incomplete; create a new branch",409);
      }
      const timestamp=nowIso();
      const created=await this.store.createProjectChatBranch(
        {id:branchId,projectId,ownerUserId:userId,endpointId:source.endpointId,title:branchThreadTitle(source.title),pinnedAt:null,starredAt:null,deletedAt:null,createdAt:timestamp,updatedAt:timestamp},
        copiedMessages.map((message,index)=>({...message,id:newId("chatmsg"),threadId:branchId,sequence:index+1,version:1,deliveryStatus:"completed",createdAt:timestamp,updatedAt:timestamp}))
      );
      await this.policies.recordOperation(projectId,userId,"chat.message.branch","accepted",messageId);
      return created;
    };
    if(!idempotencyKey)return branch(newId("chat"));
    return runIdempotentMutation({store:this.store,actorId:userId,scopeId:projectId,operation:"project.chat-message.branch",key:idempotencyKey,request:{threadId,messageId,expectedVersion},resourceId:newId("chat"),failureMessage:"Conversation could not be branched",run:branch});
  }
  async retryMessage(userId:string,projectId:string,threadId:string,messageId:string,expectedVersion:number,signal:AbortSignal|undefined,onDelta:(value:string)=>void):Promise<ProjectChatSendResult>{
    const thread=await this.requireThreadForUser(userId,projectId,threadId,"write");await this.recoverPendingResponses(threadId);const history=await this.store.listProjectChatMessages(threadId);const target=requireMessage(history,messageId,expectedVersion);
    if(target.role!=="user"||!(["failed","stopped"] as const).includes(target.deliveryStatus as "failed"|"stopped"))throw new ProductError("Only a failed or stopped user message can be retried",409);if(history.at(-1)?.id!==target.id)throw new ProductError("Only the latest message can be retried",409);
    const endpoint=await this.endpointService.requireCredentialEndpointForUser(userId,projectId,requireThreadEndpointId(thread));requireChatEndpoint(endpoint);const credential=await this.credentials.resolve(projectId,endpoint.credentialId);
    const context=await this.contexts.resolveForAgent(userId,projectId);const input=withAgentContext(context,history.map(({role,content})=>({role,content})));
    const claimed=await this.store.claimProjectChatMessageRetry(target.id,expectedVersion,nowIso());if(!claimed)throw new ProductError("Chat history changed; reload and try again",409);
    let responseStaged=false;await this.policies.recordOperation(projectId,userId,"chat.message.retry","accepted",target.id);
    try{const response=await this.client.streamChat({endpoint,settlementEndpointId:endpoint.id,apiKey:credential.apiKey,actorId:userId,...(signal?{signal}:{}),onDelta},input);const timestamp=nowIso();const assistant:ProjectChatMessage={id:newId("chatmsg"),threadId,sequence:target.sequence+1,version:1,deliveryStatus:"completed",role:"assistant",content:response.message.content,createdAt:timestamp,updatedAt:timestamp};if(!await this.store.stageProjectChatResponse(target.id,assistant))throw new Error("Chat response could not be staged");responseStaged=true;const finalized=await this.store.finalizeProjectChatResponse(target.id);if(!finalized)throw new Error("Chat response could not be finalized");await this.store.touchProjectChatThread(threadId,timestamp);return{message:finalized,endpointSnapshot:response.endpointSnapshot};}
    catch(error){if(!responseStaged)await this.store.updateProjectChatMessageDelivery(target.id,isAbortError(error)?"stopped":"failed",nowIso());if(isAbortError(error))await this.policies.recordOperation(projectId,userId,"chat.message.stop","accepted",target.id);throw error;}
  }

  private async recoverPendingResponses(threadId:string):Promise<void>{const messages=await this.store.listProjectChatMessages(threadId);for(const message of messages){if(message.role==="user"&&message.deliveryStatus==="response_pending"){const finalized=await this.store.finalizeProjectChatResponse(message.id);if(!finalized)throw new Error("Pending chat response could not be recovered");}}}

  private async requireThreadForUser(userId: string, projectId: string, threadId: string, permission: "view" | "write"): Promise<ProjectChatThread> {
    await this.workspaces.requireProjectForUser(userId, projectId, permission);
    const thread = await this.store.findProjectChatThread(threadId);
    if (!thread || thread.projectId !== projectId || thread.ownerUserId !== userId || thread.deletedAt) throw new NotFoundError("Chat thread not found");
    return thread;
  }
}

function requireMessage(messages:ProjectChatMessage[],messageId:string,expectedVersion:number):ProjectChatMessage{const message=messages.find((item)=>item.id===messageId);if(!message)throw new NotFoundError("Chat message not found");if(!Number.isInteger(expectedVersion)||message.version!==expectedVersion)throw new ProductError("Chat history changed; reload and try again",409);return message;}
function requireThreadEndpointId(thread: ProjectChatThread): string { if (!thread.endpointId) throw new ProductError("Chat thread endpoint has been deleted", 409); return thread.endpointId; }
function isAbortError(error:unknown):boolean{return error instanceof Error&&error.name==="AbortError";}

function withAgentContext(context: string, messages: ChatMessage[]): ChatMessage[] {
  return context ? [{ role: "system", content: context }, ...messages] : messages;
}

function normalizeThreadTitle(value: string | null): string | null {
  if (value === null) return null;
  const title = value.trim();
  if (title.length > THREAD_TITLE_MAX_LENGTH) throw new ProductError(`chat.title must be at most ${THREAD_TITLE_MAX_LENGTH} characters`, 400);
  return title || null;
}

function branchThreadTitle(value: string | null | undefined): string {
  if (!value) return "Branched conversation";
  const suffix = " branch";
  return `${value.slice(0, THREAD_TITLE_MAX_LENGTH - suffix.length)}${suffix}`;
}
