/* eslint-disable no-await-in-loop */
import {spawn, type ChildProcess, execSync} from 'child_process';
import {createServer, type Server, Socket} from 'net';
import {
	createWriteStream, existsSync, mkdirSync, readFileSync, unlinkSync, type WriteStream,
} from 'fs';
import {writeFile, unlink} from 'fs/promises';
import {config as loadDotenv} from 'dotenv';
import type {
	Config, ServiceConfig, TaskConfig, ServiceState, TaskState, StatusFile, Command, Response,
} from './types.js';
import {
	getSocketPath, getStatusPath, getLogsDir, getLogPath, getSupDir,
} from './config.js';

const sleep = async (ms: number) => new Promise<void>((resolve) => {
	setTimeout(resolve, ms);
});

type ManagedService = {
	config: ServiceConfig;
	process: ChildProcess | null;
	state: ServiceState;
	logStream: WriteStream | null;
};

type ManagedTask = {
	config: TaskConfig;
	process: ChildProcess | null;
	state: TaskState;
	logStream: WriteStream | null;
};

export class Daemon {
	private readonly services = new Map<string, ManagedService>();
	private readonly tasks = new Map<string, ManagedTask>();
	private server: Server | null = null;
	private healthCheckInterval: NodeJS.Timeout | null = null;
	private statusWriteInterval: NodeJS.Timeout | null = null;
	private readonly startedAt: string;
	private shuttingDown = false;

	constructor(
		private readonly config: Config,
		private readonly cwd: string = process.cwd(),
		private readonly onlyService?: string,
	) {
		this.startedAt = new Date().toISOString();

		// Initialize task states
		for (const task of config.tasks ?? []) {
			this.tasks.set(task.name, {
				config: task,
				process: null,
				state: {status: 'pending', pid: null},
				logStream: null,
			});
		}

		// Initialize service states
		for (const svc of config.services ?? []) {
			this.services.set(svc.name, {
				config: svc,
				process: null,
				state: {status: 'pending', pid: null, restarts: 0},
				logStream: null,
			});
		}
	}

	async start(): Promise<void> {
		// Load dotenv
		const envPath = this.config.dotenv ?? '.env';
		if (existsSync(envPath)) {
			loadDotenv({path: envPath});
		}

		// Create .sup directory
		const supDir = getSupDir(this.cwd);
		const logsDir = getLogsDir(this.cwd);
		mkdirSync(supDir, {recursive: true});
		mkdirSync(logsDir, {recursive: true});

		// Check if socket already exists (another daemon running?)
		const socketPath = getSocketPath(this.cwd);
		if (existsSync(socketPath)) {
			// Try to connect - if it works, daemon is already running
			const isRunning = await this.checkExistingDaemon(socketPath);
			if (isRunning) {
				throw new Error('Daemon already running. Use "sup down" to stop it.');
			}

			// Stale socket, remove it
			await unlink(socketPath);
		}

		// Check for port conflicts
		await this.checkPortConflicts();

		// Start socket server
		await this.startSocketServer();

		// Start health check loop
		this.healthCheckInterval = setInterval(async () => this.runHealthChecks(), 5000);

		// Start status file writer
		this.statusWriteInterval = setInterval(async () => this.writeStatus(), 2000);
		await this.writeStatus();

		// Set up signal handlers
		process.on('SIGTERM', async () => this.shutdown());
		process.on('SIGINT', async () => this.shutdown());

		// Set up crash handlers to kill children on unexpected exit
		process.on('uncaughtException', (err) => {
			this.emergencyKillChildren('uncaughtException', err);
			process.exit(1);
		});
		process.on('unhandledRejection', (reason) => {
			const err = reason instanceof Error ? reason : new Error(String(reason));
			this.emergencyKillChildren('unhandledRejection', err);
			process.exit(1);
		});

		// Start services (all, or just the specified one with its dependencies)
		await this.startAllServices(this.onlyService);

		console.log(`Daemon started (pid ${process.pid})`);
	}

	private async checkExistingDaemon(socketPath: string): Promise<boolean> {
		return new Promise((resolve) => {
			const client = new Socket();
			client.setTimeout(1000);

			client.on('connect', () => {
				client.destroy();
				resolve(true);
			});

			client.on('error', () => {
				resolve(false);
			});

			client.on('timeout', () => {
				client.destroy();
				resolve(false);
			});

			client.connect(socketPath);
		});
	}

	private async checkPortConflicts(): Promise<void> {
		const conflicts: string[] = [];

		for (const svc of this.config.services ?? []) {
			const hc = svc.healthCheck;
			if (hc?.type === 'port') {
				if (this.isPortInUse(hc.port)) {
					conflicts.push(`${svc.name}: port ${hc.port} in use`);
				}
			}
		}

		if (conflicts.length > 0) {
			throw new Error(`Port conflicts detected:\n${conflicts.join('\n')}\nRun "sup kill" to clean up.`);
		}
	}

	private isPortInUse(port: number): boolean {
		try {
			const result = execSync(`lsof -i:${port} -sTCP:LISTEN -t 2>/dev/null`, {encoding: 'utf-8'});
			return result.trim().length > 0;
		} catch {
			return false;
		}
	}

	private killPort(port: number): void {
		try {
			const pids = execSync(`lsof -t -i:${port} -sTCP:LISTEN 2>/dev/null`, {encoding: 'utf-8'}).trim();
			if (pids) {
				for (const pid of pids.split('\n')) {
					try {
						process.kill(parseInt(pid), 'SIGKILL');
						console.log(`Killed orphan process on port ${port} (pid ${pid})`);
					} catch {
						// Process may have already exited
					}
				}

				// Brief wait for port to be released
				execSync('sleep 0.5');
			}
		} catch {
			// No process on port
		}
	}

	private async startSocketServer(): Promise<void> {
		const socketPath = getSocketPath(this.cwd);

		return new Promise((resolve, reject) => {
			this.server = createServer((socket) => {
				let buffer = '';

				// Handle socket errors (e.g., client disconnects)
				socket.on('error', (err) => {
					// EPIPE, ECONNRESET are normal when client disconnects
					if ((err as NodeJS.ErrnoException).code !== 'EPIPE'
						&& (err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
						console.error('Socket error:', err.message);
					}
				});

				socket.on('data', async (data) => {
					buffer += data.toString();
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						if (line.trim()) {
							try {
								const cmd = JSON.parse(line) as Command;
								const response = await this.handleCommand(cmd);
								if (!socket.destroyed) {
									socket.write(`${JSON.stringify(response)}\n`);
								}
							} catch (err) {
								if (!socket.destroyed) {
									const response: Response = {ok: false, error: String(err)};
									socket.write(`${JSON.stringify(response)}\n`);
								}
							}
						}
					}
				});
			});

			this.server.on('error', reject);
			this.server.listen(socketPath, () => {
				resolve();
			});
		});
	}

	private async handleCommand(cmd: Command): Promise<Response> {
		switch (cmd.cmd) {
			case 'status':
				return {ok: true, data: this.getStatusData()};

			case 'start':
				if (cmd.service) {
					// Check if it's a task or service
					if (this.tasks.has(cmd.service)) {
						await this.runTask(cmd.service);
					} else {
						await this.startService(cmd.service);
					}
				} else {
					await this.startAllServices();
				}

				return {ok: true};

			case 'stop':
				if (cmd.service) {
					await this.stopService(cmd.service);
				} else {
					await this.stopAllServices();
				}

				return {ok: true};

			case 'restart':
				if (cmd.service) {
					await this.stopService(cmd.service);
					await this.startService(cmd.service);
				} else {
					await this.stopAllServices();
					await this.startAllServices();
				}

				return {ok: true};

			case 'logs': {
				const logPath = getLogPath(cmd.service, this.cwd);
				if (!existsSync(logPath)) {
					return {ok: false, error: `No logs for ${cmd.service}`};
				}

				const content = readFileSync(logPath, 'utf-8');
				const lines = content.split('\n');
				const lastN = lines.slice(-(cmd.lines ?? 50)).join('\n');
				return {ok: true, data: lastN};
			}

			case 'down':
				// Don't await - let it complete after response
				setImmediate(async () => this.shutdown());
				return {ok: true};
		}
	}

	private async startAllServices(onlyTarget?: string): Promise<void> {
		// Topological sort by dependencies (includes both tasks and services)
		let sorted = this.topoSort();

		// If targeting a specific service, filter to only it and its dependencies
		if (onlyTarget) {
			const needed = this.getTransitiveDeps(onlyTarget);
			needed.add(onlyTarget);
			sorted = sorted.filter((name) => needed.has(name));
		}

		for (const name of sorted) {
			if (this.tasks.has(name)) {
				await this.runTask(name);
			} else {
				await this.startService(name);
			}
		}
	}

	private getTransitiveDeps(name: string): Set<string> {
		const result = new Set<string>();
		const visit = (n: string) => {
			const task = this.tasks.get(n);
			const svc = this.services.get(n);
			const deps = task?.config.dependsOn ?? svc?.config.dependsOn ?? [];
			for (const dep of deps) {
				if (!result.has(dep)) {
					result.add(dep);
					visit(dep);
				}
			}
		};

		visit(name);
		return result;
	}

	private topoSort(): string[] {
		const result: string[] = [];
		const visited = new Set<string>();
		const visiting = new Set<string>();

		const visit = (name: string) => {
			if (visited.has(name)) {
				return;
			}

			if (visiting.has(name)) {
				throw new Error(`Circular dependency detected involving ${name}`);
			}

			visiting.add(name);

			// Get dependencies from either task or service
			const task = this.tasks.get(name);
			const svc = this.services.get(name);
			const deps = task?.config.dependsOn ?? svc?.config.dependsOn ?? [];

			for (const dep of deps) {
				visit(dep);
			}

			visiting.delete(name);
			visited.add(name);
			result.push(name);
		};

		// Visit all tasks first (they may be dependencies)
		for (const name of this.tasks.keys()) {
			visit(name);
		}

		// Then visit all services
		for (const name of this.services.keys()) {
			visit(name);
		}

		return result;
	}

	private async runTask(name: string): Promise<void> {
		const managed = this.tasks.get(name);
		if (!managed) {
			throw new Error(`Unknown task: ${name}`);
		}

		// Skip if already completed or failed
		if (managed.state.status === 'completed' || managed.state.status === 'failed') {
			return;
		}

		// Skip if already running
		if (managed.process) {
			// Wait for it to complete
			await this.waitForReady(name);
			return;
		}

		const {config} = managed;

		// Wait for dependencies
		if (config.dependsOn) {
			for (const dep of config.dependsOn) {
				await this.waitForReady(dep);
			}
		}

		// Create log stream
		const logPath = getLogPath(name, this.cwd);
		managed.logStream = createWriteStream(logPath, {flags: 'a'});

		// Resolve cwd
		const taskCwd = config.cwd?.replace(/^~/, process.env.HOME ?? '') ?? this.cwd;

		console.log(`Running task ${name}...`);
		managed.state.status = 'running';
		managed.state.startedAt = new Date().toISOString();

		// Spawn process and wait for it to complete
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(config.command, {
				shell: true,
				cwd: taskCwd,
				env: {...process.env, ...config.env},
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			managed.process = proc;
			managed.state.pid = proc.pid ?? null;

			// Pipe output to log
			const logLine = (prefix: string) => (data: Buffer) => {
				const timestamp = new Date().toISOString();
				const lines = data.toString().split('\n');
				for (const line of lines) {
					if (line) {
						managed.logStream?.write(`[${timestamp}]${prefix} ${line}\n`);
					}
				}
			};

			proc.stdout?.on('data', logLine(''));
			proc.stderr?.on('data', logLine(' [ERR]'));

			proc.on('error', (err) => {
				// Handle spawn errors (e.g., invalid cwd, command not found)
				managed.process = null;
				managed.state.pid = null;
				managed.state.status = 'failed';
				managed.state.lastError = err.message;
				managed.state.completedAt = new Date().toISOString();
				managed.logStream?.end();
				managed.logStream = null;
				console.error(`Task ${name} failed to start: ${err.message}`);
				reject(new Error(`Task ${name} failed to start: ${err.message}`));
			});

			proc.on('exit', (code) => {
				managed.process = null;
				managed.state.pid = null;
				if (code !== null) {
					managed.state.exitCode = code;
				}

				managed.state.completedAt = new Date().toISOString();
				managed.logStream?.end();
				managed.logStream = null;

				if (code === 0) {
					managed.state.status = 'completed';
					console.log(`Task ${name} completed`);
					resolve();
				} else {
					managed.state.status = 'failed';
					managed.state.lastError = `Exit code ${code}`;
					console.error(`Task ${name} failed (exit code ${code})`);
					reject(new Error(`Task ${name} failed with exit code ${code}`));
				}
			});
		});
	}

	private async startService(name: string): Promise<void> {
		const managed = this.services.get(name);
		if (!managed) {
			throw new Error(`Unknown service: ${name}`);
		}

		if (managed.process) {
			// Already running
			return;
		}

		const {config} = managed;

		// Wait for dependencies
		if (config.dependsOn) {
			for (const dep of config.dependsOn) {
				await this.waitForReady(dep);
			}
		}

		// If service has a port health check, make sure the port is free
		const hc = config.healthCheck;
		if (hc?.type === 'port') {
			this.killPort(hc.port);
		}

		// Create log stream
		const logPath = getLogPath(name, this.cwd);
		managed.logStream = createWriteStream(logPath, {flags: 'a'});

		// Resolve cwd
		const serviceCwd = config.cwd?.replace(/^~/, process.env.HOME ?? '') ?? this.cwd;

		// Spawn process
		const proc = spawn(config.command, {
			shell: true,
			cwd: serviceCwd,
			env: {...process.env, ...config.env},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		managed.process = proc;
		managed.state.status = 'starting';
		managed.state.pid = proc.pid ?? null;
		managed.state.startedAt = new Date().toISOString();

		// Pipe output to log
		const logLine = (prefix: string) => (data: Buffer) => {
			const timestamp = new Date().toISOString();
			const lines = data.toString().split('\n');
			for (const line of lines) {
				if (line) {
					managed.logStream?.write(`[${timestamp}]${prefix} ${line}\n`);
				}
			}
		};

		proc.stdout?.on('data', logLine(''));
		proc.stderr?.on('data', logLine(' [ERR]'));

		proc.on('error', (err) => {
			// Handle spawn errors (e.g., invalid cwd, command not found)
			console.error(`${name} failed to start: ${err.message}`);
			managed.state.lastError = err.message;
			this.handleExit(name, 1);
		});

		proc.on('exit', (code) => {
			this.handleExit(name, code);
		});

		console.log(`Started ${name} (pid ${proc.pid})`);
	}

	private async waitForReady(name: string, timeoutMs = 30000): Promise<void> {
		const start = Date.now();

		while (Date.now() - start < timeoutMs) {
			// Check if it's a task
			const task = this.tasks.get(name);
			if (task) {
				if (task.state.status === 'completed') {
					return;
				}

				if (task.state.status === 'failed') {
					throw new Error(`Task ${name} failed`);
				}

				await sleep(500);
				continue;
			}

			// It's a service
			const managed = this.services.get(name);
			if (managed?.state.status === 'healthy') {
				return;
			}

			await sleep(500);
		}

		throw new Error(`Timeout waiting for ${name} to become ready`);
	}

	private handleExit(name: string, code: number | null): void {
		const managed = this.services.get(name);
		if (!managed) {
			return;
		}

		managed.process = null;
		managed.state.pid = null;
		managed.logStream?.end();
		managed.logStream = null;

		if (this.shuttingDown) {
			managed.state.status = 'stopped';
			return;
		}

		const policy = managed.config.restartPolicy ?? 'on-failure';

		if (policy === 'never') {
			managed.state.status = 'stopped';
			return;
		}

		if (code === 0 && policy !== 'always') {
			managed.state.status = 'stopped';
			return;
		}

		// Restart with backoff
		managed.state.restarts += 1;
		const maxRestarts = managed.config.maxRestarts ?? 10;

		if (managed.state.restarts > maxRestarts) {
			console.error(`${name} exceeded max restarts (${maxRestarts}), giving up`);
			managed.state.status = 'crashed';
			managed.state.lastError = `Exceeded max restarts after exit code ${code}`;
			return;
		}

		const delay = Math.min(1000 * (2 ** (managed.state.restarts - 1)), 30000);
		console.log(`${name} exited (code ${code}), restarting in ${delay}ms (attempt ${managed.state.restarts})`);
		managed.state.lastError = `Exit code ${code}`;

		setTimeout(() => {
			if (!this.shuttingDown) {
				this.startService(name).catch(console.error);
			}
		}, delay);
	}

	private async stopService(name: string): Promise<void> {
		const managed = this.services.get(name);
		if (!managed?.process) {
			return;
		}

		managed.process.kill('SIGTERM');

		// Wait for exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				managed.process?.kill('SIGKILL');
				resolve();
			}, 5000);

			managed.process?.on('exit', () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		managed.state.status = 'stopped';
		console.log(`Stopped ${name}`);
	}

	private async stopAllServices(): Promise<void> {
		// Stop in reverse dependency order
		const sorted = this.topoSort().reverse();

		for (const name of sorted) {
			await this.stopService(name);
		}
	}

	private async runHealthChecks(): Promise<void> {
		for (const [, managed] of this.services) {
			if (!managed.process) {
				continue;
			}

			const hc = managed.config.healthCheck;
			if (!hc || hc.type === 'none') {
				managed.state.status = 'healthy';
				continue;
			}

			const healthy = await this.checkHealth(hc);
			managed.state.status = healthy ? 'healthy' : 'unhealthy';
		}
	}

	private async checkHealth(hc: NonNullable<ServiceConfig['healthCheck']>): Promise<boolean> {
		if (hc.type === 'none') {
			return true;
		}

		if (hc.type === 'port') {
			return this.isPortInUse(hc.port);
		}

		if (hc.type === 'http') {
			try {
				const controller = new AbortController();
				const timeout = setTimeout(() => {
					controller.abort();
				}, 2000);
				const res = await fetch(hc.url, {signal: controller.signal});
				clearTimeout(timeout);
				return res.ok;
			} catch {
				return false;
			}
		}

		return true;
	}

	private getStatusData(): StatusFile {
		const services: Record<string, ServiceState> = {};
		for (const [name, managed] of this.services) {
			services[name] = {...managed.state};
		}

		const tasks: Record<string, TaskState> = {};
		for (const [name, managed] of this.tasks) {
			tasks[name] = {...managed.state};
		}

		return {
			updatedAt: new Date().toISOString(),
			daemon: {
				pid: process.pid,
				startedAt: this.startedAt,
				socket: getSocketPath(this.cwd),
			},
			services,
			tasks,
		};
	}

	private async writeStatus(): Promise<void> {
		const statusPath = getStatusPath(this.cwd);
		const data = this.getStatusData();
		await writeFile(statusPath, JSON.stringify(data, null, 2));
	}

	/** Synchronously kill all child processes - used during crash handling */
	private emergencyKillChildren(type: 'uncaughtException' | 'unhandledRejection', err: Error): void {
		console.error(`\n${'='.repeat(60)}`);
		console.error(`[sup-cli] Fatal ${type}: ${err.message}`);
		console.error(err.stack ?? '');
		console.error('\nThis is a bug in sup-cli. Please report it at:');
		console.error('https://github.com/domdomegg/sup-cli/issues/new');
		console.error(`${'='.repeat(60)}`);

		// Kill all service processes
		for (const [name, managed] of this.services) {
			if (managed.process?.pid) {
				try {
					process.kill(managed.process.pid, 'SIGKILL');
					console.log(`Killed ${name} (pid ${managed.process.pid})`);
				} catch {
					// Process may have already exited
				}
			}
		}

		// Kill all task processes
		for (const [name, managed] of this.tasks) {
			if (managed.process?.pid) {
				try {
					process.kill(managed.process.pid, 'SIGKILL');
					console.log(`Killed task ${name} (pid ${managed.process.pid})`);
				} catch {
					// Process may have already exited
				}
			}
		}

		// Clean up socket synchronously
		const socketPath = getSocketPath(this.cwd);
		if (existsSync(socketPath)) {
			try {
				unlinkSync(socketPath);
			} catch {
				// Ignore
			}
		}
	}

	private async shutdown(): Promise<void> {
		if (this.shuttingDown) {
			return;
		}

		this.shuttingDown = true;

		console.log('Shutting down...');

		// Stop intervals
		if (this.healthCheckInterval) {
			clearInterval(this.healthCheckInterval);
		}

		if (this.statusWriteInterval) {
			clearInterval(this.statusWriteInterval);
		}

		// Stop all services
		await this.stopAllServices();

		// Close socket server
		if (this.server) {
			this.server.close();
		}

		// Remove socket file
		const socketPath = getSocketPath(this.cwd);
		if (existsSync(socketPath)) {
			await unlink(socketPath);
		}

		// Update status file
		await this.writeStatus();

		console.log('Daemon stopped');
		process.exit(0);
	}
}

export async function startDaemon(config: Config, cwd?: string, onlyService?: string): Promise<void> {
	const daemon = new Daemon(config, cwd, onlyService);
	await daemon.start();

	// Keep process alive - empty executor is intentional
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	await new Promise(() => {});
}
