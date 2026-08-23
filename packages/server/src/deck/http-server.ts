import { randomUUID } from "node:crypto";
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	request as requestHttp,
	type Server,
	type ServerResponse,
} from "node:http";
import { StringDecoder } from "node:string_decoder";
import type {
	AgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { InstanceRecord } from "../types.ts";
import { DECK_CSS, DECK_HTML, DECK_ICON, DECK_JS, DECK_MANIFEST, DECK_SERVICE_WORKER } from "./assets.ts";
import { clearDeckTokenCookie, DeckAuth, DeckAuthError, deckTokenCookie, readDeckTokenCookie } from "./auth.ts";
import { DesktopChatStreamTracker, type DesktopStateSnapshot, isDesktopChatSettled } from "./desktop-chat-stream.ts";
import { desktopCompatUpstreamPath, rewriteDesktopHtml, rewriteDesktopWebBundle } from "./desktop-compat.ts";
import { DECK_JS_FEATURES } from "./features.ts";
import {
	createWorkspaceCatalog,
	type DeckWorkspace,
	parsePairBody,
	parseRpcBody,
	parseSpawnBody,
	parseUiResponse,
	requestIdFromHeader,
} from "./validation.ts";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_DESKTOP_WEB_PORT = 8765;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_DESKTOP_COMPAT_BODY_BYTES = 5 * 1024 * 1024;
const MAX_DESKTOP_CHAT_BODY_BYTES = 16 * 1024 * 1024;
const DESKTOP_CHAT_POLL_MS = 1_000;
const DESKTOP_CHAT_SILENCE_MS = 6_000;
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

export interface DeckSupervisor {
	listInstances(): InstanceRecord[];
	getInstance(instanceId: string): InstanceRecord | undefined;
	isInstanceLive(instanceId: string): boolean;
	spawnInstance(options: { cwd: string; label?: string }): Promise<InstanceRecord>;
	resumeInstance(instanceId: string): Promise<InstanceRecord | undefined>;
	stopInstance(instanceId: string): Promise<InstanceRecord | undefined>;
	deleteInstance(instanceId: string): Promise<boolean>;
	readInstanceMessages(instanceId: string): unknown[] | undefined;
	handleRpc(instanceId: string, command: RpcCommand): Promise<RpcResponse | undefined>;
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
		| undefined;
}

interface JsonResult {
	status: number;
	body: unknown;
	headers?: Record<string, string>;
}

interface DedupeEntry {
	expiresAt: number;
	result: Promise<JsonResult>;
}

export interface DeckHttpServer {
	server: Server;
	pairingCode: string;
	port: number;
	close(): Promise<void>;
}

export interface DeckHttpOptions {
	port: number;
	workspacePaths: string[];
	deviceStorePath: string;
	supervisor: DeckSupervisor;
	desktopWebPort?: number;
	onSseConnectionChange?: (count: number) => void;
}

function json(response: ServerResponse, result: JsonResult): void {
	const body = JSON.stringify(result.body);
	response.writeHead(result.status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...result.headers,
	});
	response.end(body);
}

function staticAsset(response: ServerResponse, contentType: string, body: string, cacheControl = "no-cache"): void {
	response.writeHead(200, {
		"Content-Type": contentType,
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": cacheControl,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy":
			"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		"Referrer-Policy": "no-referrer",
	});
	response.end(body);
}

function connectionHeaderNames(headers: IncomingHttpHeaders): Set<string> {
	const connection = headers.connection;
	const values = Array.isArray(connection) ? connection : connection ? [connection] : [];
	return new Set(values.flatMap((value) => value.split(",")).map((value) => value.trim().toLowerCase()));
}

function desktopRequestHeaders(headers: IncomingHttpHeaders, transformResponse: boolean): OutgoingHttpHeaders {
	const excluded = connectionHeaderNames(headers);
	for (const name of HOP_BY_HOP_HEADERS) excluded.add(name);
	for (const name of ["authorization", "cookie", "host", "origin", "proxy-authorization"]) excluded.add(name);
	if (transformResponse) excluded.add("accept-encoding");
	const forwarded: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined && !excluded.has(name)) forwarded[name] = value;
	}
	return forwarded;
}

type DesktopResponseTransform = "html" | "web-bundle";

async function readDesktopResponseBody(upstreamResponse: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of upstreamResponse) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > MAX_DESKTOP_COMPAT_BODY_BYTES) throw new Error("Desktop PiDeck compatibility response is too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, length).toString("utf8");
}

function transformedDesktopResponseHeaders(
	headers: IncomingHttpHeaders,
	desktopWebPort: number,
	contentLength: number,
): OutgoingHttpHeaders {
	const forwarded = desktopResponseHeaders(headers, desktopWebPort);
	for (const name of ["content-encoding", "etag", "last-modified"]) delete forwarded[name];
	forwarded["cache-control"] = "no-store";
	forwarded["content-length"] = contentLength;
	return forwarded;
}

function desktopResponseHeaders(headers: IncomingHttpHeaders, desktopWebPort: number): OutgoingHttpHeaders {
	const excluded = connectionHeaderNames(headers);
	for (const name of HOP_BY_HOP_HEADERS) excluded.add(name);
	excluded.add("set-cookie");
	const forwarded: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || excluded.has(name) || name.startsWith("access-control-allow-")) continue;
		if (name === "location" && typeof value === "string") {
			try {
				const location = new URL(value);
				if (location.hostname === LOOPBACK_HOST && location.port === String(desktopWebPort)) {
					forwarded[name] = `${location.pathname}${location.search}${location.hash}`;
					continue;
				}
			} catch {
				// Relative redirects already point back through the authenticated gateway.
			}
		}
		forwarded[name] = value;
	}
	return forwarded;
}

function proxyDesktopRequest(
	request: IncomingMessage,
	response: ServerResponse,
	desktopWebPort: number,
	targetPath: string,
	transform?: DesktopResponseTransform,
): void {
	const upstreamRequest = requestHttp(
		{
			host: LOOPBACK_HOST,
			port: desktopWebPort,
			method: request.method,
			path: targetPath,
			headers: desktopRequestHeaders(request.headers, transform !== undefined),
		},
		(upstreamResponse) => {
			if (!transform || upstreamResponse.statusCode !== 200) {
				response.writeHead(
					upstreamResponse.statusCode ?? 502,
					desktopResponseHeaders(upstreamResponse.headers, desktopWebPort),
				);
				response.flushHeaders();
				upstreamResponse.on("error", (error) => response.destroy(error));
				upstreamResponse.pipe(response);
				return;
			}
			void readDesktopResponseBody(upstreamResponse)
				.then((body) => {
					const rewritten = transform === "html" ? rewriteDesktopHtml(body) : rewriteDesktopWebBundle(body);
					response.writeHead(
						200,
						transformedDesktopResponseHeaders(
							upstreamResponse.headers,
							desktopWebPort,
							Buffer.byteLength(rewritten),
						),
					);
					response.end(rewritten);
				})
				.catch((error: unknown) => {
					console.error("Pi Deck desktop compatibility transform failed", error);
					if (!response.headersSent) {
						json(response, { status: 502, body: { error: "Desktop PiDeck compatibility transform failed" } });
					} else {
						response.destroy();
					}
				});
			return;
		},
	);
	upstreamRequest.on("error", () => {
		if (!response.headersSent) {
			json(response, { status: 503, body: { error: "Desktop PiDeck is unavailable" } });
		} else {
			response.destroy();
		}
	});
	request.once("aborted", () => upstreamRequest.destroy());
	response.once("close", () => {
		if (!response.writableEnded) upstreamRequest.destroy();
	});
	request.pipe(upstreamRequest);
}

async function readDesktopChatBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += buffer.length;
		if (length > MAX_DESKTOP_CHAT_BODY_BYTES) throw new DeckHttpError(413, "Desktop chat request body is too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks, length);
}

interface DesktopChatMessage {
	id?: unknown;
	role?: unknown;
	content?: unknown;
	parts?: Array<{ type?: unknown; text?: unknown }>;
}

interface DesktopChatDispatch {
	sessionId: string;
	requestId: string;
	message: string;
}

function desktopChatDispatch(body: Buffer): DesktopChatDispatch {
	let value: { id?: unknown; messageId?: unknown; messages?: DesktopChatMessage[] };
	try {
		value = JSON.parse(body.toString("utf8")) as typeof value;
	} catch {
		throw new DeckHttpError(400, "Invalid desktop chat request");
	}
	const sessionId = typeof value.id === "string" ? value.id.trim() : "";
	if (!sessionId) throw new DeckHttpError(400, "Desktop chat session id is required");
	const lastUser = [...(value.messages ?? [])].reverse().find((message) => message.role === "user");
	const partsText = (lastUser?.parts ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => String(part.text))
		.join("");
	const contentText = typeof lastUser?.content === "string" ? lastUser.content : "";
	const message = (partsText || contentText).trim();
	if (!message) throw new DeckHttpError(400, "Desktop chat message is required");
	const preferredRequestId =
		typeof value.messageId === "string" && value.messageId.trim()
			? value.messageId.trim()
			: typeof lastUser?.id === "string" && lastUser.id.trim()
				? lastUser.id.trim()
				: undefined;
	return { sessionId, requestId: preferredRequestId ?? randomUUID(), message };
}

async function readDesktopState(desktopWebPort: number): Promise<DesktopStateSnapshot | undefined> {
	try {
		const response = await fetch(`http://${LOOPBACK_HOST}:${desktopWebPort}/api/state`, {
			signal: AbortSignal.timeout(2_000),
		});
		if (!response.ok) return undefined;
		return (await response.json()) as DesktopStateSnapshot;
	} catch {
		return undefined;
	}
}

async function sendDesktopSessionPrompt(
	headers: IncomingHttpHeaders,
	desktopWebPort: number,
	dispatch: DesktopChatDispatch,
): Promise<boolean> {
	const body = Buffer.from(JSON.stringify({ requestId: dispatch.requestId, message: dispatch.message }));
	const forwardedHeaders = desktopRequestHeaders(headers, false);
	delete forwardedHeaders["content-length"];
	forwardedHeaders["content-type"] = "application/json";
	forwardedHeaders["content-length"] = body.length;
	return await new Promise<boolean>((resolve, reject) => {
		const promptRequest = requestHttp(
			{
				host: LOOPBACK_HOST,
				port: desktopWebPort,
				method: "POST",
				path: `/api/sessions/${encodeURIComponent(dispatch.sessionId)}/prompt`,
				headers: forwardedHeaders,
			},
			(promptResponse) => {
				void readDesktopResponseBody(promptResponse)
					.then((responseBody) => {
						if ((promptResponse.statusCode ?? 500) >= 400) return false;
						try {
							const payload = JSON.parse(responseBody) as { result?: { accepted?: unknown } };
							return payload.result?.accepted === true;
						} catch {
							return false;
						}
					})
					.then(resolve, reject);
			},
		);
		promptRequest.once("error", reject);
		promptRequest.end(body);
	});
}

async function proxyDesktopChatRequest(
	request: IncomingMessage,
	response: ServerResponse,
	desktopWebPort: number,
): Promise<void> {
	const requestStartAt = Date.now();
	const body = await readDesktopChatBody(request);
	const dispatch = desktopChatDispatch(body);
	const tracker = new DesktopChatStreamTracker(requestStartAt);
	const streamHeaders = desktopRequestHeaders(request.headers, false);
	delete streamHeaders["content-length"];
	delete streamHeaders["content-type"];
	const streamRequest = requestHttp(
		{
			host: LOOPBACK_HOST,
			port: desktopWebPort,
			method: "GET",
			path: `/api/sessions/${encodeURIComponent(dispatch.sessionId)}/stream`,
			headers: streamHeaders,
		},
		(upstreamResponse) => {
			if (upstreamResponse.statusCode !== 200) {
				response.writeHead(
					upstreamResponse.statusCode ?? 502,
					desktopResponseHeaders(upstreamResponse.headers, desktopWebPort),
				);
				response.flushHeaders();
				upstreamResponse.on("error", (error) => response.destroy(error));
				upstreamResponse.pipe(response);
				return;
			}

			response.writeHead(200, desktopResponseHeaders(upstreamResponse.headers, desktopWebPort));
			response.flushHeaders();
			const decoder = new StringDecoder("utf8");
			let polling = false;
			let closed = false;
			let settleTimer: NodeJS.Timeout;
			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(settleTimer);
			};
			const finishWithError = () => {
				if (closed || response.writableEnded) return;
				close();
				response.write('data: {"type":"error","errorText":"Prompt was rejected"}\n\n');
				response.end(tracker.recoveryWire());
				upstreamResponse.destroy();
			};
			settleTimer = setInterval(() => {
				if (polling || closed) return;
				polling = true;
				void readDesktopState(desktopWebPort)
					.then((state) => {
						const now = Date.now();
						if (
							state &&
							tracker.shouldRecover(
								isDesktopChatSettled(state, dispatch.sessionId, requestStartAt),
								now,
								DESKTOP_CHAT_SILENCE_MS,
							)
						) {
							close();
							response.end(tracker.recoveryWire());
							upstreamResponse.destroy();
						}
					})
					.finally(() => {
						polling = false;
					});
			}, DESKTOP_CHAT_POLL_MS);

			const writeTrackedChunk = (chunk: string) => {
				const tracked = tracker.push(chunk);
				if (tracked.wire) response.write(tracked.wire);
				if (tracked.complete) {
					close();
					response.end();
					upstreamResponse.destroy();
				}
			};
			upstreamResponse.on("data", (chunk: Buffer) => writeTrackedChunk(decoder.write(chunk)));
			upstreamResponse.once("end", () => {
				close();
				if (!response.writableEnded) {
					writeTrackedChunk(decoder.end());
					if (!response.writableEnded) response.end(tracker.flush());
				}
			});
			upstreamResponse.once("error", (error) => {
				close();
				if (!response.writableEnded) response.destroy(error);
			});
			response.once("close", () => {
				close();
				upstreamResponse.destroy();
			});
			void sendDesktopSessionPrompt(request.headers, desktopWebPort, dispatch)
				.then((accepted) => {
					if (!accepted) finishWithError();
				})
				.catch(finishWithError);
		},
	);
	streamRequest.on("error", () => {
		if (!response.headersSent) {
			json(response, { status: 503, body: { error: "Desktop PiDeck is unavailable" } });
		} else {
			response.destroy();
		}
	});
	response.once("close", () => streamRequest.destroy());
	streamRequest.end();
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const contentLength = Number(request.headers["content-length"] ?? 0);
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES)
		throw new DeckHttpError(413, "Request body is too large");
	let body = "";
	for await (const chunk of request) {
		body += chunk.toString();
		if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new DeckHttpError(413, "Request body is too large");
	}
	if (!body) return {};
	try {
		return JSON.parse(body) as unknown;
	} catch {
		throw new DeckHttpError(400, "Invalid JSON body");
	}
}

class DeckHttpError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "DeckHttpError";
		this.status = status;
	}
}

function validateRequest<T>(operation: () => T): T {
	try {
		return operation();
	} catch (error) {
		throw new DeckHttpError(400, error instanceof Error ? error.message : "Invalid request");
	}
}

function requestId(request: IncomingMessage): string | undefined {
	return validateRequest(() => requestIdFromHeader(request.headers["x-request-id"]));
}

function validateHostAndOrigin(request: IncomingMessage): void {
	const host = request.headers.host;
	if (!host || host.length > 255) throw new DeckHttpError(400, "Invalid Host header");
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname.toLowerCase();
	} catch {
		throw new DeckHttpError(400, "Invalid Host header");
	}
	if (hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "::1" && !hostname.endsWith(".ts.net")) {
		throw new DeckHttpError(403, "Host is not a loopback or Tailscale Serve name");
	}
	const origin = request.headers.origin;
	if (origin) {
		let originHost: string;
		try {
			originHost = new URL(origin).host.toLowerCase();
		} catch {
			throw new DeckHttpError(403, "Invalid Origin header");
		}
		if (originHost !== host.toLowerCase()) throw new DeckHttpError(403, "Cross-origin request rejected");
	}
	const safeMethod = request.method === "GET" || request.method === "HEAD";
	if (request.headers["sec-fetch-site"] === "cross-site" && !origin && !safeMethod)
		throw new DeckHttpError(403, "Cross-site request rejected");
}

function publicWorkspace(workspace: DeckWorkspace): { id: string; name: string } {
	return { id: workspace.id, name: workspace.name };
}

function workspacePathKey(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function publicInstance(instance: InstanceRecord, workspace: DeckWorkspace, active: boolean): Record<string, unknown> {
	return {
		id: instance.id,
		status: instance.status,
		label: instance.label,
		workspaceId: workspace.id,
		workspaceName: workspace.name,
		createdAt: instance.createdAt,
		lastSeenAt: instance.lastSeenAt,
		sessionId: instance.sessionId,
		active,
	};
}

function routeInstanceId(pathname: string, suffix = ""): string | undefined {
	const match = pathname.match(new RegExp(`^/api/instances/([^/]+)${suffix}$`));
	return match ? decodeURIComponent(match[1]) : undefined;
}

export async function startDeckHttpServer(options: DeckHttpOptions): Promise<DeckHttpServer> {
	const desktopWebPort = options.desktopWebPort ?? DEFAULT_DESKTOP_WEB_PORT;
	if (!Number.isInteger(desktopWebPort) || desktopWebPort < 1 || desktopWebPort > 65_535) {
		throw new RangeError("desktopWebPort must be an integer between 1 and 65535");
	}
	const workspaces = createWorkspaceCatalog(options.workspacePaths);
	const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
	const workspaceByPath = new Map(workspaces.map((workspace) => [workspacePathKey(workspace.path), workspace]));
	const auth = new DeckAuth(options.deviceStorePath);
	const dedupe = new Map<string, DedupeEntry>();
	let sseConnections = 0;

	const allowedInstance = (instanceId: string): { instance: InstanceRecord; workspace: DeckWorkspace } => {
		const instance = options.supervisor.getInstance(instanceId);
		const workspace = instance ? workspaceByPath.get(workspacePathKey(instance.cwd)) : undefined;
		if (!instance || !workspace) throw new DeckHttpError(404, "Unknown instance");
		return { instance, workspace };
	};

	const deduplicated = async (
		deviceId: string,
		requestId: string | undefined,
		operation: () => Promise<JsonResult>,
	) => {
		if (!requestId) return await operation();
		const now = Date.now();
		for (const [key, entry] of dedupe) if (entry.expiresAt <= now) dedupe.delete(key);
		const key = `${deviceId}:${requestId}`;
		const existing = dedupe.get(key);
		if (existing) return await existing.result;
		const result = operation();
		dedupe.set(key, { expiresAt: now + IDEMPOTENCY_TTL_MS, result });
		try {
			return await result;
		} catch (error) {
			dedupe.delete(key);
			throw error;
		}
	};

	const server = createServer(async (request, response) => {
		try {
			validateHostAndOrigin(request);
			const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
			if (request.method === "GET" && url.pathname === "/sw.js")
				return staticAsset(response, "text/javascript; charset=utf-8", DECK_SERVICE_WORKER);
			if (request.method === "GET" && url.pathname === "/manifest.webmanifest")
				return staticAsset(response, "application/manifest+json", DECK_MANIFEST);
			if (request.method === "GET" && url.pathname === "/icon.svg")
				return staticAsset(response, "image/svg+xml", DECK_ICON, "public, max-age=86400");

			if (request.method === "GET" && url.pathname === "/api/health")
				return json(response, { status: 200, body: { ok: true } });
			if (request.method === "GET" && url.pathname === "/api/pairing") {
				return json(response, { status: 200, body: auth.pairingStatus() });
			}
			if (request.method === "POST" && url.pathname === "/api/pair") {
				const rawBody = await readJsonBody(request);
				const body = validateRequest(() => parsePairBody(rawBody));
				const remoteAddress = request.socket.remoteAddress ?? "unknown";
				const result = await deduplicated(`pair:${remoteAddress}`, requestId(request), async () => {
					const paired = auth.pair(body.code, body.name, remoteAddress);
					return {
						status: 201,
						body: { device: paired.device },
						headers: { "Set-Cookie": deckTokenCookie(paired.token) },
					};
				});
				return json(response, result);
			}

			const device = auth.authenticate(readDeckTokenCookie(request.headers.cookie));
			if (!device) {
				if (request.method === "GET" && url.pathname === "/")
					return staticAsset(response, "text/html; charset=utf-8", DECK_HTML);
				if (request.method === "GET" && url.pathname === "/app.css")
					return staticAsset(response, "text/css; charset=utf-8", `${DECK_CSS}[hidden]{display:none!important}`);
				if (request.method === "GET" && url.pathname === "/app.js")
					return staticAsset(response, "text/javascript; charset=utf-8", `${DECK_JS}\n${DECK_JS_FEATURES}`);
				throw new DeckHttpError(401, "Pair this device first");
			}

			if (request.method === "GET" && url.pathname === "/api/me")
				return json(response, { status: 200, body: { device } });
			if (request.method === "GET" && url.pathname === "/api/workspaces") {
				return json(response, { status: 200, body: { workspaces: workspaces.map(publicWorkspace) } });
			}
			if (request.method === "GET" && url.pathname === "/api/devices") {
				return json(response, { status: 200, body: { devices: auth.listDevices() } });
			}
			const deviceId =
				request.method === "DELETE" ? url.pathname.match(/^\/api\/devices\/([^/]+)$/)?.[1] : undefined;
			if (deviceId) {
				const decodedId = decodeURIComponent(deviceId);
				const result = await deduplicated(device.id, requestId(request), async () => {
					if (!auth.revoke(decodedId)) throw new DeckHttpError(404, "Unknown device");
					return {
						status: 200,
						body: { revoked: decodedId },
						headers: decodedId === device.id ? { "Set-Cookie": clearDeckTokenCookie() } : undefined,
					};
				});
				return json(response, result);
			}

			if (request.method === "GET" && url.pathname === "/api/instances") {
				const instances = options.supervisor.listInstances().flatMap((instance) => {
					const workspace = workspaceByPath.get(workspacePathKey(instance.cwd));
					return workspace
						? [publicInstance(instance, workspace, options.supervisor.isInstanceLive(instance.id))]
						: [];
				});
				return json(response, { status: 200, body: { instances } });
			}
			if (request.method === "POST" && url.pathname === "/api/instances") {
				const rawBody = await readJsonBody(request);
				const body = validateRequest(() => parseSpawnBody(rawBody));
				const workspace = workspaceById.get(body.workspaceId);
				if (!workspace) throw new DeckHttpError(403, "Workspace is not allowed");
				const mutationId = requestId(request) ?? body.requestId;
				const result = await deduplicated(device.id, mutationId, async () => {
					const instance = await options.supervisor.spawnInstance({ cwd: workspace.path, label: body.label });
					return {
						status: 201,
						body: {
							instance: publicInstance(instance, workspace, options.supervisor.isInstanceLive(instance.id)),
						},
					};
				});
				return json(response, result);
			}

			const resumeInstanceId = routeInstanceId(url.pathname, "/resume");
			if (request.method === "POST" && resumeInstanceId) {
				const current = allowedInstance(resumeInstanceId);
				const result = await deduplicated(device.id, requestId(request), async () => {
					const resumed = await options.supervisor.resumeInstance(resumeInstanceId);
					if (!resumed) throw new DeckHttpError(404, "Unknown instance");
					return {
						status: 200,
						body: {
							instance: publicInstance(
								resumed,
								current.workspace,
								options.supervisor.isInstanceLive(resumeInstanceId),
							),
						},
					};
				});
				return json(response, result);
			}

			const stopInstanceId = routeInstanceId(url.pathname, "/stop");
			if (request.method === "POST" && stopInstanceId) {
				allowedInstance(stopInstanceId);
				const result = await deduplicated(device.id, requestId(request), async () => {
					const stopped = await options.supervisor.stopInstance(stopInstanceId);
					if (!stopped) throw new DeckHttpError(404, "Unknown instance");
					return { status: 200, body: { instanceId: stopInstanceId } };
				});
				return json(response, result);
			}

			const messagesInstanceId = routeInstanceId(url.pathname, "/messages");
			if (request.method === "GET" && messagesInstanceId) {
				allowedInstance(messagesInstanceId);
				let messages: unknown[] | undefined;
				if (options.supervisor.isInstanceLive(messagesInstanceId)) {
					const rpcResponse = await options.supervisor.handleRpc(messagesInstanceId, { type: "get_messages" });
					if (rpcResponse?.success && rpcResponse.command === "get_messages") messages = rpcResponse.data.messages;
				} else {
					messages = options.supervisor.readInstanceMessages(messagesInstanceId);
				}
				if (!messages) throw new DeckHttpError(404, "Messages are unavailable");
				return json(response, { status: 200, body: { messages } });
			}

			const instanceId = routeInstanceId(url.pathname);
			if (request.method === "GET" && instanceId) {
				const current = allowedInstance(instanceId);
				return json(response, {
					status: 200,
					body: {
						instance: publicInstance(
							current.instance,
							current.workspace,
							options.supervisor.isInstanceLive(instanceId),
						),
					},
				});
			}
			if (request.method === "DELETE" && instanceId) {
				const result = await deduplicated(device.id, requestId(request), async () => {
					allowedInstance(instanceId);
					if (!(await options.supervisor.deleteInstance(instanceId))) {
						throw new DeckHttpError(404, "Unknown instance");
					}
					return { status: 200, body: { instanceId } };
				});
				return json(response, result);
			}

			const rpcInstanceId = routeInstanceId(url.pathname, "/rpc");
			if (request.method === "POST" && rpcInstanceId) {
				allowedInstance(rpcInstanceId);
				const rawBody = await readJsonBody(request);
				const body = validateRequest(() => parseRpcBody(rawBody));
				const execute = async (): Promise<JsonResult> => {
					const rpcResponse = await options.supervisor.handleRpc(rpcInstanceId, body.command);
					if (!rpcResponse) throw new DeckHttpError(404, "Instance is not running");
					return { status: rpcResponse.success ? 200 : 409, body: rpcResponse };
				};
				const mutationId = requestId(request) ?? body.requestId;
				return json(response, body.mutating ? await deduplicated(device.id, mutationId, execute) : await execute());
			}

			const uiInstanceId = routeInstanceId(url.pathname, "/ui-response");
			if (request.method === "POST" && uiInstanceId) {
				allowedInstance(uiInstanceId);
				const rawBody = await readJsonBody(request);
				const body = validateRequest(() => parseUiResponse(rawBody));
				const mutationId = requestId(request) ?? body.requestId;
				const result = await deduplicated(device.id, mutationId, async () => {
					const stream = options.supervisor.openRpcStream(
						uiInstanceId,
						() => undefined,
						() => undefined,
					);
					if (!stream) throw new DeckHttpError(404, "Instance is not running");
					try {
						stream.handleUiResponse(body.response);
					} finally {
						stream.close();
					}
					return { status: 200, body: { accepted: true } };
				});
				return json(response, result);
			}

			const eventsInstanceId = routeInstanceId(url.pathname, "/events");
			if (request.method === "GET" && eventsInstanceId) {
				allowedInstance(eventsInstanceId);
				const send = (event: string, data: unknown) =>
					response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
				const stream = options.supervisor.openRpcStream(
					eventsInstanceId,
					(event) => send("session_event", event),
					(requestEvent) => send("ui_request", requestEvent),
				);
				if (!stream) throw new DeckHttpError(404, "Instance is not running");
				response.writeHead(200, {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
					"X-Accel-Buffering": "no",
				});
				sseConnections += 1;
				options.onSseConnectionChange?.(sseConnections);
				send("ready", { instanceId: eventsInstanceId });
				const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
				let closed = false;
				const close = () => {
					if (closed) return;
					closed = true;
					clearInterval(heartbeat);
					stream.close();
					sseConnections -= 1;
					options.onSseConnectionChange?.(sseConnections);
				};
				request.once("close", close);
				response.once("close", close);
				return;
			}

			const compatUpstreamPath = request.method === "GET" ? desktopCompatUpstreamPath(url.pathname) : undefined;
			if (request.method === "POST" && url.pathname === "/api/chat") {
				return await proxyDesktopChatRequest(request, response, desktopWebPort);
			}
			const transform =
				request.method === "GET"
					? compatUpstreamPath
						? "web-bundle"
						: url.pathname === "/"
							? "html"
							: undefined
					: undefined;
			return proxyDesktopRequest(
				request,
				response,
				desktopWebPort,
				`${compatUpstreamPath ?? url.pathname}${url.search}`,
				transform,
			);
		} catch (error) {
			const expected = error instanceof DeckHttpError || error instanceof DeckAuthError;
			const status = expected ? error.status : 500;
			const message = expected ? error.message : "Internal server error";
			if (!expected) console.error("Pi Deck request failed", error);
			if (!response.headersSent) json(response, { status, body: { error: message } });
			else response.end();
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, LOOPBACK_HOST, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	const port = address && typeof address === "object" ? address.port : options.port;
	return {
		server,
		pairingCode: auth.pairingCode,
		port,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
