import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type {
	AgentSessionEvent,
	AgentSessionEventListener,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import { radiusPresence } from "./radius.ts";
import { createRpcProcessInstance, type RpcProcessInstance } from "./rpc-process.ts";
import { getInstance, loadInstances, removeInstance, saveInstances, upsertInstance } from "./storage.ts";
import type { InstanceRecord, InstanceStatus } from "./types.ts";

interface LiveInstanceResources {
	rpcProcess?: RpcProcessInstance;
	radiusPiId?: string;
	sessionId?: string;
}

interface LiveInstance {
	record: InstanceRecord;
	resources: LiveInstanceResources;
	subscribers: Set<AgentSessionEventListener>;
	uiRequestSubscribers: Set<(request: RpcExtensionUIRequest) => void>;
	unsubscribeEvents?: () => void;
	unsubscribeExit?: () => void;
}

type GetMessagesResponse = Extract<RpcResponse, { command: "get_messages"; success: true }>;

const LEGACY_ACTIVE_STATUSES = new Set<string>(["online", "starting", "stopping", "ready", "running"]);

function cloneInstance(record: InstanceRecord): InstanceRecord {
	return { ...record };
}

// Only refresh persisted session metadata after commands that can plausibly change
// the instance identity/details we store in instances.json. Most RPCs mutate transient
// runtime state only, so forcing a follow-up get_state after every command is wasted IO.
//
// - new_session / switch_session / fork / clone can change sessionId/sessionFile
// - set_session_name changes a persisted session detail we may want reflected externally
// - prompt can materialize or advance persisted session state after the child processes it
const SESSION_METADATA_COMMANDS: ReadonlySet<RpcCommand["type"]> = new Set([
	"new_session",
	"switch_session",
	"fork",
	"clone",
	"set_session_name",
	"prompt",
]);

function shouldRefreshSessionMetadata(command: RpcCommand): boolean {
	return SESSION_METADATA_COMMANDS.has(command.type);
}

function isGetStateSuccess(
	response: RpcResponse,
): response is Extract<
	RpcResponse,
	{ success: true; command: "get_state"; data: { sessionId: string; sessionFile?: string } }
> {
	return response.success === true && response.command === "get_state" && "data" in response;
}

export class ServerSupervisor {
	private readonly liveInstances = new Map<string, LiveInstance>();

	private setStatus(live: LiveInstance, status: InstanceStatus): void {
		live.record = {
			...live.record,
			status,
			lastSeenAt: new Date().toISOString(),
		};
		upsertInstance(live.record);
	}

	private updateRecord(live: LiveInstance, updates: Partial<InstanceRecord>): void {
		live.record = {
			...live.record,
			...updates,
			lastSeenAt: new Date().toISOString(),
		};
		if (updates.radiusPiId !== undefined) {
			live.resources.radiusPiId = updates.radiusPiId;
		}
		if (updates.sessionId !== undefined) {
			live.resources.sessionId = updates.sessionId;
		}
		upsertInstance(live.record);
	}

	private clearBindings(live: LiveInstance): void {
		live.unsubscribeEvents?.();
		live.unsubscribeExit?.();
		live.unsubscribeEvents = undefined;
		live.unsubscribeExit = undefined;
		live.resources.rpcProcess?.setUiRequestHandler(undefined);
	}

	private bindRpcProcess(live: LiveInstance, rpcProcess: RpcProcessInstance): void {
		this.clearBindings(live);
		live.resources.rpcProcess = rpcProcess;
		live.unsubscribeEvents = rpcProcess.onEvent((event) => {
			this.handleSessionEvent(live, event);
			for (const subscriber of live.subscribers) {
				subscriber(event);
			}
		});
		live.unsubscribeExit = rpcProcess.onExit((error) => {
			void this.handleUnexpectedRpcExit(live, error);
		});
		rpcProcess.setUiRequestHandler((request) => {
			for (const subscriber of live.uiRequestSubscribers) subscriber(request);
		});
	}

	private handleSessionEvent(live: LiveInstance, event: AgentSessionEvent): void {
		if (event.type === "agent_start") {
			this.setStatus(live, "running");
			return;
		}
		if (event.type !== "agent_end" || event.willRetry) return;
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (assistant?.role === "assistant" && assistant.stopReason === "error") {
			this.setStatus(live, "failed");
		} else if (assistant?.role === "assistant" && assistant.stopReason === "aborted") {
			this.setStatus(live, "ready");
		} else {
			this.setStatus(live, "completed");
		}
		void this.syncInstanceRecord(live).catch((error) => {
			console.error(`Failed to persist session metadata for ${live.record.id}: ${String(error)}`);
		});
	}

	private async handleUnexpectedRpcExit(live: LiveInstance, _error?: Error): Promise<void> {
		if (this.liveInstances.get(live.record.id) !== live) {
			return;
		}
		if (live.record.status === "stopped") {
			return;
		}
		this.setStatus(live, "failed");
		this.clearBindings(live);
		live.resources.rpcProcess = undefined;
		if (live.resources.radiusPiId) {
			try {
				await radiusPresence.disconnectPi(live.record);
				this.updateRecord(live, { radiusPiId: undefined });
			} catch (error) {
				console.error(`Failed to disconnect Radius Pi ${live.record.id}: ${String(error)}`);
			}
		}
		this.liveInstances.delete(live.record.id);
	}

	private getRpcProcess(live: LiveInstance): RpcProcessInstance | undefined {
		return live.resources.rpcProcess;
	}

	private async syncInstanceRecord(live: LiveInstance): Promise<void> {
		const rpcProcess = this.getRpcProcess(live);
		if (!rpcProcess) {
			this.updateRecord(live, {});
			return;
		}
		const response = await rpcProcess.send({ type: "get_state" });
		if (!isGetStateSuccess(response)) {
			this.updateRecord(live, {});
			return;
		}
		this.updateRecord(live, {
			sessionId: response.data.sessionId,
			sessionFile: response.data.sessionFile,
		});
	}

	private async cleanupAcquiredResources(live: LiveInstance): Promise<void> {
		const rpcProcess = live.resources.rpcProcess;
		this.clearBindings(live);
		if (live.resources.radiusPiId) {
			await radiusPresence.disconnectPi(live.record);
			live.resources.radiusPiId = undefined;
			live.record = {
				...live.record,
				radiusPiId: undefined,
				lastSeenAt: new Date().toISOString(),
			};
		}
		live.resources.sessionId = undefined;
		if (rpcProcess) {
			live.resources.rpcProcess = undefined;
			await rpcProcess.dispose();
		}
	}

	private async failSpawn(live: LiveInstance, error: unknown): Promise<never> {
		this.setStatus(live, "failed");
		try {
			await this.cleanupAcquiredResources(live);
		} finally {
			this.liveInstances.delete(live.record.id);
		}
		throw error;
	}

	private validateStoredSession(record: InstanceRecord): string | undefined {
		if (!record.sessionFile) return undefined;
		if (!existsSync(resolve(record.sessionFile))) return undefined;
		const sessionFile = realpathSync(resolve(record.sessionFile));
		if (!statSync(sessionFile).isFile() || extname(sessionFile).toLowerCase() !== ".jsonl") {
			throw new Error("Stored session is not a Pi JSONL file");
		}
		const descriptor = openSync(sessionFile, "r");
		let text: string;
		try {
			const buffer = Buffer.alloc(64 * 1024);
			const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
			text = buffer.toString("utf8", 0, bytesRead);
		} finally {
			closeSync(descriptor);
		}
		const firstLine = text.split(/\r?\n/).find((line) => line.trim());
		if (!firstLine) throw new Error("Stored session is empty");
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
		if (header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") {
			throw new Error("Stored session has an invalid header");
		}
		const key = (path: string) => (process.platform === "win32" ? path.toLowerCase() : path);
		if (key(realpathSync(resolve(header.cwd))) !== key(realpathSync(resolve(record.cwd)))) {
			throw new Error("Stored session workspace does not match the Deck task");
		}
		if (record.sessionId && header.id !== record.sessionId) {
			throw new Error("Stored session identity does not match the Deck task");
		}
		return sessionFile;
	}

	updateInstance(instance: InstanceRecord): void {
		const live = this.liveInstances.get(instance.id);
		if (live) {
			live.record = instance;
			live.resources.radiusPiId = instance.radiusPiId;
			live.resources.sessionId = instance.sessionId;
		}
		upsertInstance(instance);
	}

	openRpcStream(
		instanceId: string,
		onEvent: (event: AgentSessionEvent) => void,
		onUiRequest: (request: RpcExtensionUIRequest) => void,
	):
		| {
				handleRpc(command: RpcCommand): Promise<RpcResponse>;
				handleUiResponse(response: RpcExtensionUIResponse): void;
				close(): void;
		  }
		| undefined {
		const live = this.liveInstances.get(instanceId);
		const rpcProcess = live ? this.getRpcProcess(live) : undefined;
		if (!live || !rpcProcess) {
			return undefined;
		}
		live.subscribers.add(onEvent);
		live.uiRequestSubscribers.add(onUiRequest);
		return {
			handleRpc: async (command) => {
				const response = await rpcProcess.send(command);
				if (shouldRefreshSessionMetadata(command)) {
					await this.syncInstanceRecord(live);
				}
				return response;
			},
			handleUiResponse: (response) => {
				rpcProcess.handleUiResponse(response);
			},
			close: () => {
				live.uiRequestSubscribers.delete(onUiRequest);
				live.subscribers.delete(onEvent);
			},
		};
	}

	getLiveInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		return live ? cloneInstance(live.record) : undefined;
	}

	listLiveInstances(): InstanceRecord[] {
		return [...this.liveInstances.values()].map((live) => cloneInstance(live.record));
	}

	isInstanceLive(instanceId: string): boolean {
		return this.liveInstances.has(instanceId);
	}

	async recoverAfterRestart(): Promise<void> {
		const recoveredAt = new Date().toISOString();
		const instances = loadInstances().map((instance) => {
			const storedStatus: string = instance.status;
			return {
				...instance,
				status: LEGACY_ACTIVE_STATUSES.has(storedStatus)
					? ("interrupted" as const)
					: storedStatus === "error"
						? ("failed" as const)
						: instance.status,
				lastSeenAt: recoveredAt,
			};
		});
		for (const instance of instances) {
			await radiusPresence.disconnectPi(instance);
		}
		saveInstances(instances);
	}

	listInstances(): InstanceRecord[] {
		return loadInstances().map(cloneInstance);
	}

	getInstance(instanceId: string): InstanceRecord | undefined {
		const live = this.liveInstances.get(instanceId);
		if (live) {
			return cloneInstance(live.record);
		}
		const stored = getInstance(instanceId);
		return stored ? cloneInstance(stored) : undefined;
	}

	async spawnInstance(options: { cwd: string; label?: string }): Promise<InstanceRecord> {
		const now = new Date().toISOString();
		const live: LiveInstance = {
			record: {
				id: randomUUID(),
				status: "starting",
				cwd: options.cwd,
				createdAt: now,
				lastSeenAt: now,
				label: options.label,
			},
			resources: {},
			subscribers: new Set(),
			uiRequestSubscribers: new Set(),
		};
		this.liveInstances.set(live.record.id, live);
		upsertInstance(live.record);

		try {
			const rpcProcess = createRpcProcessInstance({ cwd: options.cwd });
			this.bindRpcProcess(live, rpcProcess);
			await this.syncInstanceRecord(live);
			const registeredRecord = await radiusPresence.registerPi(live.record);
			this.updateRecord(live, { radiusPiId: registeredRecord.radiusPiId });
			this.setStatus(live, "ready");
			return cloneInstance(live.record);
		} catch (error) {
			return await this.failSpawn(live, error);
		}
	}

	async stopInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const live = this.liveInstances.get(instanceId);
		if (!live) {
			const stored = getInstance(instanceId);
			if (!stored) return undefined;
			const stopped = { ...stored, status: "stopped" as const, lastSeenAt: new Date().toISOString() };
			upsertInstance(stopped);
			return cloneInstance(stopped);
		}

		await this.cleanupAcquiredResources(live);
		live.record = { ...live.record, status: "stopped", lastSeenAt: new Date().toISOString() };
		upsertInstance(live.record);
		this.liveInstances.delete(instanceId);
		return cloneInstance(live.record);
	}

	async resumeInstance(instanceId: string): Promise<InstanceRecord | undefined> {
		const existing = this.liveInstances.get(instanceId);
		if (existing) return cloneInstance(existing.record);
		const stored = getInstance(instanceId);
		if (!stored) return undefined;
		const sessionFile = this.validateStoredSession(stored);
		const live: LiveInstance = {
			record: { ...stored, status: "starting", lastSeenAt: new Date().toISOString() },
			resources: {},
			subscribers: new Set(),
			uiRequestSubscribers: new Set(),
		};
		this.liveInstances.set(instanceId, live);
		upsertInstance(live.record);
		try {
			const rpcProcess = createRpcProcessInstance({ cwd: stored.cwd });
			this.bindRpcProcess(live, rpcProcess);
			if (sessionFile) {
				const switched = await rpcProcess.send({ type: "switch_session", sessionPath: sessionFile });
				if (!switched.success || switched.command !== "switch_session" || switched.data.cancelled) {
					throw new Error("Pi declined to restore the stored session");
				}
			}
			await this.syncInstanceRecord(live);
			const registeredRecord = await radiusPresence.registerPi(live.record);
			this.updateRecord(live, { radiusPiId: registeredRecord.radiusPiId });
			this.setStatus(live, "ready");
			return cloneInstance(live.record);
		} catch (error) {
			return await this.failSpawn(live, error);
		}
	}

	readInstanceMessages(instanceId: string): GetMessagesResponse["data"]["messages"] | undefined {
		const stored = this.getInstance(instanceId);
		if (!stored) return undefined;
		const sessionFile = this.validateStoredSession(stored);
		if (!sessionFile) return [];
		const manager: SessionManager = PiSessionManager.open(sessionFile, undefined, stored.cwd);
		return manager.getBranch().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	}

	async deleteInstance(instanceId: string): Promise<boolean> {
		const live = this.liveInstances.get(instanceId);
		if (live) {
			await this.cleanupAcquiredResources(live);
			this.liveInstances.delete(instanceId);
		}
		if (!getInstance(instanceId)) return false;
		removeInstance(instanceId);
		return true;
	}

	async handleRpc(instanceId: string, command: RpcCommand): Promise<RpcResponse | undefined> {
		const live = this.liveInstances.get(instanceId);
		const rpcProcess = live ? this.getRpcProcess(live) : undefined;
		if (!live || !rpcProcess) {
			return undefined;
		}

		if (command.type === "prompt" || command.type === "steer" || command.type === "follow_up") {
			this.setStatus(live, "running");
		}
		let response: RpcResponse;
		try {
			response = await rpcProcess.send(command);
		} catch (error) {
			this.setStatus(live, "failed");
			throw error;
		}
		if (shouldRefreshSessionMetadata(command)) {
			await this.syncInstanceRecord(live);
		}
		return response;
	}

	async shutdown(): Promise<void> {
		for (const [instanceId, live] of [...this.liveInstances]) {
			const interrupted =
				live.record.status === "starting" || live.record.status === "ready" || live.record.status === "running";
			live.record = {
				...live.record,
				status: interrupted ? "interrupted" : live.record.status,
				lastSeenAt: new Date().toISOString(),
			};
			upsertInstance(live.record);
			await this.cleanupAcquiredResources(live);
			this.liveInstances.delete(instanceId);
		}
	}
}

export const supervisor = new ServerSupervisor();

radiusPresence.setCoordinator({
	getLiveInstance(instanceId) {
		return supervisor.getLiveInstance(instanceId);
	},
	listLiveInstances() {
		return supervisor.listLiveInstances();
	},
	updateInstance(instance) {
		supervisor.updateInstance(instance);
	},
});
