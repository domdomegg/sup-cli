/* eslint-disable no-await-in-loop */
import {
	test, expect, describe,
} from 'vitest';
import {execSync} from 'child_process';
import {
	mkdtemp, writeFile, rm, readFile,
} from 'fs/promises';
import {existsSync} from 'fs';
import {join} from 'path';
import {tmpdir} from 'os';
import type {Config, StatusFile} from './types.js';

// Test timeout - generous for CI but tests should be much faster
const TEST_TIMEOUT = 15000;

// Path to the built CLI
const CLI_PATH = join(import.meta.dirname, '../dist/cli.js');

// Test harness
class SupTestHarness {
	static async create(): Promise<SupTestHarness> {
		const dir = await mkdtemp(join(tmpdir(), 'sup-test-'));
		return new SupTestHarness(dir);
	}

	private cleanedUp = false;

	private constructor(readonly dir: string) {}

	async writeConfig(config: Config): Promise<void> {
		await writeFile(
			join(this.dir, 'sup.config.json'),
			JSON.stringify(config, null, 2),
		);
	}

	run(command: string, options: {timeout?: number; expectError?: boolean} = {}): string {
		try {
			return execSync(`node ${CLI_PATH} ${command}`, {
				cwd: this.dir,
				encoding: 'utf-8',
				timeout: options.timeout ?? 10000,
				env: {
					...process.env,
					NO_COLOR: '1',
				},
			});
		} catch (err: unknown) {
			const error = err as {stdout?: string; stderr?: string; status?: number; message: string};

			if (options.expectError) {
				// Return combined output for error checking
				return `${error.stdout ?? ''}${error.stderr ?? ''}`;
			}

			// Return stdout even on non-zero exit
			if (error.stdout) {
				return error.stdout;
			}

			throw new Error(`Command failed: ${error.message}\nstderr: ${error.stderr ?? ''}`);
		}
	}

	async up(service?: string): Promise<string> {
		return this.run(service ? `up ${service}` : 'up');
	}

	async down(): Promise<string> {
		return this.run('down');
	}

	async status(): Promise<StatusFile | null> {
		const statusPath = join(this.dir, '.sup', 'status.json');
		if (!existsSync(statusPath)) {
			return null;
		}

		// Retry on parse error (race with daemon writing)
		for (let i = 0; i < 3; i++) {
			try {
				return JSON.parse(await readFile(statusPath, 'utf-8'));
			} catch {
				await sleep(20);
			}
		}

		return null;
	}

	async statusText(): Promise<string> {
		return this.run('status');
	}

	async waitForHealthy(service: string, timeoutMs = 5000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const status = await this.status();
			if (status?.services[service]?.status === 'healthy') {
				return;
			}

			await sleep(50);
		}

		throw new Error(`Timeout waiting for ${service} to become healthy`);
	}

	async waitForDaemon(timeoutMs = 3000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const status = await this.status();
			if (status?.daemon?.pid) {
				return;
			}

			await sleep(50);
		}

		throw new Error('Timeout waiting for daemon to start');
	}

	async waitForRestarts(service: string, minRestarts: number, timeoutMs = 3000): Promise<void> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const status = await this.status();
			if ((status?.services[service]?.restarts ?? 0) >= minRestarts) {
				return;
			}

			await sleep(50);
		}

		throw new Error(`Timeout waiting for ${service} to have ${minRestarts} restarts`);
	}

	async readLog(service: string): Promise<string> {
		const logPath = join(this.dir, '.sup', 'logs', `${service}.log`);
		if (!existsSync(logPath)) {
			return '';
		}

		return readFile(logPath, 'utf-8');
	}

	async cleanup(): Promise<void> {
		if (this.cleanedUp) {
			return;
		}

		this.cleanedUp = true;

		// Stop daemon - this also stops all services
		try {
			this.run('down', {timeout: 5000});
		} catch {
			// Ignore errors during cleanup
		}

		// Remove temp directory
		await rm(this.dir, {recursive: true, force: true});
	}
}

const sleep = async (ms: number) => new Promise<void>((resolve) => {
	setTimeout(resolve, ms);
});

// Find an available port
async function findPort(): Promise<number> {
	const {createServer} = await import('net');
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.listen(0, () => {
			const addr = server.address();
			if (addr && typeof addr === 'object') {
				const {port} = addr;
				server.close(() => {
					resolve(port);
				});
			} else {
				reject(new Error('Could not get port'));
			}
		});
	});
}

// ============================================================================
// Tests
// ============================================================================

// Helper to run a test with its own harness
async function withHarness(fn: (harness: SupTestHarness) => Promise<void>): Promise<void> {
	const harness = await SupTestHarness.create();
	try {
		await fn(harness);
	} finally {
		await harness.cleanup();
	}
}

// Run tests concurrently - each has its own temp directory
describe.concurrent('sup-cli integration tests', () => {
	// --------------------------------------------------------------------------
	// Basic lifecycle
	// --------------------------------------------------------------------------

	test('up starts daemon and services, down stops them', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [{
				name: 'sleeper',
				command: 'sleep 60',
				healthCheck: {type: 'none'},
			}],
		});

		const upOutput = await harness.up();
		expect(upOutput).toContain('Daemon started');

		await harness.waitForDaemon();
		await harness.waitForHealthy('sleeper');

		const status = await harness.status();
		expect(status?.daemon?.pid).toBeGreaterThan(0);
		expect(status?.services.sleeper?.status).toBe('healthy');

		const downOutput = await harness.down();
		expect(downOutput).toContain('Daemon stop');

		const statusAfter = await harness.status();
		expect(statusAfter?.services.sleeper?.status).toBe('stopped');
	}));

	test('status shows "not running" when daemon is not started', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [{name: 'test', command: 'sleep 60', healthCheck: {type: 'none'}}],
		});
		const output = await harness.statusText();
		expect(output).toContain('No status available');
	}));

	test('down reports "not running" when daemon is not started', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [{name: 'test', command: 'sleep 60', healthCheck: {type: 'none'}}],
		});
		const output = await harness.down();
		expect(output).toContain('Daemon not running');
	}));

	test('starts services in dependency order', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		const port1 = await findPort();
		const port2 = await findPort();

		await harness.writeConfig({
			services: [
				{
					name: 'api',
					command: `node -e "require('net').createServer().listen(${port1})"`,
					healthCheck: {type: 'port', port: port1},
					dependsOn: ['db'],
				},
				{
					name: 'db',
					command: `node -e "require('net').createServer().listen(${port2})"`,
					healthCheck: {type: 'port', port: port2},
				},
			],
		});

		await harness.up();
		await harness.waitForDaemon();
		await harness.waitForHealthy('db');
		await harness.waitForHealthy('api');

		const status = await harness.status();
		expect(status?.services.db?.status).toBe('healthy');
		expect(status?.services.api?.status).toBe('healthy');

		const dbStarted = new Date(status!.services.db!.startedAt!).getTime();
		const apiStarted = new Date(status!.services.api!.startedAt!).getTime();
		expect(dbStarted).toBeLessThanOrEqual(apiStarted);
	}));

	test('starting a single service also starts its dependencies', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [
				{
					name: 'web', command: 'sleep 60', healthCheck: {type: 'none'}, dependsOn: ['api'],
				},
				{
					name: 'api', command: 'sleep 60', healthCheck: {type: 'none'}, dependsOn: ['db'],
				},
				{name: 'db', command: 'sleep 60', healthCheck: {type: 'none'}},
				{name: 'unrelated', command: 'sleep 60', healthCheck: {type: 'none'}},
			],
		});

		await harness.up('web');
		await harness.waitForDaemon();
		await harness.waitForHealthy('db');
		await harness.waitForHealthy('api');
		await harness.waitForHealthy('web');

		const status = await harness.status();
		expect(status?.services.web?.status).toBe('healthy');
		expect(status?.services.api?.status).toBe('healthy');
		expect(status?.services.db?.status).toBe('healthy');
		expect(status?.services.unrelated?.status).toBe('pending');
	}));

	test('port health check detects when service is listening', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		const port = await findPort();

		await harness.writeConfig({
			services: [{
				name: 'server',
				command: `node -e "setTimeout(() => require('net').createServer().listen(${port}), 100)"`,
				healthCheck: {type: 'port', port},
			}],
		});

		await harness.up();
		await harness.waitForDaemon();
		await harness.waitForHealthy('server');

		const status = await harness.status();
		expect(status?.services.server?.status).toBe('healthy');
	}));

	test('http health check detects healthy endpoint', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		const port = await findPort();

		await harness.writeConfig({
			services: [{
				name: 'http-server',
				command: `node -e "require('http').createServer((req, res) => { res.writeHead(200); res.end('ok'); }).listen(${port})"`,
				healthCheck: {type: 'http', url: `http://localhost:${port}/health`},
			}],
		});

		await harness.up();
		await harness.waitForDaemon();
		await harness.waitForHealthy('http-server');

		const status = await harness.status();
		expect(status?.services['http-server']?.status).toBe('healthy');
	}));

	test('type: none immediately marks service as healthy', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [{name: 'no-check', command: 'sleep 60', healthCheck: {type: 'none'}}],
		});

		await harness.up();
		await harness.waitForDaemon();
		await harness.waitForHealthy('no-check');

		const status = await harness.status();
		expect(status?.services['no-check']?.status).toBe('healthy');
	}));

	test('on-failure restarts crashed service', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [{
				name: 'crasher',
				command: 'exit 1',
				healthCheck: {type: 'none'},
				restartPolicy: 'on-failure',
			}],
		});

		await harness.up();
		await harness.waitForDaemon();
		await harness.waitForRestarts('crasher', 1);

		const status = await harness.status();
		expect(status?.services.crasher?.restarts).toBeGreaterThan(0);
	}));

	test('never policy does not restart', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [{
				name: 'one-shot',
				command: 'exit 1',
				healthCheck: {type: 'none'},
				restartPolicy: 'never',
			}],
		});

		await harness.up();
		await harness.waitForDaemon();
		// Wait enough time for one restart cycle to happen (if it would)
		// Base restart delay is 500ms, so 600ms is enough
		await sleep(600);

		const status = await harness.status();
		expect(status?.services['one-shot']?.restarts).toBe(0);
		expect(status?.services['one-shot']?.status).toBe('stopped');
	}));

	test('always policy restarts even on success', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [{
				name: 'always-run',
				command: 'exit 0',
				healthCheck: {type: 'none'},
				restartPolicy: 'always',
			}],
		});

		await harness.up();
		await harness.waitForDaemon();
		await harness.waitForRestarts('always-run', 1);

		const status = await harness.status();
		expect(status?.services['always-run']?.restarts).toBeGreaterThan(0);
	}));

	test('handles invalid cwd gracefully', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		await harness.writeConfig({
			services: [{
				name: 'bad-cwd',
				command: 'echo hello',
				cwd: '/nonexistent/path/that/does/not/exist',
				healthCheck: {type: 'none'},
			}],
		});

		await harness.up();
		await harness.waitForDaemon();
		await harness.waitForRestarts('bad-cwd', 1);

		const status = await harness.status();
		expect(status?.daemon?.pid).toBeGreaterThan(0);
		expect(status?.services['bad-cwd']?.lastError).toBeTruthy();
	}));

	test('handles missing config file', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		const output = harness.run('up', {expectError: true});
		expect(output).toContain('failed');
	}));

	test('tasks run to completion before dependent services start', {timeout: TEST_TIMEOUT}, async () => withHarness(async (harness) => {
		const markerFile = join(harness.dir, 'task-completed');

		await harness.writeConfig({
			tasks: [{name: 'setup', command: `touch "${markerFile}"`}],
			services: [{
				name: 'app',
				command: 'sleep 60',
				healthCheck: {type: 'none'},
				dependsOn: ['setup'],
			}],
		});

		await harness.up();
		await harness.waitForDaemon();
		await harness.waitForHealthy('app');

		expect(existsSync(markerFile)).toBe(true);

		const status = await harness.status();
		expect(status?.tasks?.setup?.status).toBe('completed');
	}));
});
