export type ServiceConfig = {
	name: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	healthCheck?: HealthCheck;
	dependsOn?: string[];
	restartPolicy?: 'always' | 'on-failure' | 'never';
	maxRestarts?: number;
	watch?: string[];
};

export type HealthCheck =
	| {type: 'http'; url: string}
	| {type: 'port'; port: number}
	| {type: 'none'};

export type Config = {
	services: ServiceConfig[];
	dotenv?: string; // Path to .env file (default: .env in cwd)
};

export type ServiceStatus = 'pending' | 'starting' | 'healthy' | 'unhealthy' | 'stopped' | 'crashed';

export type ServiceState = {
	status: ServiceStatus;
	pid: number | null;
	restarts: number;
	lastError?: string;
	startedAt?: string;
};

export type DaemonState = {
	pid: number;
	startedAt: string;
	socket: string;
};

export type StatusFile = {
	updatedAt: string;
	daemon: DaemonState | null;
	services: Record<string, ServiceState>;
};

// Socket protocol
export type Command =
	| {cmd: 'status'}
	| {cmd: 'start'; service?: string}
	| {cmd: 'stop'; service?: string}
	| {cmd: 'restart'; service?: string}
	| {cmd: 'logs'; service: string; lines?: number}
	| {cmd: 'down'};

export type Response =
	| {ok: true; data?: unknown}
	| {ok: false; error: string};
