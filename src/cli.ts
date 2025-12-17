#!/usr/bin/env node
/* eslint-disable no-await-in-loop */

import {spawn, execSync} from 'child_process';
import {
	existsSync, readFileSync, readdirSync, unlinkSync, mkdirSync, openSync,
} from 'fs';
import {
	loadConfig, getSocketPath, getStatusPath, getLogPath, getLogsDir, getSupDir,
} from './config.js';
import {startDaemon} from './daemon.js';
import {Client} from './client.js';
import type {StatusFile} from './types.js';

const args = process.argv.slice(2);
const command = args[0];
const subArgs = args.slice(1);

const sleep = async (ms: number) => new Promise<void>((resolve) => {
	setTimeout(resolve, ms);
});

async function main() {
	try {
		switch (command) {
			case 'up':
				await cmdUp();
				break;
			case 'down':
				await cmdDown();
				break;
			case 'status':
				await cmdStatus();
				break;
			case 'start':
				await cmdStart();
				break;
			case 'stop':
				await cmdStop();
				break;
			case 'restart':
				await cmdRestart();
				break;
			case 'logs':
				await cmdLogs();
				break;
			case 'kill':
				await cmdKill();
				break;
			case 'help':
			case '--help':
			case '-h':
			case undefined:
				printHelp();
				break;
			default:
				console.error(`Unknown command: ${command}`);
				printHelp();
				process.exit(1);
		}
	} catch (err: unknown) {
		console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}
}

async function cmdUp() {
	const scriptPath = process.argv[1];
	if (!scriptPath) {
		throw new Error('Could not determine script path');
	}

	const client = new Client();
	const socketPath = getSocketPath();

	// Check if daemon is actually running (not just stale socket)
	if (client.socketExists()) {
		const alive = await client.isRunning();
		if (alive) {
			console.log('Daemon already running. Use "sup down" to stop it first.');
			return;
		}

		// Stale socket - clean it up
		console.log('Cleaning up stale socket...');
		unlinkSync(socketPath);
	}

	// Always clean up any orphan processes on configured ports before starting
	try {
		const config = await loadConfig();
		let cleaned = false;
		for (const svc of config.services ?? []) {
			const hc = svc.healthCheck;
			if (hc?.type === 'port') {
				if (killPort(hc.port, svc.name)) {
					cleaned = true;
				}
			}
		}

		if (cleaned) {
			console.log('Cleaned up orphan processes');
			await sleep(500); // Give ports time to release
		}
	} catch {
		// Config might not load, that's ok
	}

	// Ensure .sup directory exists for daemon log
	const supDir = getSupDir();
	mkdirSync(supDir, {recursive: true});
	const logsDir = getLogsDir();
	mkdirSync(logsDir, {recursive: true});

	// Log daemon output to a file so we can debug crashes
	const daemonLogPath = `${supDir}/daemon.log`;
	const logFd = openSync(daemonLogPath, 'a');

	const child = spawn(process.execPath, [scriptPath, '_daemon'], {
		detached: true,
		stdio: ['ignore', logFd, logFd],
		cwd: process.cwd(),
	});
	child.unref();
	console.log(`Daemon started (pid ${child.pid})`);

	// Wait for socket to appear and verify connection
	for (let i = 0; i < 20; i++) {
		await sleep(250);
		if (await client.isRunning()) {
			console.log('Daemon ready');
			return;
		}
	}

	// Check if daemon crashed
	if (!client.socketExists()) {
		console.error('Daemon failed to start. Check .sup/daemon.log for errors.');
		process.exit(1);
	}

	console.log('Daemon starting... check "sup status"');
}

async function cmdDown() {
	const client = new Client();
	if (!await client.isRunning()) {
		// Clean up stale socket if it exists
		if (client.socketExists()) {
			unlinkSync(getSocketPath());
		}

		console.log('Daemon not running');
		return;
	}

	const res = await client.down();
	if (res.ok) {
		console.log('Daemon stopping...');
		// Wait for socket to disappear

		for (let i = 0; i < 10; i++) {
			await sleep(500);
			if (!existsSync(getSocketPath())) {
				console.log('Daemon stopped');
				return;
			}
		}
	} else {
		console.error(`Failed: ${res.error}`);
	}
}

async function cmdStatus() {
	// Try to read from daemon first
	const client = new Client();
	let status: StatusFile | null = null;

	if (await client.isRunning()) {
		status = await client.status();
	} else {
		// Fall back to status file
		const statusPath = getStatusPath();
		if (existsSync(statusPath)) {
			try {
				status = JSON.parse(readFileSync(statusPath, 'utf-8'));
			} catch {
				// Ignore parse errors
			}
		}
	}

	if (!status) {
		console.log('No status available. Daemon not running.');
		return;
	}

	// Print status
	console.log();
	if (status.daemon) {
		console.log(`Daemon: running (pid ${status.daemon.pid})`);
	} else {
		console.log('Daemon: not running');
	}

	console.log();

	// Print tasks table
	const tasks = Object.entries(status.tasks ?? {});
	if (tasks.length > 0) {
		console.log('Tasks:');
		console.log('─'.repeat(60));

		const maxTaskNameLen = Math.max(...tasks.map(([n]) => n.length));

		for (const [name, state] of tasks) {
			const statusIcon = getStatusIcon(state.status);
			const error = state.lastError ? `[${state.lastError}]` : '';

			console.log(`  ${statusIcon} ${name.padEnd(maxTaskNameLen)}  ${state.status.padEnd(10)} ${error}`);
		}

		console.log();
	}

	// Print service table
	const services = Object.entries(status.services);
	if (services.length === 0 && tasks.length === 0) {
		console.log('No services or tasks configured');
		return;
	}

	if (services.length > 0) {
		console.log('Services:');
		console.log('─'.repeat(60));

		const maxNameLen = Math.max(...services.map(([n]) => n.length));

		for (const [name, state] of services) {
			const statusIcon = getStatusIcon(state.status);
			const pid = state.pid ? `pid:${state.pid}` : '';
			const restarts = state.restarts > 0 ? `(${state.restarts} restarts)` : '';
			const error = state.lastError ? `[${state.lastError}]` : '';

			console.log(`  ${statusIcon} ${name.padEnd(maxNameLen)}  ${state.status.padEnd(10)} ${pid.padEnd(12)} ${restarts} ${error}`);
		}

		console.log();
	}
}

function getStatusIcon(status: string): string {
	switch (status) {
		case 'healthy': return '●';
		case 'starting': return '◐';
		case 'unhealthy': return '○';
		case 'stopped': return '■';
		case 'crashed': return '✗';
		case 'completed': return '✓';
		case 'running': return '◐';
		case 'failed': return '✗';
		case 'pending': return '○';
		default: return '?';
	}
}

async function cmdStart() {
	const service = subArgs[0];
	const client = new Client();

	if (!await client.isRunning()) {
		console.error('Daemon not running. Use "sup up" first.');
		process.exit(1);
	}

	const res = await client.start(service);
	if (res.ok) {
		console.log(service ? `Started ${service}` : 'Started all services');
	} else {
		console.error(`Failed: ${res.error}`);
		process.exit(1);
	}
}

async function cmdStop() {
	const service = subArgs[0];
	const client = new Client();

	if (!await client.isRunning()) {
		console.log('Daemon not running');
		return;
	}

	const res = await client.stop(service);
	if (res.ok) {
		console.log(service ? `Stopped ${service}` : 'Stopped all services');
	} else {
		console.error(`Failed: ${res.error}`);
		process.exit(1);
	}
}

async function cmdRestart() {
	const service = subArgs[0];
	const client = new Client();

	// If daemon not running, start it
	if (!await client.isRunning()) {
		await cmdUp();
		return;
	}

	const res = await client.restart(service);
	if (res.ok) {
		console.log(service ? `Restarted ${service}` : 'Restarted all services');
	} else {
		console.error(`Failed: ${res.error}`);
		process.exit(1);
	}
}

async function cmdLogs() {
	const service = subArgs.find((a) => !a.startsWith('-'));
	const follow = subArgs.includes('-f') || subArgs.includes('--follow');
	const lines = subArgs.find((a) => /^-n\d+$/.exec(a))?.slice(2) ?? '50';

	if (service) {
		// Single service logs
		const logPath = getLogPath(service);
		if (!existsSync(logPath)) {
			console.error(`No logs for ${service}`);
			process.exit(1);
		}

		if (follow) {
			spawn('tail', ['-f', logPath], {stdio: 'inherit'});
		} else {
			spawn('tail', [`-${lines}`, logPath], {stdio: 'inherit'});
		}
	} else {
		// All logs - tail all log files with prefix
		const logsDir = getLogsDir();
		if (!existsSync(logsDir)) {
			console.error('No logs directory found');
			process.exit(1);
		}

		const logFiles = readdirSync(logsDir)
			.filter((f) => f.endsWith('.log'))
			.map((f) => getLogPath(f.replace('.log', '')));

		if (logFiles.length === 0) {
			console.error('No log files found');
			process.exit(1);
		}

		if (follow) {
			// Use tail -f on all files with --prefix for service names
			spawn('tail', ['-f', ...logFiles], {stdio: 'inherit'});
		} else {
			// Show last N lines from each file
			spawn('tail', [`-n${lines}`, ...logFiles], {stdio: 'inherit'});
		}
	}
}

async function cmdKill() {
	console.log('Force killing all processes...');

	// Try graceful shutdown first
	const client = new Client();
	if (client.socketExists()) {
		try {
			await client.down();
			await sleep(1000);
		} catch {
			// Ignore errors
		}
	}

	// Clean up socket if it exists
	const socketPath = getSocketPath();
	if (existsSync(socketPath)) {
		unlinkSync(socketPath);
	}

	// Load config to get ports and kill anything on them
	try {
		const config = await loadConfig();

		for (const svc of config.services ?? []) {
			const hc = svc.healthCheck;
			if (hc?.type === 'port') {
				killPort(hc.port, svc.name);
			}
		}
	} catch {
		console.log('Could not load config, skipping port cleanup');
	}

	console.log('Done. Safe to run "sup up"');
}

function killPort(port: number, name: string): boolean {
	try {
		const pids = execSync(`lsof -t -i:${port} -sTCP:LISTEN 2>/dev/null`, {encoding: 'utf-8'}).trim();
		if (pids) {
			for (const pid of pids.split('\n')) {
				process.kill(parseInt(pid), 'SIGKILL');
				console.log(`  Killed ${name} (pid ${pid}) on port ${port}`);
			}

			return true;
		}
	} catch {
		// No process on port
	}

	return false;
}

function printHelp() {
	console.log(`
sup - Simple process supervisor

Usage: sup <command> [options]

Commands:
  up                Start daemon and all services
  down              Stop daemon and all services
  status            Show service status
  start [service]   Start a service (or all)
  stop [service]    Stop a service (or all)
  restart [service] Restart a service (or all)
  logs [service]    View logs (-f to follow, -n50 for line count)
  kill              Force kill all processes (cleanup)

Examples:
  sup up            Start everything
  sup status        Check what's running
  sup restart web   Restart the web service
  sup logs          View all logs
  sup logs api -f   Follow API logs
  sup kill          Clean up after crash
`);
}

// Internal command for daemonization
if (command === '_daemon') {
	loadConfig().then(startDaemon).catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
} else {
	void main();
}
