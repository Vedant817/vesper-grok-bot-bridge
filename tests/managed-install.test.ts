import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse } from 'jsonc-parser';
import { managedPaths } from '../src/managed/paths.js';
import { inferVerifier, launcherSource } from '../src/managed/install.js';
import { startupScript, startupTaskName } from '../src/managed/startup.js';
import { mergeOpenCodeConfig } from '../src/managed/clients.js';

const dirs: string[] = [];
async function temporary() { const directory = await mkdtemp(join(tmpdir(), 'bridge-install-test-')); dirs.push(directory); return directory; }
afterEach(async () => { for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true }); });
describe('managed installation contracts', () => {
  it('preserves OpenCode JSONC comments and unrelated provider settings', () => {
    const paths = managedPaths(join(tmpdir(), 'bridge user'));
    const initial = '{\n // user provider\n "model":"user/model", "mcp":{"existing":{"type":"remote","url":"https://example.test"}},\n}';
    const merged = mergeOpenCodeConfig(initial, paths);
    expect(merged.changed).toBe(true); expect(merged.text).toContain('// user provider');
    const config = parse(merged.text);
    expect(config.model).toBe('user/model'); expect(config.mcp.existing.url).toBe('https://example.test');
    expect(config.mcp['coding-agent-bridge'].command).toEqual([process.execPath, paths.launcher, 'connect']);
    expect(mergeOpenCodeConfig(merged.text, paths).changed).toBe(false);
    expect(merged.text).not.toMatch(/Bearer|credential|token/i);
  });
  it('rejects malformed config and preserves conflicting MCP registration', () => {
    const paths = managedPaths(join(tmpdir(), 'bridge'));
    expect(() => mergeOpenCodeConfig('{"broken":', paths)).toThrow('valid JSONC');
    expect(() => mergeOpenCodeConfig('{"mcp":{"coding-agent-bridge":{"type":"remote","url":"https://other"}}}', paths)).toThrow('conflicts');
  });
  it('requires a real owner verifier rather than manufacturing success', async () => {
    const directory = await temporary();
    expect(await inferVerifier(directory)).toBeUndefined();
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(await inferVerifier(directory)).toBeUndefined();
    const explicit = { executable: process.execPath, args: ['verify.mjs'] };
    expect(await inferVerifier(directory, explicit)).toEqual(explicit);
    await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts: { check: 'tsc --noEmit && vitest run', test: 'vitest run' } }));
    const inferred = await inferVerifier(directory);
    expect(inferred?.args.slice(-2)).toEqual(['run', 'check']);
    expect(inferred?.executable).toBe(process.execPath);
  });
  it('generates a private-home launcher using a release receipt, independent of checkout', () => {
    const home = join(tmpdir(), "owner's bridge");
    const source = launcherSource(home);
    expect(source).toContain(JSON.stringify(home)); expect(source).toContain('installation.json');
    expect(source).toContain('i.entrypoint'); expect(source).toContain('GROK_AGENT_BRIDGE_HOME');
    expect(source).not.toContain('MCP_SERVER_TOKEN');
  });
  it('scopes logon startup identity to installation and requests restart without elevation', () => {
    const a = managedPaths(join(tmpdir(), "user's bridge")), b = managedPaths(join(tmpdir(), 'other-bridge'));
    expect(startupTaskName(a)).not.toEqual(startupTaskName(b));
    const script = startupScript(a, 'C:\\Node\\node.exe');
    expect(script).toContain('-RunLevel Limited'); expect(script).toContain('-LogonType Interactive');
    expect(script).toContain('-Hidden'); expect(script).toContain('-RestartCount 3');
    expect(script).toContain('-ExecutionTimeLimit ([TimeSpan]::Zero)');
    expect(script).toContain("user''s bridge"); expect(script).not.toContain('credential.bin');
  });
});
