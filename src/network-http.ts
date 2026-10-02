import type { GameAction, Resources } from './game/types';
import type { CreateRoom, Reply, RoomSnapshot, Session } from './network';

const SESSION_KEY = 'catan-online-session-v1';
class RoomRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
interface HttpReply extends Reply {
  state?: RoomSnapshot;
}
/** Polls only while in an online room; mutations never retry automatically. */
export class HttpCatanConnection {
  private readonly base: string;
  private readonly connectionId = crypto.randomUUID();
  private current: RoomSnapshot | null = null;
  private lastPublished = '';
  private activeSession: Session | null = null;
  private connected = false;
  private closed = false;
  private mutating = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | null = null;
  private subscribers = new Set<(state: RoomSnapshot) => void>();
  private connectionSubscribers = new Set<(connected: boolean) => void>();
  private disconnectSubscribers = new Set<() => void>();
  private requests = new Set<AbortController>();
  constructor(url?: string) {
    this.base = `${url?.replace(/\/$/, '') ?? ''}/api/online`;
    document.addEventListener('visibilitychange', this.onVisibility);
  }
  onState(fn: (state: RoomSnapshot) => void): () => void {
    this.subscribers.add(fn);
    if (this.current) fn(this.current);
    return () => {
      this.subscribers.delete(fn);
    };
  }
  onConnection(fn: (connected: boolean) => void): () => void {
    this.connectionSubscribers.add(fn);
    fn(this.connected);
    return () => {
      this.connectionSubscribers.delete(fn);
    };
  }
  onDisconnect(fn: () => void): () => void {
    this.disconnectSubscribers.add(fn);
    return () => {
      this.disconnectSubscribers.delete(fn);
    };
  }
  savedSession(): Session | null {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
      return value && typeof value.code === 'string' && typeof value.token === 'string'
        ? value
        : null;
    } catch {
      return null;
    }
  }
  clearSession(): void {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {}
  }
  private setConnected(connected: boolean) {
    if (this.connected === connected) return;
    this.connected = connected;
    this.connectionSubscribers.forEach((fn) => fn(connected));
    if (!connected) this.disconnectSubscribers.forEach((fn) => fn());
  }
  private publish(state?: RoomSnapshot) {
    if (!state || this.closed) return;
    if (state.code === this.current?.code && (state.revision ?? 0) < (this.current.revision ?? 0))
      return;
    const fingerprint = JSON.stringify(state);
    this.current = state;
    this.setConnected(true);
    if (fingerprint === this.lastPublished) return;
    this.lastPublished = fingerprint;
    this.subscribers.forEach((fn) => fn(state));
  }
  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: unknown,
    session = this.activeSession,
  ): Promise<HttpReply> {
    if (this.closed)
      throw new Error('This room connection was closed. Refresh the page to reconnect.');
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(`${this.base}${path}`, {
        method,
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'X-Catan-Connection': this.connectionId,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      let reply: HttpReply;
      try {
        reply = await response.json();
      } catch {
        throw new RoomRequestError(
          'Online rooms are unavailable. Please try again shortly.',
          response.status,
        );
      }
      if (!response.ok || !reply?.ok)
        throw new RoomRequestError(
          reply.error ?? 'The room request could not be completed.',
          response.status,
        );
      return reply;
    } catch (error) {
      if (error instanceof RoomRequestError) throw error;
      this.setConnected(false);
      throw new Error(
        'The game server did not respond. Reconnect to check your room before trying the move again.',
      );
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }
  private remember(reply: HttpReply) {
    if (reply.session) {
      this.activeSession = reply.session;
      try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(reply.session));
      } catch {}
    }
    this.publish(reply.state);
    this.schedule();
    return reply;
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.closed && this.activeSession)
      this.timer = setTimeout(() => void this.poll(), document.hidden ? 15_000 : 2_000);
  }
  private onVisibility = () => {
    if (!document.hidden && this.activeSession) {
      clearTimeout(this.timer);
      void this.poll();
    }
  };
  private async poll(): Promise<void> {
    if (this.polling) return this.polling;
    if (!this.activeSession || this.closed || this.mutating) {
      this.schedule();
      return;
    }
    const session = this.activeSession;
    this.polling = (async () => {
      try {
        const reply = await this.request(
          `/rooms/${encodeURIComponent(session.code)}`,
          'GET',
          undefined,
          session,
        );
        if (this.activeSession === session) this.publish(reply.state);
      } catch (error) {
        if (error instanceof RoomRequestError && [401, 404, 409, 410].includes(error.status)) {
          // Another tab owns the seat, or the room expired. Never steal control automatically.
          if (this.activeSession === session) this.activeSession = null;
        }
        this.setConnected(false);
      } finally {
        this.polling = null;
        this.schedule();
      }
    })();
    return this.polling;
  }
  private async mutate(path: string, body: unknown, session = this.activeSession): Promise<Reply> {
    if (this.mutating) throw new Error('Please wait for your previous move to finish.');
    this.mutating = true;
    let confirmed = false;
    try {
      const reply = this.remember(await this.request(path, 'POST', body, session));
      confirmed = true;
      return reply;
    } catch (error) {
      if (error instanceof RoomRequestError && error.status === 409) {
        this.activeSession = null;
        this.setConnected(false);
      }
      throw error;
    } finally {
      this.mutating = false;
      // Fetch after an uncertain or conflicting move instead of replaying the mutation.
      if (!confirmed && this.activeSession) void this.poll();
      this.schedule();
    }
  }
  create(options: CreateRoom): Promise<Reply> {
    return this.mutate('/create', options, null);
  }
  join(code: string, name: string): Promise<Reply> {
    return this.mutate('/join', { code, name }, null);
  }
  resume(session: Session): Promise<Reply> {
    return this.mutate('/resume', { code: session.code }, session);
  }
  private command(event: string, data: Record<string, unknown> = {}): Promise<Reply> {
    if (!this.activeSession)
      return Promise.reject(new Error('Resume your saved game session before making a move.'));
    return this.mutate(`/rooms/${encodeURIComponent(this.activeSession.code)}/${event}`, {
      ...data,
      revision: this.current?.revision,
    });
  }
  start(): Promise<Reply> {
    return this.command('start');
  }
  action(action: GameAction): Promise<Reply> {
    return this.command('action', { action });
  }
  proposeTrade(player: number, give: Resources, receive: Resources): Promise<Reply> {
    return this.command('trade-propose', { player, give, receive });
  }
  acceptTrade(id: string): Promise<Reply> {
    return this.command('trade-accept', { id });
  }
  rejectTrade(id: string): Promise<Reply> {
    return this.command('trade-reject', { id });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.requests.forEach((controller) => controller.abort());
    if (this.activeSession) {
      void fetch(`${this.base}/rooms/${encodeURIComponent(this.activeSession.code)}/disconnect`, {
        method: 'POST',
        keepalive: true,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.activeSession.token}`,
          'X-Catan-Connection': this.connectionId,
        },
        body: '{}',
      }).catch(() => {});
    }
    this.activeSession = null;
    this.subscribers.clear();
    this.connectionSubscribers.clear();
    this.disconnectSubscribers.clear();
  }
}
