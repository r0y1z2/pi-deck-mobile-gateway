export type InstanceStatus = "starting" | "ready" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface MachineRecord {
	id: string;
	createdAt: string;
	lastSeenAt?: string;
	label?: string;
}

export interface RadiusRegistration {
	heartbeatIntervalMs: number;
	expiresInMs: number;
}

export interface InstanceRecord {
	id: string;
	status: InstanceStatus;
	cwd: string;
	createdAt: string;
	lastSeenAt?: string;
	label?: string;
	sessionId?: string;
	sessionFile?: string;
	radiusPiId?: string;
}
