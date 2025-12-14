import {test, expect} from 'vitest';
import {
	getSupDir, getSocketPath, getStatusPath, getLogsDir, getLogPath,
} from './index.js';

test('getSupDir returns .sup directory', () => {
	expect(getSupDir('/home/user/project')).toBe('/home/user/project/.sup');
});

test('getSocketPath returns socket path', () => {
	expect(getSocketPath('/home/user/project')).toBe('/home/user/project/.sup/sup.sock');
});

test('getStatusPath returns status file path', () => {
	expect(getStatusPath('/home/user/project')).toBe('/home/user/project/.sup/status.json');
});

test('getLogsDir returns logs directory', () => {
	expect(getLogsDir('/home/user/project')).toBe('/home/user/project/.sup/logs');
});

test('getLogPath returns log file path for service', () => {
	expect(getLogPath('web', '/home/user/project')).toBe('/home/user/project/.sup/logs/web.log');
});
