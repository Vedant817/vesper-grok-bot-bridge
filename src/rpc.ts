import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import WebSocket from "ws";

export class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: {
    resolve: (v: T) => void;
    reject: (e: Error) => void;
    cleanup: () => void;
  }[] = [];
  private error?: Error;
  constructor(private readonly limit = 1000) {}
  push(value: T): void {
    if (this.error) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.cleanup();
      waiter.resolve(value);
    } else if (this.values.length >= this.limit)
      this.close(new Error("Event queue overflow"));
    else this.values.push(value);
  }
  next(signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.error) return Promise.reject(this.error);
    if (this.values.length) return Promise.resolve(this.values.shift()!);
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(signal.reason);
      };
      const waiter = {
        resolve,
        reject,
        cleanup: () => signal.removeEventListener("abort", abort),
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  close(error = new Error("Connection closed")): void {
    this.error = error;
    this.values = [];
    for (const w of this.waiters.splice(0)) {
      w.cleanup();
      w.reject(error);
    }
  }
}
export type RpcMessage = {
  jsonrpc?: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};
export interface Wire {
  send(message: RpcMessage): void;
  close(): void;
  onMessage?: (m: RpcMessage) => void;
  onClose?: (error: Error) => void;
}
export class Rpc {
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      cleanup: () => void;
    }
  >();
  private closed = false;
  onRequest?: (message: RpcMessage) => void;
  onNotification?: (message: RpcMessage) => void;
  onClose?: (error: Error) => void;
  constructor(
    private readonly wire: Wire,
    private readonly timeoutMs = 30000,
    private readonly jsonrpc = true,
  ) {
    wire.onMessage = (message) => {
      if (this.closed) return;
      if (message.method) {
        if (message.id !== undefined) this.onRequest?.(message);
        else this.onNotification?.(message);
        return;
      }
      const entry = this.pending.get(message.id as number);
      if (!entry) return;
      this.pending.delete(message.id as number);
      entry.cleanup();
      if (message.error)
        entry.reject(
          new Error(`RPC ${message.error.code}: ${message.error.message}`),
        );
      else entry.resolve(message.result);
    };
    wire.onClose = (error) => this.fail(error);
  }
  request<T = any>(
    method: string,
    params: unknown,
    options: { timeoutMs?: number | null; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("RPC closed"));
    if (options.signal?.aborted)
      return Promise.reject(options.signal.reason ?? new Error("RPC aborted"));
    const timeout =
      options.timeoutMs === undefined ? this.timeoutMs : options.timeoutMs;
    // Whole-turn requests must have an explicit lifecycle owner; ordinary RPCs retain their deadline.
    if (timeout === null && !options.signal)
      return Promise.reject(
        new Error("RPC without timeout requires a lifecycle signal"),
      );
    if (
      timeout !== null &&
      (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647)
    )
      return Promise.reject(new Error("Invalid RPC timeout"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const fail = (error: unknown) => {
        this.pending.delete(id);
        cleanup();
        reject(error);
      };
      const abort = () =>
        fail(options.signal?.reason ?? new Error("RPC aborted"));
      if (timeout !== null)
        timer = setTimeout(
          () => fail(new Error(`RPC timeout: ${method}`)),
          timeout,
        );
      this.pending.set(id, { resolve, reject, cleanup });
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send({ id, method, params });
      } catch (e) {
        fail(e);
      }
    });
  }
  notify(method: string, params?: unknown): void {
    this.send({ method, ...(params === undefined ? {} : { params }) });
  }
  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }
  reject(id: string | number, message = "Unsupported method"): void {
    this.send({ id, error: { code: -32601, message } });
  }
  private send(message: RpcMessage): void {
    if (this.closed) throw new Error("RPC closed");
    this.wire.send(this.jsonrpc ? { jsonrpc: "2.0", ...message } : message);
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(error);
    }
    this.pending.clear();
    this.onClose?.(error);
  }
  close(): void {
    this.fail(new Error("RPC closed"));
    this.wire.close();
  }
}

/** Child credentials are opt-in; never inherit the supervisor's API token. */
export function childEnvironment(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TERM",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}
export class StdioWire implements Wire {
  onMessage?: (m: RpcMessage) => void;
  onClose?: (error: Error) => void;
  readonly process: ChildProcessWithoutNullStreams;
  private closing = false;
  constructor(
    executable: string,
    args: string[],
    cwd: string,
    env?: Record<string, string>,
  ) {
    this.process = spawn(executable, args, {
      cwd,
      env: childEnvironment(env),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    this.process.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        this.onClose?.(new Error("RPC frame limit"));
        this.close();
        return;
      }
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new Error();
          this.onMessage?.(value);
        } catch {
          this.onClose?.(new Error("Invalid JSON-RPC frame"));
          this.close();
          return;
        }
      }
    });
    this.process.stderr.resume(); // Never forward unredacted process diagnostics.
    this.process.on("error", () =>
      this.onClose?.(new Error("Worker process failed to spawn")),
    );
    this.process.on("exit", (code) =>
      this.onClose?.(new Error(`Worker process exited (${code})`)),
    );
    this.process.stdin.on("error", () =>
      this.onClose?.(new Error("Worker stdin closed")),
    );
  }
  send(message: RpcMessage): void {
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  close(): void {
    if (this.closing) return;
    this.closing = true;
    // Helpers can inherit pipes and otherwise keep the host alive after the
    // direct child exits. Releasing pipes is not proof native execution stopped.
    this.process.stdin.destroy();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    const pid = this.process.pid;
    if (
      !pid ||
      this.process.exitCode !== null ||
      this.process.signalCode !== null
    )
      return;
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
      if (!systemRoot) {
        this.process.kill();
        return;
      }
      // Target only our still-live owned child tree, never a shared provider
      // leader. No shell or PATH lookup; the helper itself has a deadline.
      execFile(
        join(systemRoot, "System32", "taskkill.exe"),
        ["/PID", String(pid), "/T", "/F"],
        {
          windowsHide: true,
          timeout: 5000,
          env: childEnvironment(),
        },
        (error) => {
          if (
            error &&
            this.process.exitCode === null &&
            this.process.signalCode === null
          )
            this.process.kill();
        },
      );
    } else {
      // detached above creates a group owned by this transport on POSIX.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        this.process.kill();
      }
    }
  }
}

export class SocketWire implements Wire {
  onMessage?: (m: RpcMessage) => void;
  onClose?: (error: Error) => void;
  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      try {
        this.onMessage?.(JSON.parse(data.toString()));
      } catch {
        this.onClose?.(new Error("Invalid socket RPC frame"));
        this.close();
      }
    });
    socket.on("error", () => this.onClose?.(new Error("RPC socket error")));
    socket.on("close", () => this.onClose?.(new Error("RPC socket closed")));
  }
  static async connect(endpoint: string): Promise<SocketWire> {
    const url = new URL(endpoint);
    if (
      !["ws:", "wss:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error("Codex socket must be loopback ws/wss");
    const socket = new WebSocket(url, {
      handshakeTimeout: 10000,
      maxPayload: 4 * 1024 * 1024,
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new SocketWire(socket);
  }
  send(message: RpcMessage): void {
    this.socket.send(JSON.stringify(message));
  }
  close(): void {
    this.socket.terminate();
  }
}
