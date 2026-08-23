import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { RpcCommand, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

export interface DeckWorkspace {
	id: string;
	name: string;
	path: string;
}

function objectValue(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON body must be an object");
	return value as Record<string, unknown>;
}

function optionalRequestId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
		throw new Error("requestId must be 1-128 safe characters");
	}
	return value;
}

export function createWorkspaceCatalog(paths: string[]): DeckWorkspace[] {
	const seen = new Set<string>();
	const workspaces: DeckWorkspace[] = [];
	for (const input of paths) {
		const path = realpathSync(resolve(input));
		if (!statSync(path).isDirectory()) throw new Error(`Deck workspace is not a directory: ${input}`);
		const key = process.platform === "win32" ? path.toLowerCase() : path;
		if (seen.has(key)) continue;
		seen.add(key);
		workspaces.push({
			id: createHash("sha256").update(key).digest("hex").slice(0, 16),
			name: basename(path) || path,
			path,
		});
	}
	if (workspaces.length === 0) throw new Error("Deck requires at least one --workspace <path>");
	return workspaces;
}

export function parseSpawnBody(value: unknown): { workspaceId: string; label?: string; requestId?: string } {
	const body = objectValue(value);
	if (typeof body.workspaceId !== "string" || !body.workspaceId) throw new Error("workspaceId is required");
	if (body.label !== undefined && (typeof body.label !== "string" || body.label.trim().length > 120)) {
		throw new Error("label must be at most 120 characters");
	}
	return {
		workspaceId: body.workspaceId,
		label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : undefined,
		requestId: optionalRequestId(body.requestId),
	};
}

export function parseRpcBody(value: unknown): { command: RpcCommand; requestId?: string; mutating: boolean } {
	const body = objectValue(value);
	if (typeof body.command !== "string") throw new Error("command is required");
	const requestId = optionalRequestId(body.requestId);
	if (body.command === "get_entries") {
		if (body.since !== undefined && typeof body.since !== "string") throw new Error("since must be a string");
		return { command: { type: "get_entries", since: body.since as string | undefined }, requestId, mutating: false };
	}
	if (body.command === "get_state" || body.command === "get_messages" || body.command === "get_session_stats") {
		return { command: { type: body.command }, requestId, mutating: false };
	}
	if (body.command === "get_available_models" || body.command === "get_available_thinking_levels") {
		return { command: { type: body.command }, requestId, mutating: false };
	}
	if (body.command === "abort") return { command: { type: "abort" }, requestId, mutating: true };
	if (body.command === "abort_retry" || body.command === "compact") {
		return { command: { type: body.command }, requestId, mutating: true };
	}
	if (body.command === "prompt" || body.command === "steer" || body.command === "follow_up") {
		if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 60_000) {
			throw new Error("message must be 1-60000 characters");
		}
		return { command: { type: body.command, message: body.message }, requestId, mutating: true };
	}
	if (body.command === "set_model") {
		if (
			typeof body.provider !== "string" ||
			!body.provider ||
			body.provider.length > 100 ||
			typeof body.modelId !== "string" ||
			!body.modelId ||
			body.modelId.length > 200
		) {
			throw new Error("provider and modelId are required");
		}
		return {
			command: { type: "set_model", provider: body.provider, modelId: body.modelId },
			requestId,
			mutating: true,
		};
	}
	if (body.command === "set_thinking_level") {
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
		const level = levels.find((candidate) => candidate === body.level);
		if (!level) throw new Error("Invalid thinking level");
		return { command: { type: "set_thinking_level", level }, requestId, mutating: true };
	}
	if (body.command === "set_steering_mode" || body.command === "set_follow_up_mode") {
		if (body.mode !== "all" && body.mode !== "one-at-a-time") throw new Error("Invalid queue mode");
		return { command: { type: body.command, mode: body.mode }, requestId, mutating: true };
	}
	if (body.command === "set_auto_compaction" || body.command === "set_auto_retry") {
		if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
		return { command: { type: body.command, enabled: body.enabled }, requestId, mutating: true };
	}
	throw new Error(`RPC command is not allowed: ${body.command}`);
}

export function parseUiResponse(value: unknown): { response: RpcExtensionUIResponse; requestId?: string } {
	const body = objectValue(value);
	if (typeof body.id !== "string" || !body.id || body.id.length > 200) throw new Error("id is required");
	const requestId = optionalRequestId(body.requestId);
	if (typeof body.value === "string" && body.value.length <= 60_000) {
		return { response: { type: "extension_ui_response", id: body.id, value: body.value }, requestId };
	}
	if (typeof body.confirmed === "boolean") {
		return { response: { type: "extension_ui_response", id: body.id, confirmed: body.confirmed }, requestId };
	}
	if (body.cancelled === true) {
		return { response: { type: "extension_ui_response", id: body.id, cancelled: true }, requestId };
	}
	throw new Error("Invalid extension UI response");
}

export function parsePairBody(value: unknown): { code: string; name: string } {
	const body = objectValue(value);
	if (typeof body.code !== "string" || typeof body.name !== "string") throw new Error("code and name are required");
	return { code: body.code, name: body.name };
}

export function requestIdFromHeader(value: string | string[] | undefined): string | undefined {
	return optionalRequestId(Array.isArray(value) ? value[0] : value);
}
