import {Socket} from 'net';
import {existsSync} from 'fs';
import type {Command, Response, StatusFile} from './types.js';
import {getSocketPath} from './config.js';

export class Client {
	private readonly socketPath: string;

	constructor(cwd: string = process.cwd()) {
		this.socketPath = getSocketPath(cwd);
	}

	isRunning(): boolean {
		return existsSync(this.socketPath);
	}

	async send(cmd: Command): Promise<Response> {
		return new Promise((resolve, reject) => {
			if (!this.isRunning()) {
				resolve({ok: false, error: 'Daemon not running. Use "sup up" to start.'});
				return;
			}

			const socket = new Socket();
			let buffer = '';

			socket.setTimeout(10000);

			socket.on('connect', () => {
				socket.write(`${JSON.stringify(cmd)}\n`);
			});

			socket.on('data', (data) => {
				buffer += data.toString();
				const lines = buffer.split('\n');
				for (const line of lines) {
					if (line.trim()) {
						try {
							const response = JSON.parse(line) as Response;
							socket.destroy();
							resolve(response);
							return;
						} catch {
							// Continue collecting data
						}
					}
				}
			});

			socket.on('error', (err) => {
				reject(new Error(`Socket error: ${err.message}`));
			});

			socket.on('timeout', () => {
				socket.destroy();
				reject(new Error('Socket timeout'));
			});

			socket.connect(this.socketPath);
		});
	}

	async status(): Promise<StatusFile | null> {
		const res = await this.send({cmd: 'status'});
		if (res.ok && res.data) {
			return res.data as StatusFile;
		}

		return null;
	}

	async start(service?: string): Promise<Response> {
		return this.send(service ? {cmd: 'start', service} : {cmd: 'start'});
	}

	async stop(service?: string): Promise<Response> {
		return this.send(service ? {cmd: 'stop', service} : {cmd: 'stop'});
	}

	async restart(service?: string): Promise<Response> {
		return this.send(service ? {cmd: 'restart', service} : {cmd: 'restart'});
	}

	async logs(service: string, lines?: number): Promise<string | null> {
		const res = await this.send(lines ? {cmd: 'logs', service, lines} : {cmd: 'logs', service});
		if (res.ok && typeof res.data === 'string') {
			return res.data;
		}

		return null;
	}

	async down(): Promise<Response> {
		return this.send({cmd: 'down'});
	}
}
