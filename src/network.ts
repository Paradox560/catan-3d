import { io, type Socket } from 'socket.io-client';
import { HttpCatanConnection } from './network-http';
import type { GameAction, GameState, Resources } from './game/types';

export interface Session {
  code: string;
  token: string;
  player: number;
}
export interface RoomPlayer {
  id: number;
  name: string;
  connected: boolean;
}
export interface PendingTrade {
  id: string;
  from: number;
  to: number;
  give: Resources;
  receive: Resources;
  expiresAt: number;
}
export interface RoomSnapshot {
  revision?: number;
  code: string;
  mode: 'standard' | 'extension';
  capacity: number;
  host: number;
  players: RoomPlayer[];
  game: GameState | null;
  you: number;
  resourceCounts: Record<number, number>;
  devCounts: Record<number, number>;
  pendingTrade: PendingTrade | null;
}
export interface Reply {
  ok: boolean;
  error?: string;
  session?: Session;
}
export interface CreateRoom {
  name: string;
  mode: 'standard' | 'extension';
  capacity: number;
}
export const SESSION_KEY = 'catan-online-session-v1';
export function loadSession(): Session | null {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null');
    return session && typeof session.code === 'string' && typeof session.token === 'string'
      ? session
      : null;
  } catch {
    return null;
  }
}
export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {}
}

/** One connection per mounted app. All gameplay decisions are validated by the server. */
class SocketCatanConnection {
  readonly socket: Socket;
  private current: RoomSnapshot | null = null;
  private activeSession: Session | null = null;
  private subscribers = new Set<(state: RoomSnapshot) => void>();
  private connectionSubscribers = new Set<(connected: boolean) => void>();
  constructor(url?: string) {
    this.socket = io(url ?? undefined, { autoConnect: true, reconnection: true });
    this.socket.on('room:state', (state: RoomSnapshot) => {
      this.current = state;
      this.subscribers.forEach((fn) => fn(state));
    });
    this.socket.on('connect', () => {
      this.connectionSubscribers.forEach((fn) => fn(true));
      const session = this.activeSession;
      if (session) void this.resume(session).catch(() => {});
    });
    this.socket.on('disconnect', () => this.connectionSubscribers.forEach((fn) => fn(false)));
    this.socket.on('session:replaced', () => {
      // Another tab now owns this seat. Its shared saved token must remain available.
      this.activeSession = null;
      this.current = null;
      this.socket.disconnect();
    });
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
    fn(this.socket.connected);
    return () => {
      this.connectionSubscribers.delete(fn);
    };
  }
  onDisconnect(fn: () => void): () => void {
    this.socket.on('disconnect', fn);
    return () => {
      this.socket.off('disconnect', fn);
    };
  }
  savedSession(): Session | null {
    return loadSession();
  }
  clearSession(): void {
    clearSession();
  }
  private async request(event: string, payload: unknown = {}): Promise<Reply> {
    if (!this.socket.connected) throw new Error('Not connected to the game server. Reconnecting…');
    return new Promise((resolve, reject) => {
      this.socket.timeout(10_000).emit(event, payload, (timeout: Error | null, reply: Reply) => {
        if (timeout) return reject(new Error('The server did not respond. Check your connection.'));
        if (!reply?.ok)
          return reject(new Error(reply?.error ?? 'The request could not be completed.'));
        if (reply.session) {
          this.activeSession = reply.session;
          try {
            localStorage.setItem(SESSION_KEY, JSON.stringify(reply.session));
          } catch {}
        }
        resolve(reply);
      });
    });
  }
  create(options: CreateRoom): Promise<Reply> {
    return this.request('room:create', options);
  }
  join(code: string, name: string): Promise<Reply> {
    return this.request('room:join', { code, name });
  }
  resume(session: Session): Promise<Reply> {
    return this.request('room:resume', { code: session.code, token: session.token });
  }
  start(): Promise<Reply> {
    return this.request('room:start');
  }
  action(action: GameAction): Promise<Reply> {
    return this.request('game:action', { action });
  }
  proposeTrade(player: number, give: Resources, receive: Resources): Promise<Reply> {
    return this.request('trade:propose', { player, give, receive });
  }
  acceptTrade(id: string): Promise<Reply> {
    return this.request('trade:accept', { id });
  }
  rejectTrade(id: string): Promise<Reply> {
    return this.request('trade:reject', { id });
  }
  close(): void {
    this.socket.disconnect();
    this.subscribers.clear();
    this.connectionSubscribers.clear();
  }
}

/** Both transports expose the same game commands; Vercel uses Firestore-backed HTTP rooms. */
export class CatanConnection {
  private readonly transport: SocketCatanConnection | HttpCatanConnection;
  constructor(url?: string) {
    this.transport =
      import.meta.env?.VITE_ONLINE_TRANSPORT === 'http'
        ? new HttpCatanConnection(url)
        : new SocketCatanConnection(url);
  }
  get socket(): Socket | null {
    return this.transport instanceof SocketCatanConnection ? this.transport.socket : null;
  }
  onState(fn: (state: RoomSnapshot) => void) {
    return this.transport.onState(fn);
  }
  onConnection(fn: (connected: boolean) => void) {
    return this.transport.onConnection(fn);
  }
  onDisconnect(fn: () => void) {
    return this.transport.onDisconnect(fn);
  }
  savedSession() {
    return this.transport.savedSession();
  }
  clearSession() {
    this.transport.clearSession();
  }
  create(options: CreateRoom) {
    return this.transport.create(options);
  }
  join(code: string, name: string) {
    return this.transport.join(code, name);
  }
  resume(session: Session) {
    return this.transport.resume(session);
  }
  start() {
    return this.transport.start();
  }
  action(action: GameAction) {
    return this.transport.action(action);
  }
  proposeTrade(player: number, give: Resources, receive: Resources) {
    return this.transport.proposeTrade(player, give, receive);
  }
  acceptTrade(id: string) {
    return this.transport.acceptTrade(id);
  }
  rejectTrade(id: string) {
    return this.transport.rejectTrade(id);
  }
  close() {
    this.transport.close();
  }
}
export function createConnection(url?: string): CatanConnection {
  return new CatanConnection(url);
}
