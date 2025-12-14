import {existsSync} from 'fs';
import {readFile} from 'fs/promises';
import {resolve, extname} from 'path';
import {pathToFileURL} from 'url';
import type {Config} from './types.js';

const CONFIG_NAMES = ['sup.config.ts', 'sup.config.js', 'sup.config.mjs', 'sup.config.json'];

export async function loadConfig(cwd: string = process.cwd()): Promise<Config> {
	for (const name of CONFIG_NAMES) {
		const configPath = resolve(cwd, name);
		if (existsSync(configPath)) {
			return loadConfigFile(configPath);
		}
	}

	throw new Error(`No config file found. Create one of: ${CONFIG_NAMES.join(', ')}`);
}

async function loadConfigFile(configPath: string): Promise<Config> {
	const ext = extname(configPath);

	if (ext === '.json') {
		const content = await readFile(configPath, 'utf-8');
		return JSON.parse(content) as Config;
	}

	if (ext === '.ts') {
		// For TypeScript, we need tsx or ts-node to be available
		// Dynamic import with tsx loader
		try {
			const module = await import(pathToFileURL(configPath).href);
			return module.default as Config;
		} catch {
			throw new Error('Failed to load TypeScript config. Make sure tsx is installed: npm install -D tsx');
		}
	}

	// .js or .mjs
	const module = await import(pathToFileURL(configPath).href);
	return module.default as Config;
}

export function getSupDir(cwd: string = process.cwd()): string {
	return resolve(cwd, '.sup');
}

export function getSocketPath(cwd: string = process.cwd()): string {
	return resolve(getSupDir(cwd), 'sup.sock');
}

export function getStatusPath(cwd: string = process.cwd()): string {
	return resolve(getSupDir(cwd), 'status.json');
}

export function getLogsDir(cwd: string = process.cwd()): string {
	return resolve(getSupDir(cwd), 'logs');
}

export function getLogPath(service: string, cwd: string = process.cwd()): string {
	return resolve(getLogsDir(cwd), `${service}.log`);
}
