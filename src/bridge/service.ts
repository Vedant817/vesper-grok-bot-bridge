import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import type { Worker, WorkerEvent } from '../contracts.js';
import { classifyPermission, Redactor, RedactedRecords, within } from '../safety.js';
import { changes, createWorktree, git, verifyWorktree } from '../worktree.js';
import { verifier } from '../verification.js';
import { bridgeConfigSchema, type BridgeConfig } from './config.js';
import type { Provider } from './provider.js';
import type { Evidence, SessionSnapshot, StartSession } from './types.js';

interface Live { snapshot: SessionSnapshot; worker?: Worker; abort: AbortController; tail: Promise<unknown>; records: RedactedRecords; received: number }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const bounded = (value: string, label: string, limit = 16000) => { if (!value.trim() || value.length > limit) throw new Error(`Invalid ${label}`); };

/** Local owner chooses roots, executables, and verification. The MCP caller supplies decisions, never executable configuration. */
export class BridgeService {
  private readonly sessions = new Map<string, Live>();
  private startTail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly ownerToken = randomUUID();
  private constructor(private config: ReturnType<typeof bridgeConfigSchema.parse>, private providers: Provider[], private redactor: Redactor) {}
  static async create(input: BridgeConfig, providers: Provider[], redactor = new Redactor()): Promise<BridgeService> {
    const config = bridgeConfigSchema.parse(input);
    if (!isAbsolute(config.stateDirectory) || config.roots.some(r => !isAbsolute(r.directory))) throw new Error('Owner configuration paths must be absolute');
    for (const root of config.roots) {
      root.directory = await realpath(root.directory);
      if (await realpath(await git(root.directory, ['rev-parse', '--show-toplevel'])) !== root.directory) throw new Error('Enroll repository roots, not subdirectories');
    }
    await mkdir(config.stateDirectory, { recursive: true });
    config.stateDirectory = await realpath(config.stateDirectory);
    if (config.roots.some(r => within(r.directory, config.stateDirectory) || within(config.stateDirectory, r.directory))) throw new Error('State storage must be separate from enrolled repositories');
    if (new Set(config.imports.map(i => i.id)).size !== config.imports.length) throw new Error('Duplicate import IDs');
    for (const imported of config.imports) {
      if (!isAbsolute(imported.worktree)) throw new Error('Imported worktree must be absolute');
      imported.worktree = await realpath(imported.worktree); await verifyWorktree(imported.worktree);
      const common = await realpath(await git(imported.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
      let root: typeof config.roots[number] | undefined;
      for (const candidate of config.roots) if (await realpath(await git(candidate.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) === common) root = candidate;
      if (!root) throw new Error('Imported worktree must belong to an enrolled repository');
      imported.directory = imported.directory ? await realpath(imported.directory) : root.directory;
      if (!within(root.directory, imported.directory)) throw new Error('Imported directory outside enrolled repository');
    }
    if (new Set(providers.map(p => p.id)).size !== providers.length) throw new Error('Duplicate provider IDs');
    const service = new BridgeService(config, providers, redactor);
    await service.acquireOwner();
    try {
    await mkdir(join(config.stateDirectory, 'sessions'), { recursive: true });
    await mkdir(join(config.stateDirectory, 'worktrees'), { recursive: true });
    for (const name of await readdir(join(config.stateDirectory, 'sessions'))) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      const snapshot = JSON.parse(await readFile(join(config.stateDirectory, 'sessions', name), 'utf8')) as SessionSnapshot;
      if (snapshot.id + '.json' !== name || !Array.isArray(snapshot.events) || !Array.isArray(snapshot.pending)) throw new Error('Invalid persisted bridge session');
      if (['starting', 'running', 'awaiting_input'].includes(snapshot.status)) { snapshot.status = 'interrupted'; snapshot.pending = []; snapshot.error = 'Bridge restarted; reconnect explicitly with resume. Old approval requests are invalid.'; }
      service.sessions.set(snapshot.id, { snapshot, abort: new AbortController(), tail: Promise.resolve(), records: new RedactedRecords(redactor), received: snapshot.cursor });
    }
    return service;
    } catch (error) { await service.releaseOwner(); throw error; }
  }
  discover() { return this.providers.map(({ id, label, models, available, reason }) => ({ id, label, models, available, reason, imports: this.config.imports.filter(i => i.provider === id).map(i => ({ id: i.id, nativeId: i.nativeId, model: i.model, directory: i.directory })) })); }
  list() { return [...this.sessions.values()].map(l => this.public(l.snapshot)); }
  read(id: string, cursor = 0) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid cursor');
    const s = this.get(id).snapshot;
    return { ...this.public(s), events: s.events.filter(e => e.cursor > cursor), earliestCursor: s.events[0]?.cursor ?? s.cursor + 1, truncated: cursor < (s.events[0]?.cursor ?? 1) - 1 };
  }
  start(input: StartSession): Promise<SessionSnapshot> {
    const operation = this.startTail.then(async () => {
      if (this.closed) throw new Error('Bridge is closed');
      bounded(input.requestId, 'requestId', 200); bounded(input.task, 'task');
      const directory = await realpath(input.directory), root = this.config.roots.find(r => within(r.directory, directory));
      if (!isAbsolute(input.directory) || !root) throw new Error('Directory is outside owner-enrolled roots');
      const fingerprint = digest(JSON.stringify({ ...input, directory }));
      const previous = [...this.sessions.values()].find(l => l.snapshot.requestId === input.requestId);
      if (previous) { if (previous.snapshot.fingerprint !== fingerprint) throw new Error('requestId already used for different input'); return this.public(previous.snapshot); }
      if (this.sessions.size >= this.config.maxSessions) throw new Error('Session capacity reached');
      const provider = this.provider(input.provider, input.model);
      const worktree = await createWorktree(root.directory, join(this.config.stateDirectory, 'worktrees'));
      const cwd = await realpath(join(worktree, relative(root.directory, directory)));
      if (!within(worktree, cwd)) throw new Error('Worker directory escapes worktree');
      const snapshot: SessionSnapshot = { id: randomUUID(), provider: input.provider, model: input.model, directory, worktree, cwd, status: 'starting', turns: 1, task: input.task, taskHashes: [digest(input.task)], requestId: input.requestId, fingerprint, cursor: 0, events: [], pending: [] };
      const live: Live = { snapshot, abort: new AbortController(), tail: Promise.resolve(), records: new RedactedRecords(this.redactor), received: 0 }; this.sessions.set(snapshot.id, live);
      await this.persist(live);
      try { live.worker = await provider.create({ model: input.model }); await live.worker.start(cwd, input.task); snapshot.nativeId = live.worker.nativeSessionId; snapshot.status = 'running'; await this.persist(live); this.pump(live); }
      catch (error) { snapshot.status = 'failed'; snapshot.error = this.safeError(error); await live.worker?.close().catch(() => {}); await this.persist(live); }
      return this.public(snapshot);
    });
    this.startTail = operation.catch(() => {}); return operation;
  }
  attach(importId: string, task: string, requestId: string): Promise<SessionSnapshot> {
    const operation = this.startTail.then(async () => {
      if (this.closed) throw new Error('Bridge is closed'); bounded(task, 'task'); bounded(requestId, 'requestId', 200);
      const imported = this.config.imports.find(i => i.id === importId); if (!imported) throw new Error('Session import is not enrolled by owner');
      const fingerprint = digest(JSON.stringify({ importId, task, requestId }));
      const existing = [...this.sessions.values()].find(l => l.snapshot.requestId === requestId);
      if (existing) { if (existing.snapshot.fingerprint !== fingerprint) throw new Error('requestId already used for different input'); return this.public(existing.snapshot); }
      if ([...this.sessions.values()].some(l => ((l.snapshot.provider === imported.provider && l.snapshot.nativeId === imported.nativeId) || l.snapshot.worktree === imported.worktree) && !['cancelled', 'finished', 'failed'].includes(l.snapshot.status))) throw new Error('Imported session already managed');
      if (this.sessions.size >= this.config.maxSessions) throw new Error('Session capacity reached');
      const provider = this.provider(imported.provider, imported.model);
      const root = this.config.roots.find(r => within(r.directory, imported.directory!))!;
      const cwd = await realpath(join(imported.worktree, relative(root.directory, imported.directory!)));
      const snapshot: SessionSnapshot = { id: randomUUID(), importId, provider: imported.provider, model: imported.model, directory: imported.directory!, nativeId: imported.nativeId, worktree: imported.worktree, cwd, status: 'starting', turns: 1, task, taskHashes: [digest(task)], requestId, fingerprint, cursor: 0, events: [], pending: [] };
      await this.validatePaths(snapshot);
      const live: Live = { snapshot, abort: new AbortController(), tail: Promise.resolve(), records: new RedactedRecords(this.redactor), received: 0 }; this.sessions.set(snapshot.id, live); await this.persist(live);
      try { live.worker = provider.create({ model: imported.model, resumeId: imported.nativeId }); await live.worker.start(cwd, task); snapshot.nativeId = live.worker.nativeSessionId ?? imported.nativeId; snapshot.status = 'running'; await this.persist(live); this.pump(live); }
      catch (error) { snapshot.status = 'failed'; snapshot.error = this.safeError(error); await live.worker?.close().catch(() => {}); await this.persist(live); }
      return this.public(snapshot);
    });
    this.startTail = operation.catch(() => {}); return operation;
  }
  async respond(id: string, requestId: string, response: { allow?: boolean; answer?: string }) {
    return this.lock(this.get(id), async l => {
      const s = l.snapshot, pending = s.pending.find(p => p.id === requestId);
      if (!pending || !l.worker || s.status !== 'awaiting_input') throw new Error('No live pending request');
      if (pending.type === 'question') {
        bounded(response.answer ?? '', 'answer');
        if (pending.options?.length && !pending.options.includes(response.answer!) && !pending.allowCustomAnswer) throw new Error('Answer must match an offered option');
      } else if (response.allow) {
        const permission = { ...pending.request };
        if (permission.cwd) permission.cwd = await realpath(permission.cwd).catch(() => undefined);
        if (classifyPermission(permission, s.worktree).risk === 'blocked') throw new Error('Blocked permission cannot be approved');
      }
      await l.worker.respond(requestId, { allow: pending.type === 'question' || response.allow === true, answer: response.answer });
      s.pending = s.pending.filter(p => p.id !== requestId); s.status = s.pending.length ? 'awaiting_input' : 'running'; await this.persist(l); return this.public(s);
    });
  }
  async followup(id: string, task: string) {
    bounded(task, 'task');
    return this.lock(this.get(id), async l => {
      if (l.snapshot.status !== 'awaiting_review' || !l.worker) throw new Error('Follow-up requires a completed live turn');
      if (l.snapshot.turns >= this.config.maxTurns) throw new Error('Turn limit reached');
      if ((l.snapshot.taskHashes ?? [digest(l.snapshot.task)]).includes(digest(task))) throw new Error('Repeated identical follow-up rejected');
      await l.worker.steer(task); l.snapshot.task = task; (l.snapshot.taskHashes ??= []).push(digest(task)); l.snapshot.turns++; l.snapshot.evidence = undefined; l.snapshot.status = 'running'; await this.persist(l); return this.public(l.snapshot);
    });
  }
  async resume(id: string, task: string) {
    bounded(task, 'task');
    return this.lock(this.get(id), async l => {
      const s = l.snapshot;
      if (!(s.status === 'interrupted' || (s.status === 'awaiting_review' && !l.worker)) || !s.nativeId) throw new Error('Only disconnected sessions with a native ID can resume');
      if (s.turns >= this.config.maxTurns) throw new Error('Turn limit reached');
      await this.validatePaths(s);
      const worker = await this.provider(s.provider, s.model).create({ model: s.model, resumeId: s.nativeId });
      try { await worker.start(s.cwd, task); } catch (error) { await worker.close().catch(() => {}); throw error; }
      l.worker = worker; l.abort = new AbortController(); s.task = task; s.turns++; s.pending = []; s.evidence = undefined; s.status = 'running'; s.nativeId = worker.nativeSessionId ?? s.nativeId; await this.persist(l); this.pump(l); return this.public(s);
    });
  }
  async verify(id: string): Promise<Evidence> {
    return this.lock(this.get(id), async l => {
      const s = l.snapshot;
      if (s.status !== 'awaiting_review') throw new Error('Verification requires a completed turn');
      await this.validatePaths(s);
      const root = this.config.roots.find(r => within(r.directory, s.directory))!;
      const before = await this.fingerprint(s);
      const result = await verifier(root.verify.executable, root.verify.args, this.redactor, root.verify.env)(s.cwd, l.abort.signal);
      const after = await this.fingerprint(s);
      const summary = await changes(s.worktree);
      const evidence: Evidence = { id: randomUUID(), passed: result.passed && before === after, output: result.output, head: await git(s.worktree, ['rev-parse', 'HEAD']), contentHash: after, changes: summary };
      s.evidence = evidence; await this.persist(l); return this.clean(evidence);
    });
  }
  async finish(id: string, evidenceId: string) {
    return this.lock(this.get(id), async l => {
      const s = l.snapshot;
      if (s.status !== 'awaiting_review' || !s.evidence?.passed || s.evidence.id !== evidenceId) throw new Error('Passing current verification evidence is required');
      await this.validatePaths(s);
      if (await this.fingerprint(s) !== s.evidence.contentHash) throw new Error('Worktree changed after verification');
      l.abort.abort(); await this.stop(l); s.status = 'finished'; await this.persist(l); return this.public(s);
    });
  }
  async cancel(id: string) {
    const live = this.get(id); live.abort.abort(); const stopped = this.stop(live);
    return this.lock(live, async l => {
      if (['finished', 'cancelled'].includes(l.snapshot.status)) return this.public(l.snapshot);
      const interrupted = await stopped; if (!interrupted) l.snapshot.error = 'Local session cancelled; worker interruption was not acknowledged.'; l.snapshot.pending = []; l.snapshot.status = 'cancelled'; await this.persist(l); return this.public(l.snapshot);
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    const stopping = new Map<Live, Promise<boolean>>();
    for (const l of this.sessions.values()) { l.abort.abort(); stopping.set(l, this.stop(l)); }
    await this.startTail;
    await Promise.all([...this.sessions.values()].map(l => this.lock(l, async () => {
      l.abort.abort(); await (stopping.get(l) ?? this.stop(l));
      if (['starting', 'running', 'awaiting_input'].includes(l.snapshot.status)) { l.snapshot.status = 'interrupted'; l.snapshot.pending = []; }
      await this.persist(l);
    })));
    await this.releaseOwner();
  }
  private pump(l: Live) {
    void (async () => {
      try {
        while (!l.abort.signal.aborted && l.worker) {
          const event = await l.worker.next(l.abort.signal);
          await this.lock(l, async () => {
            if (l.abort.signal.aborted || ['failed', 'cancelled', 'finished', 'interrupted'].includes(l.snapshot.status)) return;
            const s = l.snapshot; s.nativeId = l.worker?.nativeSessionId ?? s.nativeId;
            if (++l.received >= 10000) throw new Error('Session event limit reached');
            if (event.type === 'output') {
              for (const line of l.records.push(event.text)) this.event(l, { type: 'output', text: line });
              await this.persist(l);
              return;
            }
            if (event.type === 'completed' || event.type === 'failed') { const finalOutput = l.records.end(); if (finalOutput) this.event(l, { type: 'output', text: finalOutput }); }
            this.event(l, event);
            if (event.type === 'question' || event.type === 'permission') {
              if (s.pending.some(p => p.id === event.id)) throw new Error('Duplicate pending request ID');
              if (s.pending.length >= 50) throw new Error('Pending request limit reached');
              s.pending.push(this.clean(event)); s.status = 'awaiting_input';
            } else if (event.type === 'completed') { if (s.pending.length) throw new Error('Worker completed with unresolved input'); s.status = 'awaiting_review'; }
            else if (event.type === 'failed') { s.status = 'failed'; s.error = this.redactor.redact(event.error); }
            await this.persist(l);
          });
        }
      } catch (error) {
        if (!l.abort.signal.aborted) await this.lock(l, async () => {
          if (l.abort.signal.aborted || ['cancelled', 'finished', 'interrupted'].includes(l.snapshot.status)) return;
          l.snapshot.status = 'failed'; l.snapshot.error = this.safeError(error); l.abort.abort(); await l.worker?.close().catch(() => {}); await this.persist(l);
        });
      }
    })();
  }
  private provider(id: string, model: string) { bounded(model, 'model', 200); const provider = this.providers.find(p => p.id === id); if (!provider?.available) throw new Error('Requested provider is unavailable'); if (provider.models.length && !provider.models.includes(model)) throw new Error('Requested model is not registered for this provider'); return provider; }
  private get(id: string) { const l = this.sessions.get(id); if (!l) throw new Error('Unknown session'); return l; }
  private async validatePaths(s: SessionSnapshot) {
    if (!this.config.roots.some(r => within(r.directory, s.directory))) throw new Error('Session repository is no longer enrolled');
    const worktree = await realpath(s.worktree), cwd = await realpath(s.cwd), owned = await realpath(join(this.config.stateDirectory, 'worktrees'));
    const imported = s.importId && this.config.imports.find(i => i.id === s.importId && i.worktree === worktree && i.provider === s.provider && i.model === s.model);
    if ((!within(owned, worktree) && !imported) || !within(worktree, cwd)) throw new Error('Session path escapes owned worktrees');
    await verifyWorktree(worktree);
    const root = this.config.roots.find(r => within(r.directory, s.directory))!;
    if (await realpath(await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== await realpath(await git(root.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) throw new Error('Session worktree belongs to a different repository');
  }
  private event(l: Live, event: WorkerEvent) {
    const safe = this.clean(event);
    if (safe.type === 'output') safe.text = safe.text.slice(0, 16000);
    if (safe.type === 'completed') safe.summary = safe.summary.slice(0, 16000);
    l.snapshot.events.push({ cursor: ++l.snapshot.cursor, event: safe }); l.snapshot.events = l.snapshot.events.slice(-this.config.maxEvents);
  }
  private async stop(l: Live) {
    const bounded = async (operation: Promise<unknown>): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([operation.then(() => true, () => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 2000); })]); }
      finally { if (timer) clearTimeout(timer); }
    };
    const interrupted = await bounded(Promise.resolve().then(() => l.worker?.cancel()));
    await bounded(Promise.resolve().then(() => l.worker?.close()));
    return interrupted;
  }
  private async fingerprint(s: SessionSnapshot) { return digest(await git(s.worktree, ['rev-parse', 'HEAD']) + '\0' + (await changes(s.worktree)).contentHash); }
  private lock<T>(l: Live, operation: (live: Live) => Promise<T>): Promise<T> { const result = l.tail.then(() => operation(l)); l.tail = result.catch(() => {}); return result; }
  private clean<T>(value: T): T { return JSON.parse(this.redactor.json(value)) as T; }
  private public(snapshot: SessionSnapshot) { return this.clean(snapshot); }
  private safeError(error: unknown) { return this.redactor.redact(error instanceof Error ? error.message : String(error)); }
  private async acquireOwner() {
    const path = join(this.config.stateDirectory, 'owner.json');
    const guard = join(this.config.stateDirectory, 'owner-acquisition');
    try { await mkdir(guard); } catch { throw new Error('Bridge state owner acquisition already in progress'); }
    try {
    try {
      const previous = JSON.parse(await readFile(path, 'utf8')) as { pid: number };
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('Bridge state directory already has a live owner');
      await unlink(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const handle = await open(path, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token: this.ownerToken })); } finally { await handle.close(); }
    } finally { await rmdir(guard); }
  }
  private async releaseOwner() {
    const path = join(this.config.stateDirectory, 'owner.json');
    const owner = JSON.parse(await readFile(path, 'utf8')) as { token: string };
    if (owner.token === this.ownerToken) await unlink(path);
  }
  private async persist(l: Live) { const target = join(this.config.stateDirectory, 'sessions', l.snapshot.id + '.json'); const temporary = target + '.' + randomUUID() + '.tmp'; await writeFile(temporary, this.redactor.json(l.snapshot), { mode: 0o600 }); await rename(temporary, target); }
}
