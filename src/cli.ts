#!/usr/bin/env node
/* eslint-disable no-await-in-loop */

import {spawn, execSync} from 'child_process';
import {existsSync, readFileSync} from 'fs';
import {
	loadConfig, getSocketPath, getStatusPath, getLogPath,
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
	const daemonize = subArgs.includes('-d') || subArgs.includes('--daemon');
	const config = await loadConfig();

	if (daemonize) {
		// Fork a detached process
		const scriptPath = process.argv[1];
		if (!scriptPath) {
			throw new Error('Could not determine script path');
		}

		const child = spawn(process.execPath, [scriptPath, '_daemon'], {
			detached: true,
			stdio: 'ignore',
			cwd: process.cwd(),
		});
		child.unref();
		console.log(`Daemon started in background (pid ${child.pid})`);

		// Wait briefly for socket to appear
		await sleep(1000);

		if (existsSync(getSocketPath())) {
			console.log('Daemon is ready');
		} else {
			console.log('Daemon starting... check status with "sup status"');
		}
	} else {
		// Foreground mode
		await startDaemon(config);
	}
}

async function cmdDown() {
	const client = new Client();
	if (!client.isRunning()) {
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

	if (client.isRunning()) {
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

	// Print service table
	const services = Object.entries(status.services);
	if (services.length === 0) {
		console.log('No services configured');
		return;
	}

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

function getStatusIcon(status: string): string {
	switch (status) {
		case 'healthy': return '●';
		case 'starting': return '◐';
		case 'unhealthy': return '○';
		case 'stopped': return '■';
		case 'crashed': return '✗';
		default: return '?';
	}
}

async function cmdStart() {
	const service = subArgs[0];
	const client = new Client();

	if (!client.isRunning()) {
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

	if (!client.isRunning()) {
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

	if (!client.isRunning()) {
		console.error('Daemon not running. Use "sup up" first.');
		process.exit(1);
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
	const service = subArgs[0];
	const follow = subArgs.includes('-f') || subArgs.includes('--follow');

	if (!service) {
		console.error('Usage: sup logs <service> [-f]');
		process.exit(1);
	}

	const logPath = getLogPath(service);

	if (!existsSync(logPath)) {
		console.error(`No logs for ${service}`);
		process.exit(1);
	}

	if (follow) {
		// Use tail -f
		spawn('tail', ['-f', logPath], {stdio: 'inherit'});
	} else {
		// Show last 50 lines
		const lines = subArgs.find((a) => /^-n\d+$/.exec(a))?.slice(2) ?? '50';
		spawn('tail', [`-${lines}`, logPath], {stdio: 'inherit'});
	}
}

async function cmdKill() {
	console.log('Force killing all processes...');

	// Kill daemon if running
	const client = new Client();
	if (client.isRunning()) {
		try {
			await client.down();
		} catch {
			// Ignore errors
		}
	}

	// Load config to get ports
	try {
		const config = await loadConfig();

		for (const svc of config.services) {
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

function killPort(port: number, name: string) {
	try {
		const pids = execSync(`lsof -t -i:${port} -sTCP:LISTEN 2>/dev/null`, {encoding: 'utf-8'}).trim();
		if (pids) {
			for (const pid of pids.split('\n')) {
				process.kill(parseInt(pid), 'SIGKILL');
				console.log(`  Killed ${name} (pid ${pid}) on port ${port}`);
			}
		}
	} catch {
		// No process on port
	}
}

function printHelp() {
	console.log(`
sup - Simple process supervisor

Usage: sup <command> [options]

Commands:
  up [-d]           Start all services (use -d to daemonize)
  down              Stop daemon and all services
  status            Show service status
  start [service]   Start a service (or all if not specified)
  stop [service]    Stop a service (or all if not specified)
  restart [service] Restart a service (or all if not specified)
  logs <service>    View logs (-f to follow)
  kill              Force kill all processes (cleanup)
  help              Show this help

Examples:
  sup up            Start all services in foreground
  sup up -d         Start as background daemon
  sup status        Check what's running
  sup restart web   Restart the web service
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
