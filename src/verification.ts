import { spawn } from 'node:child_process';
import { childEnvironment } from './rpc.js';
import { Redactor, RedactedRecords } from './safety.js';
import type { Verification } from './supervisor.js';

/** Owner-configured verifier only. Workers/models never choose this command. */
export function verifier(executable: string, args: string[], redactor: Redactor, env?: Record<string, string>) {
  return async (cwd: string, signal: AbortSignal): Promise<Verification> => {
    if (signal.aborted) throw signal.reason;
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd, env: childEnvironment(env), shell: false, windowsHide: true, signal, timeout: 120000 });
      const records = new RedactedRecords(redactor); let output = ''; let truncated = false;
      const capture = (chunk: Buffer) => { for (const line of records.push(chunk.toString('utf8'))) { output += line + '\n'; if (Buffer.byteLength(output) > 12000) { output = output.slice(-6000); truncated = true; } } };
      child.stdout.on('data', capture); child.stderr.on('data', capture);
      child.on('error', reject);
      child.on('close', code => resolve({ passed: code === 0 && !signal.aborted, output: (truncated ? '[earlier output omitted]\n' : '') + output + records.end() }));
    });
  };
}
