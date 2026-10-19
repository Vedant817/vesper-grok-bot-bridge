import { it, expect } from 'vitest';
import { touchedSymbols } from '../src/symbols.js';
import { runTaskGraph } from '../src/task-graph.js';
it('summarizes changed AST functions without carrying function bodies', () => {
  const before = 'export function unchanged(){return 1;} export function changed(){return 2;}';
  const after = 'export function unchanged(){return 1;} export function changed(){return 3;} const added=()=>4;';
  expect(touchedSymbols('sample.ts', before, after)).toEqual(['changed', 'added']);
  expect(touchedSymbols('sample.ts', 'const a={m(){return 1}}; const b={m(){return 2}};', 'const a={m(){return 9}}; const b={m(){return 2}};')).toContain('a.m');
});
it('skips failed dependencies and continues independent isolated milestones', async () => {
  const calls: string[] = [];
  const result = await runTaskGraph([{ id: 'a', goal: 'A', dependsOn: [] }, { id: 'b', goal: 'B', dependsOn: ['a'] }, { id: 'c', goal: 'C', dependsOn: [] }], async task => {
    calls.push(task.id); return { state: task.id === 'a' ? 'failed' : 'completed', reason: 'test' };
  });
  expect(calls).toEqual(['a', 'c']); expect(result.b.state).toBe('skipped');
});
