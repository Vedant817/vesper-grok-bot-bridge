export interface Task { id: string; goal: string; dependsOn: string[] }
/** Validate the complete DAG before any worker side effects. Execute one isolated
 * milestone at a time; dependencies never proceed after a stopped/failed task. */
export function orderTasks(tasks: readonly Task[]): Task[] {
  const byId = new Map(tasks.map(t => [t.id, t]));
  if (byId.size !== tasks.length || tasks.some(t => !t.id || !t.goal)) throw new Error('Task ids and goals must be nonempty and unique');
  const visiting = new Set<string>(), done = new Set<string>(), result: Task[] = [];
  function visit(id: string): void {
    if (done.has(id)) return;
    if (visiting.has(id)) throw new Error('Task dependency cycle');
    const task = byId.get(id); if (!task) throw new Error('Missing task dependency');
    visiting.add(id); for (const dep of task.dependsOn) visit(dep);
    visiting.delete(id); done.add(id); result.push(task);
  }
  for (const task of tasks) visit(task.id);
  return result;
}
