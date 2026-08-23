import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const PAIRING_TTL_MS = 10 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;

interface StoredDevice {
	id: string;
	name: string;
	tokenHash: string;
	createdAt: string;
}

export interface DeckDevice {
	id: string;
	name: string;
	createdAt: string;
}

interface PairingAttempt {
	count: number;
	windowStartedAt: number;
}

export class DeckAuthError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "DeckAuthError";
		this.status = status;
	}
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function publicDevice(device: StoredDevice): DeckDevice {
	return { id: device.id, name: device.name, createdAt: device.createdAt };
}

function isStoredDevice(value: unknown): value is StoredDevice {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<StoredDevice>;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.name === "string" &&
		typeof candidate.tokenHash === "string" &&
		/^[a-f0-9]{64}$/.test(candidate.tokenHash) &&
		typeof candidate.createdAt === "string"
	);
}

export class DeckAuth {
	readonly pairingCode: string;
	readonly pairingExpiresAt: number;
	private readonly storagePath: string;
	private pairingCodeUsed = false;
	private readonly attempts = new Map<string, PairingAttempt>();
	private devices: StoredDevice[];

	constructor(storagePath: string, options: { now?: number; pairingCode?: string } = {}) {
		this.storagePath = storagePath;
		const now = options.now ?? Date.now();
		this.pairingCode = options.pairingCode ?? randomInt(0, 1_000_000).toString().padStart(6, "0");
		this.pairingExpiresAt = now + PAIRING_TTL_MS;
		this.devices = this.loadDevices();
	}

	private loadDevices(): StoredDevice[] {
		if (!existsSync(this.storagePath)) return [];
		const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as unknown;
		if (!Array.isArray(parsed) || !parsed.every(isStoredDevice)) {
			throw new Error(`Invalid Deck device store: ${this.storagePath}`);
		}
		return parsed;
	}

	private saveDevices(): void {
		mkdirSync(dirname(this.storagePath), { recursive: true });
		const temporaryPath = `${this.storagePath}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
		renameSync(temporaryPath, this.storagePath);
	}

	pairingStatus(now = Date.now()): { available: boolean; expiresAt: string | null } {
		const available = !this.pairingCodeUsed && now < this.pairingExpiresAt;
		return {
			available,
			expiresAt: available ? new Date(this.pairingExpiresAt).toISOString() : null,
		};
	}

	pair(code: string, name: string, remoteAddress: string, now = Date.now()): { device: DeckDevice; token: string } {
		const attempt = this.attempts.get(remoteAddress);
		const current =
			!attempt || now - attempt.windowStartedAt >= ATTEMPT_WINDOW_MS ? { count: 0, windowStartedAt: now } : attempt;
		current.count += 1;
		this.attempts.set(remoteAddress, current);
		if (current.count > MAX_PAIRING_ATTEMPTS) {
			throw new DeckAuthError(429, "Too many pairing attempts; try again later");
		}
		if (this.pairingCodeUsed) throw new DeckAuthError(409, "Pairing code has already been used");
		if (now >= this.pairingExpiresAt) throw new DeckAuthError(410, "Pairing code has expired");
		if (!/^\d{6}$/.test(code) || code !== this.pairingCode) {
			throw new DeckAuthError(401, "Invalid pairing code");
		}
		const trimmedName = name.trim();
		if (!trimmedName || trimmedName.length > 80) throw new DeckAuthError(400, "Device name is required");

		const token = randomBytes(32).toString("base64url");
		const device: StoredDevice = {
			id: randomBytes(12).toString("hex"),
			name: trimmedName,
			tokenHash: hashToken(token),
			createdAt: new Date(now).toISOString(),
		};
		this.devices.push(device);
		this.saveDevices();
		this.pairingCodeUsed = true;
		this.attempts.clear();
		return { device: publicDevice(device), token };
	}

	authenticate(token: string | undefined): DeckDevice | undefined {
		if (!token) return undefined;
		const presented = Buffer.from(hashToken(token), "hex");
		const device = this.devices.find((candidate) => {
			const expected = Buffer.from(candidate.tokenHash, "hex");
			return expected.length === presented.length && timingSafeEqual(expected, presented);
		});
		return device ? publicDevice(device) : undefined;
	}

	listDevices(): DeckDevice[] {
		return this.devices.map(publicDevice);
	}

	revoke(deviceId: string): boolean {
		const previousLength = this.devices.length;
		this.devices = this.devices.filter((device) => device.id !== deviceId);
		if (this.devices.length === previousLength) return false;
		this.saveDevices();
		return true;
	}
}

export function readDeckTokenCookie(cookieHeader: string | undefined): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const [name, ...valueParts] = part.trim().split("=");
		if (name === "pi_deck_token") return decodeURIComponent(valueParts.join("="));
	}
	return undefined;
}

export function deckTokenCookie(token: string): string {
	return `pi_deck_token=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
}

export function clearDeckTokenCookie(): string {
	return "pi_deck_token=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0";
}
