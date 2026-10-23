import { describe, expect, it } from 'vitest';
import { main } from '../src/index.js';

// Only synchronous validation paths: these invocations throw before any I/O.
describe('CLI argument validation', () => {
  it('rejects bridge-call without a loopback URL and agent tool', async () => {
    await expect(main(['bridge-call'])).rejects.toThrow('Usage: grok-supervisor bridge-call <loopback MCP URL> <agent_tool> <arguments.json>');
    await expect(main(['bridge-call', 'http://127.0.0.1:3001/mcp'])).rejects.toThrow('Usage: grok-supervisor bridge-call');
  });
  it('rejects bridge-call tools outside the agent_ namespace', async () => {
    await expect(main(['bridge-call', 'http://127.0.0.1:3001/mcp', 'file_read'])).rejects.toThrow('Usage: grok-supervisor bridge-call');
  });
  it('rejects unknown modes with the help hint', async () => {
    await expect(main(['definitely-not-a-mode'])).rejects.toThrow('Invalid command; use --help');
  });
});
