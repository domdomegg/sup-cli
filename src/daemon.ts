/* eslint-disable no-await-in-loop */
import {spawn, type ChildProcess, execSync} from 'child_process';
import {createServer, type Server, Socket} from 'net';
import {
	createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream,
} from 'fs';
import {writeFile, unlink} from 'fs/promises';
import {config as loadDotenv} from 'dotenv';
import type {
	Config, ServiceConfig, ServiceState, StatusFile, Command, Response,
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

export class Daemon {
	private readonly services = new Map<string, ManagedService>();
	private server: Server | null = null;
	private healthCheckInterval: NodeJS.Timeout | null = null;
	private statusWriteInterval: NodeJS.Timeout | null = null;
	private readonly startedAt: string;
	private shuttingDown = false;

	constructor(
		private readonly config: Config,
		private readonly cwd: string = process.cwd(),
	) {
		this.startedAt = new Date().toISOString();

		// Initialize service states
		for (const svc of config.services) {
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

		// Start all services
		await this.startAllServices();

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

		for (const svc of this.config.services) {
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

				socket.on('data', async (data) => {
					buffer += data.toString();
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const line of lines) {
						if (line.trim()) {
							try {
								const cmd = JSON.parse(line) as Command;
								const response = await this.handleCommand(cmd);
								socket.write(`${JSON.stringify(response)}\n`);
							} catch (err) {
								const response: Response = {ok: false, error: String(err)};
								socket.write(`${JSON.stringify(response)}\n`);
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
					await this.startService(cmd.service);
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

	private async startAllServices(): Promise<void> {
		// Topological sort by dependencies
		const sorted = this.topoSort();

		for (const name of sorted) {
			await this.startService(name);
		}
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
			const svc = this.services.get(name);
			if (svc?.config.dependsOn) {
				for (const dep of svc.config.dependsOn) {
					visit(dep);
				}
			}

			visiting.delete(name);
			visited.add(name);
			result.push(name);
		};

		for (const name of this.services.keys()) {
			visit(name);
		}

		return result;
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
				await this.waitForHealthy(dep);
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

		proc.on('exit', (code) => {
			this.handleExit(name, code);
		});

		console.log(`Started ${name} (pid ${proc.pid})`);
	}

	private async waitForHealthy(name: string, timeoutMs = 30000): Promise<void> {
		const start = Date.now();

		while (Date.now() - start < timeoutMs) {
			const managed = this.services.get(name);
			if (managed?.state.status === 'healthy') {
				return;
			}

			await sleep(500);
		}

		throw new Error(`Timeout waiting for ${name} to become healthy`);
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

		return {
			updatedAt: new Date().toISOString(),
			daemon: {
				pid: process.pid,
				startedAt: this.startedAt,
				socket: getSocketPath(this.cwd),
			},
			services,
		};
	}

	private async writeStatus(): Promise<void> {
		const statusPath = getStatusPath(this.cwd);
		const data = this.getStatusData();
		await writeFile(statusPath, JSON.stringify(data, null, 2));
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

export async function startDaemon(config: Config, cwd?: string): Promise<void> {
	const daemon = new Daemon(config, cwd);
	await daemon.start();

	// Keep process alive - empty executor is intentional
	// eslint-disable-next-line @typescript-eslint/no-empty-function
	await new Promise(() => {});
}
