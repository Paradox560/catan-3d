import { lazy, useEffect, useMemo, useRef, useState } from 'react';
import {
  Anchor,
  ArrowLeftRight,
  ArrowRight,
  Award,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Crown,
  Dice5,
  Flag,
  Globe2,
  Hammer,
  Hexagon,
  Home,
  Leaf,
  LockKeyhole,
  Mountain,
  Plus,
  RotateCcw,
  Shield,
  Ship,
  Sparkles,
  Trees,
  Users,
  Volume2,
  VolumeX,
  Wheat,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import RankingsPage from './components/RankingsPage';
import {
  applyAction,
  createGame,
  legalBuilds,
  score,
  resourceCount,
  tradeRate,
  RESOURCES,
  COSTS,
  COLORS,
} from './game/engine';
import type { BuildKind, DevType, GameAction, GameState, Resource, Resources } from './game/types';
import { CatanConnection, loadSession } from './network';
import type { RoomSnapshot } from './network';

const Board3D = lazy(() => import('./components/Board3D'));

const RESOURCE_LABELS: Record<Resource, string> = {
  wood: 'Lumber',
  brick: 'Brick',
  sheep: 'Wool',
  wheat: 'Grain',
  ore: 'Ore',
};
const ICONS = { wood: Trees, brick: Hexagon, sheep: Leaf, wheat: Wheat, ore: Mountain };
const DEV_NAMES: Record<DevType, string> = {
  knight: 'Knight',
  victory: 'Victory point',
  roadBuilding: 'Road building',
  yearOfPlenty: 'Year of plenty',
  monopoly: 'Monopoly',
};
const DEV_TEXT: Record<DevType, string> = {
  knight: 'Move the robber and steal a resource. Three knights can earn Largest Army.',
  victory: 'One secret victory point. Counted automatically when you can win.',
  roadBuilding: 'Place up to two connected roads at no resource cost.',
  yearOfPlenty: 'Take two available resources of your choice from the bank.',
  monopoly: 'Take every card of one resource type from all other players.',
};
const DEFAULT_NAMES = ['Amber', 'Coral', 'Sage', 'Azure', 'Violet', 'Pearl'];
const ZERO = (): Resources => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const LOCAL_KEY = 'catan-3d-local-v1';
const previewConfig = {
  mode: 'standard' as const,
  names: DEFAULT_NAMES.slice(0, 4),
  seed: 'the-golden-isles',
  targetPoints: 10,
};

function ResourceIcon({ resource, size = 20 }: { resource: Resource; size?: number }) {
  const Icon = ICONS[resource];
  return <Icon size={size} strokeWidth={1.7} />;
}
function ResourceSummary({ resources }: { resources: Resources }) {
  return (
    <span className="resource-summary">
      {RESOURCES.filter((r) => resources[r] > 0).map((r) => (
        <span key={r} title={RESOURCE_LABELS[r]}>
          <ResourceIcon resource={r} size={15} />
          {resources[r]}
        </span>
      ))}
    </span>
  );
}
function Cost({ kind }: { kind: keyof typeof COSTS }) {
  return (
    <span className="cost">
      {RESOURCES.filter((r) => COSTS[kind][r] > 0).map((r) => (
        <span key={r} className={`resource-${r}`} title={`${COSTS[kind][r]} ${RESOURCE_LABELS[r]}`}>
          <ResourceIcon resource={r} size={13} />
          {COSTS[kind][r] > 1 && COSTS[kind][r]}
        </span>
      ))}
    </span>
  );
}
function Modal({
  title,
  eyebrow,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
  onClose?: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const old = document.activeElement as HTMLElement;
    const el = ref.current;
    el?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onClose) onClose();
      if (e.key === 'Tab' && el) {
        const nodes = el.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,[tabindex="0"]',
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      old?.focus();
    };
  }, [onClose]);
  return (
    <div className="modal-shade">
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2>{title}</h2>
          </div>
          {onClose && (
            <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
              <X size={20} />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

function ResourcePicker({
  value,
  onChange,
  max,
  label,
}: {
  value: Resources;
  onChange: (v: Resources) => void;
  max?: Resources;
  label: string;
}) {
  return (
    <div className="resource-picker" aria-label={label}>
      {RESOURCES.map((r) => (
        <label key={r} className={`resource-${r}`}>
          <ResourceIcon resource={r} />
          <span>{RESOURCE_LABELS[r]}</span>
          <input
            type="number"
            aria-label={`${label} ${RESOURCE_LABELS[r]}`}
            min={0}
            max={max?.[r] ?? 19}
            value={value[r]}
            onChange={(e) =>
              onChange({
                ...value,
                [r]: Math.max(0, Math.min(max?.[r] ?? 19, Number(e.target.value) || 0)),
              })
            }
          />
        </label>
      ))}
    </div>
  );
}

function TradeDialog({
  game,
  me,
  online,
  busy,
  onClose,
  onBank,
  onPlayer,
}: {
  game: GameState;
  me: number;
  online: boolean;
  busy: boolean;
  onClose: () => void;
  onBank: (give: Resource, receive: Resource) => void;
  onPlayer: (player: number, give: Resources, receive: Resources) => void;
}) {
  const [tab, setTab] = useState<'bank' | 'players'>('bank');
  const [give, setGive] = useState<Resource>('wood');
  const [receive, setReceive] = useState<Resource>('brick');
  const [target, setTarget] = useState(game.players.find((p) => p.id !== me)!.id);
  const [offer, setOffer] = useState<Resources>(ZERO);
  const [request, setRequest] = useState<Resources>(ZERO);
  const rate = tradeRate(game, me, give);
  const mine = game.players[me];
  return (
    <Modal title="A fair exchange" eyebrow="THE TRADING HARBOR" onClose={onClose}>
      <div className="lobby-tabs">
        <button className={tab === 'bank' ? 'selected' : ''} onClick={() => setTab('bank')}>
          <Anchor size={14} /> Bank & harbors
        </button>
        <button
          disabled={game.paired}
          className={tab === 'players' ? 'selected' : ''}
          onClick={() => setTab('players')}
        >
          <Users size={14} /> Explorers
        </button>
      </div>
      {tab === 'bank' ? (
        <>
          <p className="muted small">
            Harbor discounts apply automatically when you have a settlement or city beside a port.
          </p>
          <div className="bank-trade">
            <label className="field">
              YOU GIVE
              <select value={give} onChange={(e) => setGive(e.target.value as Resource)}>
                {RESOURCES.map((r) => (
                  <option key={r} value={r}>
                    {RESOURCE_LABELS[r]} ({tradeRate(game, me, r)}:1)
                  </option>
                ))}
              </select>
              <strong>
                {rate}
                <ResourceIcon resource={give} size={32} />
              </strong>
            </label>
            <ArrowRight className="trade-arrow" size={24} />
            <label className="field">
              YOU RECEIVE
              <select value={receive} onChange={(e) => setReceive(e.target.value as Resource)}>
                {RESOURCES.map((r) => (
                  <option key={r} value={r}>
                    {RESOURCE_LABELS[r]}
                  </option>
                ))}
              </select>
              <strong>
                1<ResourceIcon resource={receive} size={32} />
              </strong>
            </label>
          </div>
          <button
            className="primary full"
            disabled={give === receive || mine.resources[give] < rate || game.bank[receive] < 1}
            onClick={() => onBank(give, receive)}
          >
            Trade {rate} {RESOURCE_LABELS[give].toLowerCase()} for 1{' '}
            {RESOURCE_LABELS[receive].toLowerCase()}
            <ArrowLeftRight size={16} />
          </button>
          <p className="micro center">
            You have {mine.resources[give]} {RESOURCE_LABELS[give].toLowerCase()} · Bank has{' '}
            {game.bank[receive]} {RESOURCE_LABELS[receive].toLowerCase()}
          </p>
          {game.paired && (
            <p className="small muted">Paired players may trade with the bank only.</p>
          )}
        </>
      ) : (
        <>
          <label className="field trade-target">
            TRADE WITH
            <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
              {game.players
                .filter((p) => p.id !== me)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <span className="field-label">YOUR OFFER</span>
          <ResourcePicker value={offer} onChange={setOffer} max={mine.resources} label="Offer" />
          <span className="field-label">YOUR REQUEST</span>
          <ResourcePicker value={request} onChange={setRequest} label="Request" />
          <button
            className="primary full"
            disabled={
              busy ||
              !resourceCount(offer) ||
              !resourceCount(request) ||
              RESOURCES.some((r) => offer[r] > 0 && request[r] > 0)
            }
            onClick={() => onPlayer(target, offer, request)}
          >
            {online ? 'Send trade offer' : 'Review together'}
            <ArrowRight size={16} />
          </button>
          <p className="micro center">Your friend must accept before any resources change hands.</p>
        </>
      )}
    </Modal>
  );
}

function DevDialog({
  game,
  me,
  onClose,
  onPlay,
}: {
  game: GameState;
  me: number;
  onClose: () => void;
  onPlay: (a: GameAction) => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const [first, setFirst] = useState<Resource>('wood');
  const [second, setSecond] = useState<Resource>('wheat');
  const cards = game.players[me].devCards;
  const card = cards.find((c) => c.id === selected);
  const bankTotal = resourceCount(game.bank);
  const plenty =
    bankTotal < 2
      ? RESOURCES.flatMap((r) => Array.from({ length: game.bank[r] }, () => r))
      : [first, second];
  const plentyValid = RESOURCES.every((r) => plenty.filter((v) => v === r).length <= game.bank[r]);
  const canPlay =
    card &&
    card.type !== 'victory' &&
    card.boughtTurn < game.turn &&
    !game.devPlayed &&
    !game.freeRoads &&
    (card.type !== 'yearOfPlenty' || plentyValid);
  return (
    <Modal title="A secret advantage" eyebrow="YOUR DEVELOPMENT CARDS" onClose={onClose}>
      <p className="muted small">
        Play one development card per turn. New cards become available on your next turn, including
        a paired turn.
      </p>
      {cards.length ? (
        <div className="dev-list">
          {cards.map((c) => (
            <button
              key={c.id}
              className={`dev-card ${selected === c.id ? 'selected' : ''}`}
              onClick={() => setSelected(c.id)}
            >
              <span>
                {c.type === 'knight' ? <Shield /> : c.type === 'victory' ? <Crown /> : <Sparkles />}
              </span>
              <div>
                <strong>{DEV_NAMES[c.type]}</strong>
                <small>
                  {c.type === 'victory'
                    ? 'Counts automatically'
                    : c.boughtTurn >= game.turn
                      ? 'Available next turn'
                      : game.devPlayed
                        ? 'One card already played this turn'
                        : 'Ready to play'}
                </small>
              </div>
              <ChevronDown size={16} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <Sparkles size={40} />
          <h3>Your story is unwritten.</h3>
          <p>Buy a development card with one wool, one grain, and one ore.</p>
        </div>
      )}
      {card && (
        <div className="dev-details">
          <h3>{DEV_NAMES[card.type]}</h3>
          <p className="muted small">{DEV_TEXT[card.type]}</p>
          {['monopoly', 'yearOfPlenty'].includes(card.type) && (
            <div className="dev-picks">
              <label className="field">
                {card.type === 'monopoly' ? 'RESOURCE' : 'FIRST RESOURCE'}
                <select value={first} onChange={(e) => setFirst(e.target.value as Resource)}>
                  {RESOURCES.map((r) => (
                    <option key={r} value={r}>
                      {RESOURCE_LABELS[r]} ({game.bank[r]} in bank)
                    </option>
                  ))}
                </select>
              </label>
              {card.type === 'yearOfPlenty' && bankTotal >= 2 && (
                <label className="field">
                  SECOND RESOURCE
                  <select value={second} onChange={(e) => setSecond(e.target.value as Resource)}>
                    {RESOURCES.map((r) => (
                      <option key={r} value={r}>
                        {RESOURCE_LABELS[r]} ({game.bank[r]} in bank)
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          {card.type !== 'victory' && (
            <button
              className="primary full"
              disabled={!canPlay}
              onClick={() =>
                onPlay({ type: 'PLAY_DEV', card: card.id, resource: first, resources: plenty })
              }
            >
              Play {DEV_NAMES[card.type]}
              <Sparkles size={16} />
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

function DiscardDialog({
  game,
  playerId,
  onDiscard,
}: {
  game: GameState;
  playerId: number;
  onDiscard: (resources: Resources) => void;
}) {
  const [values, setValues] = useState<Resources>(ZERO);
  useEffect(() => setValues(ZERO()), [playerId]);
  const p = game.players[playerId],
    required = Math.floor(resourceCount(p.resources) / 2),
    chosen = resourceCount(values);
  return (
    <Modal title={`${p.name}, lighten your hold.`} eyebrow="A SEVEN WAS ROLLED">
      <p className="muted">
        You have {resourceCount(p.resources)} resource cards. Choose {required} to return to the
        bank before the robber moves.
      </p>
      <ResourcePicker value={values} onChange={setValues} max={p.resources} label="Discard" />
      <div className="discard-count">
        <strong>{chosen}</strong> of {required} selected
      </div>
      <button
        className="primary full"
        disabled={chosen !== required}
        onClick={() => onDiscard(values)}
      >
        Return {required} cards to the bank
        <ArrowRight size={16} />
      </button>
    </Modal>
  );
}

export default function App() {
  const [rankingsOpen, setRankingsOpen] = useState(() => location.hash === '#rankings');
  const [local, setLocal] = useState<GameState>(() => createGame(previewConfig));
  const [screen, setScreen] = useState<'welcome' | 'local' | 'online'>('welcome');
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [connection, setConnection] = useState<CatanConnection | null>(null);
  const [connected, setConnected] = useState(true);
  const [formTab, setFormTab] = useState<'create' | 'join' | 'local'>(() =>
    new URLSearchParams(location.search).get('room') ? 'join' : 'create',
  );
  const [mode, setMode] = useState<'standard' | 'extension'>('standard');
  const [capacity, setCapacity] = useState(4);
  const [name, setName] = useState('');
  const [code, setCode] = useState(() => new URLSearchParams(location.search).get('room') || '');
  const [names, setNames] = useState(DEFAULT_NAMES);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [build, setBuild] = useState<BuildKind | null>(null);
  const [localTrade, setLocalTrade] = useState<{
    player: number;
    give: Resources;
    receive: Resources;
  } | null>(null);
  const [dialog, setDialog] = useState<'help' | 'trade' | 'dev' | 'leave' | null>(null);
  const [resetView, setResetView] = useState(0);
  const [handoff, setHandoff] = useState<number | null>(null);
  const [sound, setSound] = useState(false);
  const [selectedSite, setSelectedSite] = useState('');
  const [saved, setSaved] = useState(() => !!localStorage.getItem(LOCAL_KEY));
  const [resumeAvailable, setResumeAvailable] = useState(() => !!loadSession());
  const prevActor = useRef<number | null>(null);
  const previousDice = useRef('');
  const game = screen === 'online' && room?.game ? room.game : local;
  const playing = screen === 'local' || (screen === 'online' && !!room?.game);
  const actor = game.phase === 'discard' ? game.discardQueue[0] : game.currentPlayer;
  const me = screen === 'online' ? (room?.you ?? -1) : actor;
  const isMyTurn = playing && me === actor && handoff === null;
  const player = game.players[me] || game.players[game.currentPlayer];
  const active = game.players[actor] || game.players[0];
  const actualBuild =
    game.phase === 'setupSettlement'
      ? 'settlement'
      : game.phase === 'setupRoad' || game.freeRoads > 0
        ? 'road'
        : build;
  const legal = useMemo(
    () => (actualBuild && isMyTurn ? legalBuilds(game, actualBuild) : []),
    [game, actualBuild, isMyTurn],
  );
  const buildSite =
    selectedSite !== '' && legal.includes(Number(selectedSite)) ? Number(selectedSite) : legal[0];
  const robberSite =
    selectedSite !== '' && Number(selectedSite) !== game.robberHex
      ? Number(selectedSite)
      : game.board.hexes.find((h) => h.id !== game.robberHex)?.id;
  const canAct = isMyTurn && game.phase === 'action';
  const setup = game.phase.startsWith('setup');

  useEffect(() => {
    const update = () => setRankingsOpen(location.hash === '#rankings');
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4800);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const c = new CatanConnection();
    setConnection(c);
    const off = c.onState((snapshot) => {
      setRoom(snapshot);
      setScreen('online');
      setConnected(true);
      if (!snapshot.game)
        setLocal(
          createGame({
            ...previewConfig,
            mode: snapshot.mode,
            names: Array.from(
              { length: snapshot.capacity },
              (_, i) => snapshot.players[i]?.name || DEFAULT_NAMES[i],
            ),
          }),
        );
      setResumeAvailable(true);
    });
    const offD = c.onDisconnect(() => setConnected(false));
    return () => {
      off();
      offD();
      c.close();
    };
  }, []);
  useEffect(() => {
    if (screen === 'local') {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
      setSaved(true);
      if (prevActor.current !== null && prevActor.current !== actor && game.phase !== 'gameOver')
        setHandoff(actor);
      prevActor.current = actor;
    } else prevActor.current = null;
    setBuild(null);
    setSelectedSite('');
  }, [screen, actor, game.turn]);
  useEffect(() => {
    if (screen === 'local') localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
  }, [local, screen]);
  useEffect(() => {
    const d = game.dice?.join('') || '';
    if (d && d !== previousDice.current && sound) {
      try {
        const ctx = new AudioContext();
        [0, 0.065, 0.14].forEach((t, i) => {
          const o = ctx.createOscillator(),
            g = ctx.createGain();
          o.type = 'triangle';
          o.frequency.value = 220 + i * 100;
          g.gain.setValueAtTime(0.06, ctx.currentTime + t);
          g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.13);
          o.connect(g);
          g.connect(ctx.destination);
          o.start(ctx.currentTime + t);
          o.stop(ctx.currentTime + t + 0.14);
        });
        setTimeout(() => ctx.close(), 500);
      } catch {}
    }
    previousDice.current = d;
  }, [game.dice, sound]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        rankingsOpen ||
        (e.target as HTMLElement).matches('input,select,textarea') ||
        dialog ||
        handoff !== null
      )
        return;
      if (e.key === 'Escape') setBuild(null);
      if (canAct && ['1', '2', '3'].includes(e.key))
        setBuild((['road', 'settlement', 'city'] as BuildKind[])[Number(e.key) - 1]);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [canAct, dialog, handoff, rankingsOpen]);

  async function dispatch(action: GameAction) {
    try {
      if (screen === 'online') {
        if (!connected) throw Error('Reconnecting to the table. Please wait.');
        await connection!.action(action);
      } else setLocal(applyAction(local, action));
      if (action.type === 'BUILD') setBuild(null);
      setSelectedSite('');
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  async function asyncTask(task: () => Promise<unknown>) {
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function selectMode(m: 'standard' | 'extension') {
    setMode(m);
    setCapacity(m === 'standard' ? 4 : 6);
    if (screen === 'welcome')
      setLocal(
        createGame({
          ...previewConfig,
          mode: m,
          names: DEFAULT_NAMES.slice(0, m === 'standard' ? 4 : 6),
        }),
      );
  }
  function startLocal() {
    try {
      const state = createGame({
        mode,
        names: names.slice(0, capacity).map((n, i) => n.trim() || DEFAULT_NAMES[i]),
        seed: crypto.randomUUID(),
        targetPoints: 10,
      });
      setLocal(state);
      setScreen('local');
      setHandoff(0);
      prevActor.current = 0;
      setDialog(null);
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  function resumeLocal() {
    try {
      const state = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
      if (state?.version !== 1 || !state.board || !state.players)
        throw Error('This saved game could not be loaded. Start a new table.');
      setLocal(state);
      setScreen('local');
      setHandoff(state.phase === 'discard' ? state.discardQueue[0] : state.currentPlayer);
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  function exitGame() {
    connection?.close();
    location.href = location.pathname;
  }
  function placement(id: number, kind: BuildKind) {
    if (isMyTurn) void dispatch({ type: 'BUILD', kind, id });
  }
  const phaseCopy =
    game.phase === 'setupSettlement'
      ? `Place your ${game.setupStep >= game.players.length ? 'second' : 'first'} settlement`
      : game.phase === 'setupRoad'
        ? 'Connect your settlement'
        : game.phase === 'roll'
          ? 'A new turn. A new possibility.'
          : game.phase === 'discard'
            ? 'The robber is on the move'
            : game.phase === 'robber'
              ? 'Choose a new home for the robber'
              : game.phase === 'steal'
                ? 'Choose a player to steal from'
                : game.phase === 'gameOver'
                  ? 'An island. A new legend.'
                  : game.freeRoads > 0
                    ? `Place ${game.freeRoads} free road${game.freeRoads > 1 ? 's' : ''}`
                    : actualBuild
                      ? `Place a ${actualBuild}`
                      : 'Make your next move';
  const guidance =
    game.phase === 'setupSettlement'
      ? 'Select a glowing intersection. Nearby numbered terrain will supply your resources.'
      : game.phase === 'setupRoad'
        ? 'Select a glowing edge to place a road beside your new settlement.'
        : game.phase === 'roll'
          ? 'Roll the dice to gather resources across the island.'
          : game.phase === 'robber'
            ? 'Select a different terrain tile. Its production stays blocked until the robber moves.'
            : game.phase === 'steal'
              ? 'Take one random resource from a neighboring opponent.'
              : game.phase === 'discard'
                ? 'Players holding more than seven cards must return half to the bank.'
                : actualBuild
                  ? 'Glowing markers show every legal location. Drag the island to find your perfect spot.'
                  : game.paired
                    ? 'Your paired turn: build, trade with the bank, or play a development card.'
                    : 'Trade resources, expand your network, and build your way to 10 points.';

  if (rankingsOpen) {
    return (
      <RankingsPage
        onBack={() => {
          location.hash = '';
          setRankingsOpen(false);
        }}
      />
    );
  }

  return (
    <div className={`app ${playing ? 'in-game' : 'in-lobby'}`}>
      <header className="topbar">
        <a
          href="#"
          className="brand"
          onClick={(e) => {
            e.preventDefault();
            if (playing) setDialog('leave');
          }}
          aria-label="Catan home"
        >
          <span className="brand-mark">
            <Hexagon size={29} />
            <Mountain size={17} />
          </span>
          <span>
            CATAN<span className="brand-sub">THE LIVING ISLAND</span>
          </span>
        </a>
        <div className="header-center">
          <span className="live-dot" />
          {playing ? (
            <>
              <span>
                {game.config.mode === 'standard' ? 'The original island' : 'The great archipelago'}
              </span>
              <span className="header-divider" />
              <span>{game.players.length} explorers</span>
            </>
          ) : (
            <>
              <span>Gather your people. Build your world.</span>
            </>
          )}
        </div>
        <div className="header-actions">
          <button
            className="help-button"
            aria-label="Rankings"
            onClick={() => {
              location.hash = 'rankings';
              setRankingsOpen(true);
            }}
          >
            <Award size={17} />
            <span>Rankings</span>
          </button>
          {playing && (
            <span className="connection-chip">
              {screen === 'online' ? (
                connected ? (
                  <Wifi size={14} />
                ) : (
                  <WifiOff size={14} />
                )
              ) : (
                <Users size={14} />
              )}{' '}
              {screen === 'online' ? (connected ? room?.code : 'Reconnecting') : 'Pass & play'}
            </span>
          )}
          <button
            className="icon-button"
            onClick={() => setSound(!sound)}
            aria-label={sound ? 'Mute sound' : 'Enable sound'}
          >
            {sound ? <Volume2 size={19} /> : <VolumeX size={19} />}
          </button>
          <button
            className="help-button"
            aria-label="Field guide"
            onClick={() => setDialog('help')}
          >
            <BookOpen size={17} />
            <span>Field guide</span>
          </button>
          {playing && (
            <button
              className="icon-button"
              aria-label="Leave game"
              onClick={() => setDialog('leave')}
            >
              <X size={19} />
            </button>
          )}
        </div>
      </header>

      <main className="game-layout">
        {!playing && (
          <aside className="welcome-panel">
            <div className="welcome-intro">
              <span className="eyebrow">
                <span className="tiny-line" /> YOUR NEXT ADVENTURE
              </span>
              <h1>
                A world worth building<span>.</span>
              </h1>
              <p>A little strategy. A little luck. An island full of possibilities.</p>
            </div>
            {screen === 'online' && room && !room.game ? (
              <div className="room-lobby">
                <div className="section-heading">
                  <h2>Your table is open</h2>
                  <span className="badge">
                    {room.players.length}/{room.capacity}
                  </span>
                </div>
                <p className="muted small">Invite your friends, then set sail together.</p>
                <button
                  className="room-code"
                  onClick={() =>
                    asyncTask(async () => {
                      const link = new URL(location.href);
                      link.searchParams.set('room', room.code);
                      await navigator.clipboard.writeText(link.href);
                      setToast('Room invite link copied.');
                    })
                  }
                >
                  <span>
                    <small>ROOM CODE</small>
                    {room.code}
                  </span>
                  <Copy size={19} />
                </button>
                <div className="lobby-seats">
                  {Array.from({ length: room.capacity }, (_, i) => {
                    const p = room.players[i];
                    return (
                      <div className={`lobby-seat ${p ? 'filled' : ''}`} key={i}>
                        <span
                          className="avatar"
                          style={{ '--player': COLORS[i] } as React.CSSProperties}
                        >
                          {p ? p.name.charAt(0) : <Plus size={16} />}
                        </span>
                        <span>{p?.name || 'Waiting for an explorer…'}</span>
                        {p && (p.id === room.host ? <Crown size={15} /> : <Check size={15} />)}
                      </div>
                    );
                  })}
                </div>
                {room.you === room.host ? (
                  <button
                    className="primary full"
                    disabled={busy || room.players.length !== room.capacity}
                    onClick={() => asyncTask(() => connection!.start())}
                  >
                    Begin the adventure <ArrowRight size={17} />
                  </button>
                ) : (
                  <div className="waiting-note">
                    <span className="live-dot" /> Waiting for the host to begin
                  </div>
                )}
                <p className="micro center">
                  {room.mode === 'standard'
                    ? 'Classic 19-hex island'
                    : 'Expanded 30-hex island · Paired turns'}
                </p>
                <button className="text-button full" onClick={exitGame}>
                  Leave table
                </button>
              </div>
            ) : (
              <>
                <div className="lobby-tabs" role="tablist" aria-label="Play mode">
                  {(
                    [
                      ['create', 'Host online'],
                      ['join', 'Join friends'],
                      ['local', 'Local play'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      role="tab"
                      aria-selected={formTab === key}
                      className={formTab === key ? 'selected' : ''}
                      onClick={() => setFormTab(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <form
                  className="setup-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (formTab === 'local') startLocal();
                    else if (formTab === 'create')
                      asyncTask(() =>
                        connection!.create({ name: name.trim() || 'Explorer', mode, capacity }),
                      );
                    else
                      asyncTask(() =>
                        connection!.join(code.trim().toUpperCase(), name.trim() || 'Explorer'),
                      );
                  }}
                >
                  {formTab !== 'local' && (
                    <label className="field">
                      YOUR NAME
                      <input
                        required
                        value={name}
                        maxLength={24}
                        placeholder="What should we call you?"
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                  )}
                  {formTab === 'join' ? (
                    <label className="field">
                      ROOM CODE
                      <input
                        required
                        className="code-input"
                        value={code}
                        maxLength={8}
                        placeholder="ABCDEF"
                        onChange={(e) => setCode(e.target.value.toUpperCase())}
                      />
                    </label>
                  ) : (
                    <>
                      <div className="field-label">CHOOSE YOUR ISLAND</div>
                      <div className="mode-options">
                        <button
                          type="button"
                          className={`mode-card ${mode === 'standard' ? 'selected' : ''}`}
                          onClick={() => selectMode('standard')}
                        >
                          <span className="mode-mini">
                            <Hexagon />
                            <Hexagon />
                            <Hexagon />
                          </span>
                          <strong>Classic</strong>
                          <small>3–4 players · 19 hexes</small>
                          {mode === 'standard' && (
                            <span className="mode-check">
                              <Check size={12} />
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className={`mode-card ${mode === 'extension' ? 'selected' : ''}`}
                          onClick={() => selectMode('extension')}
                        >
                          <span className="mode-mini extension">
                            <Hexagon />
                            <Hexagon />
                            <Hexagon />
                            <Hexagon />
                          </span>
                          <strong>5–6 extension</strong>
                          <small>A bigger island awaits</small>
                          {mode === 'extension' && (
                            <span className="mode-check">
                              <Check size={12} />
                            </span>
                          )}
                        </button>
                      </div>
                      <div className="player-count">
                        <span>Seats at the table</span>
                        <div>
                          {(mode === 'standard' ? [3, 4] : [5, 6]).map((n) => (
                            <button
                              type="button"
                              key={n}
                              className={capacity === n ? 'selected' : ''}
                              onClick={() => setCapacity(n)}
                            >
                              {n}
                            </button>
                          ))}
                        </div>
                      </div>
                      {formTab === 'local' && (
                        <div className="name-grid">
                          {names.slice(0, capacity).map((n, i) => (
                            <label key={i}>
                              <span style={{ background: COLORS[i] }} />
                              <input
                                aria-label={`Player ${i + 1} name`}
                                value={n}
                                maxLength={24}
                                onChange={(e) =>
                                  setNames((v) => v.map((a, j) => (j === i ? e.target.value : a)))
                                }
                              />
                            </label>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  <button
                    className="primary full begin-button"
                    disabled={busy || (!connection && formTab !== 'local')}
                    type="submit"
                  >
                    {busy
                      ? 'Connecting…'
                      : formTab === 'create'
                        ? 'Create an online table'
                        : formTab === 'join'
                          ? 'Join the adventure'
                          : 'Set sail'}
                    <ArrowRight size={18} />
                  </button>
                  <p className="micro center">
                    {formTab === 'local' ? (
                      'One screen. Good company. Pass the turn.'
                    ) : (
                      <>
                        <Globe2 size={12} /> Private rooms · Play from separate devices
                      </>
                    )}
                  </p>
                </form>
                {(saved || resumeAvailable) && (
                  <div className="resume-row">
                    {saved && (
                      <button className="text-button" onClick={resumeLocal}>
                        <RotateCcw size={14} /> Resume local game
                      </button>
                    )}
                    {resumeAvailable && (
                      <button
                        className="text-button"
                        onClick={() =>
                          asyncTask(async () => {
                            const session = loadSession();
                            if (session) await connection!.resume(session);
                          })
                        }
                      >
                        <Wifi size={14} /> Rejoin online table
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="welcome-footer">
              <Shield size={15} />
              <span>
                An independent fan-made game.
                <br />
                Original 3D art. Made for your table.
              </span>
            </div>
          </aside>
        )}

        {playing && (
          <aside className="players-panel">
            <div className="section-heading">
              <span className="eyebrow">THE EXPLORERS</span>
              <span className="subtle">{game.players.length} players</span>
            </div>
            <div className="player-list">
              {game.players.map((p) => {
                const isMe = me === p.id;
                const current = actor === p.id;
                const count =
                  screen === 'online'
                    ? (room?.resourceCounts[p.id] ?? 0)
                    : resourceCount(p.resources);
                const points = score(game, p.id, isMe && handoff === null);
                return (
                  <div
                    className={`player-card ${current ? 'active' : ''}`}
                    key={p.id}
                    style={{ '--player': p.color } as React.CSSProperties}
                  >
                    <div className="player-top">
                      <span className="avatar">{p.name.charAt(0).toUpperCase()}</span>
                      <div className="player-name">
                        <strong>
                          {p.name}
                          {screen === 'online' && isMe && <small> YOU</small>}
                        </strong>
                        <span>
                          {current
                            ? game.paired
                              ? 'Paired turn'
                              : 'At the helm'
                            : screen === 'online' &&
                                !room?.players.find((v) => v.id === p.id)?.connected
                              ? 'Reconnecting…'
                              : 'Exploring the island'}
                        </span>
                      </div>
                      <div className="score">
                        <strong>{points}</strong>
                        <small>VP</small>
                      </div>
                    </div>
                    <div className="player-stats">
                      <span title="Resource cards">
                        <span className="mini-cards" />
                        {count}
                      </span>
                      <span title="Longest continuous road">
                        <Ship size={13} />
                        {p.roadLength}
                      </span>
                      <span title="Played knights">
                        <Shield size={13} />
                        {p.knights}
                      </span>
                      {game.longestRoad === p.id && (
                        <span title="Longest road" className="award">
                          <Flag size={13} />
                        </span>
                      )}
                      {game.largestArmy === p.id && (
                        <span title="Largest army" className="award">
                          <Award size={13} />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="victory-goal">
              <Crown size={24} />
              <div>
                <strong>A race to {game.config.targetPoints}</strong>
                <span>victory points</span>
              </div>
            </div>
            <div className="log-section">
              <span className="eyebrow">ISLAND CHRONICLE</span>
              <div className="log-list" aria-live="polite">
                {game.log
                  .slice(-5)
                  .reverse()
                  .map((l, i) => (
                    <div key={l.id} className={i === 0 ? 'latest' : ''}>
                      <span className="log-dot" />
                      <p>{l.text}</p>
                    </div>
                  ))}
              </div>
            </div>
            <button className="text-button rules-link" onClick={() => setDialog('help')}>
              <BookOpen size={15} /> Know your island <ArrowRight size={14} />
            </button>
          </aside>
        )}

        <section className="board-section" aria-label="Interactive 3D Catan island">
          <div className="board-topline">
            <div className="board-title">
              <span className="eyebrow">
                {playing ? (setup ? 'THE FOUNDING' : 'YOUR EXPEDITION') : 'THE GOLDEN ISLES'}
              </span>
              <span>
                {playing
                  ? setup
                    ? `Placement ${Math.min(game.setupStep + 1, game.players.length * 2)} of ${game.players.length * 2}`
                    : `Round ${game.round} · ${game.paired ? 'Paired action' : 'Main turn'}`
                  : 'An island of endless possibility'}
              </span>
            </div>
            <span className="edition-pill">
              {game.config.mode === 'standard' ? 'CLASSIC' : '5–6 EXTENSION'}
              <span> • </span>
              {game.board.hexes.length} HEXES
            </span>
          </div>
          <div className="board-canvas">
            <Board3D
              state={game}
              buildKind={actualBuild}
              legalIds={legal}
              onVertex={(id) => placement(id, actualBuild === 'city' ? 'city' : 'settlement')}
              onEdge={(id) => placement(id, 'road')}
              onHex={(id) => {
                if (game.phase === 'robber' && isMyTurn)
                  void dispatch({ type: 'MOVE_ROBBER', hex: id });
              }}
              interactive={isMyTurn}
              resetView={resetView}
            />
          </div>
          {playing && (
            <div className="board-prompt">
              <span className="prompt-dot" style={{ background: active.color }} />
              <strong>
                {isMyTurn
                  ? phaseCopy
                  : `${active.name} is ${setup ? 'founding a settlement' : game.phase === 'roll' ? 'rolling the dice' : 'taking a turn'}`}
              </strong>
              {actualBuild && isMyTurn && game.phase === 'action' && !game.freeRoads && (
                <button onClick={() => setBuild(null)} aria-label="Cancel placement">
                  <X size={14} />
                </button>
              )}
            </div>
          )}
          <div className="board-footer">
            <span>
              <span className="mouse-icon" /> Drag to orbit <i /> Scroll to zoom
            </span>
            <button className="view-reset" onClick={() => setResetView((v) => v + 1)}>
              <RotateCcw size={14} /> Reset view
            </button>
          </div>
          {!playing && (
            <div className="island-caption">
              <span>01 / THE ORIGINAL ADVENTURE</span>
              <h2>
                Every great story
                <br />
                starts with a settlement.
              </h2>
            </div>
          )}
        </section>

        {playing && (
          <aside className="actions-panel">
            <div className="turn-label">
              <span className="live-dot" />
              <span>{isMyTurn ? 'YOUR TURN' : `${active.name.toUpperCase()}’S TURN`}</span>
              {game.paired && <span className="badge">PAIRED</span>}
            </div>
            <h2>{phaseCopy}</h2>
            <p className="action-guidance">{guidance}</p>
            <div className={`dice-area ${game.phase === 'roll' ? 'ready' : ''}`}>
              <div className="dice-pair">
                {(game.dice || [1, 5]).map((d, i) => (
                  <div
                    key={i}
                    className={`die die-${d}`}
                    aria-label={`Die ${i + 1}: ${game.dice ? d : 'not rolled'}`}
                  >
                    {Array.from({ length: 9 }, (_, j) => (
                      <i key={j} />
                    ))}
                  </div>
                ))}
              </div>
              <div className="dice-result">
                <strong>{game.dice ? game.dice[0] + game.dice[1] : '—'}</strong>
                <span>
                  {game.dice?.reduce((a, b) => a + b, 0) === 7 ? 'THE ROBBER' : 'LAST ROLL'}
                </span>
              </div>
            </div>
            {game.phase === 'roll' && (
              <button
                className="primary full"
                disabled={!isMyTurn}
                onClick={() => dispatch({ type: 'ROLL' })}
              >
                <Dice5 size={18} /> Roll the dice
              </button>
            )}
            {(setup || actualBuild) && isMyTurn && (
              <div className="placement-info">
                <Hexagon size={18} />
                <span>
                  {legal.length} available {actualBuild === 'road' ? 'connections' : 'locations'}
                </span>
              </div>
            )}
            {game.phase === 'steal' && isMyTurn && (
              <div className="steal-options">
                {game.stealTargets.map((id) => (
                  <button
                    className="secondary full"
                    key={id}
                    onClick={() => dispatch({ type: 'STEAL', player: id })}
                  >
                    Steal from {game.players[id].name}
                    <ArrowRight size={14} />
                  </button>
                ))}
              </div>
            )}
            <div className="build-heading">
              <span className="eyebrow">BUILD YOUR WORLD</span>
              <Hammer size={14} />
            </div>
            <div className="build-options">
              {(
                [
                  {
                    kind: 'road',
                    label: 'Road',
                    Icon: Ship,
                    caption: 'Connect your world',
                    key: '1',
                  },
                  {
                    kind: 'settlement',
                    label: 'Settlement',
                    Icon: Home,
                    caption: 'A new beginning · +1 VP',
                    key: '2',
                  },
                  {
                    kind: 'city',
                    label: 'City',
                    Icon: Flag,
                    caption: 'Double your harvest · +1 VP',
                    key: '3',
                  },
                ] as const
              ).map(({ kind, label, Icon, caption, key }) => {
                const can =
                  canAct &&
                  (game.freeRoads > 0
                    ? kind === 'road'
                    : RESOURCES.every((r) => player.resources[r] >= COSTS[kind][r])) &&
                  legalBuilds(game, kind).length > 0;
                return (
                  <button
                    key={kind}
                    className={`build-option ${actualBuild === kind ? 'selected' : ''}`}
                    disabled={!can}
                    onClick={() => setBuild((v) => (v === kind ? null : kind))}
                  >
                    <span className="build-icon">
                      <Icon size={23} />
                    </span>
                    <span className="build-text">
                      <strong>
                        {label}
                        <Cost kind={kind} />
                      </strong>
                      <small>{caption}</small>
                    </span>
                    <kbd>{key}</kbd>
                  </button>
                );
              })}
              <button
                className="build-option"
                disabled={
                  !canAct ||
                  game.freeRoads > 0 ||
                  !game.deck.length ||
                  !RESOURCES.every((r) => player.resources[r] >= COSTS.development[r])
                }
                onClick={() => dispatch({ type: 'BUY_DEV' })}
              >
                <span className="build-icon">
                  <Sparkles size={23} />
                </span>
                <span className="build-text">
                  <strong>
                    Development
                    <Cost kind="development" />
                  </strong>
                  <small>A secret advantage</small>
                </span>
                <Plus size={15} />
              </button>
            </div>
            <div className="action-row">
              <button
                className="secondary"
                disabled={!canAct || game.freeRoads > 0}
                onClick={() => setDialog('trade')}
              >
                <ArrowLeftRight size={16} /> Trade
              </button>
              <button
                className="secondary"
                disabled={!isMyTurn || !['roll', 'action'].includes(game.phase)}
                onClick={() => setDialog('dev')}
              >
                <Sparkles size={16} /> Cards{' '}
                <span className="count-bubble">{player.devCards.length}</span>
              </button>
            </div>
            {canAct && game.freeRoads > 0 ? (
              <button
                className="text-button full"
                onClick={() => dispatch({ type: 'SKIP_FREE_ROADS' })}
              >
                Finish road building
              </button>
            ) : (
              game.phase === 'action' && (
                <button
                  className="end-turn full"
                  disabled={!isMyTurn}
                  onClick={() => dispatch({ type: 'END_TURN' })}
                >
                  Finish turn <ArrowRight size={17} />
                </button>
              )
            )}
            {actualBuild && isMyTurn && legal.length > 0 && (
              <details className="accessible-placement">
                <summary>
                  Keyboard placement <ChevronDown size={12} />
                </summary>
                <div>
                  <select
                    aria-label="Build location"
                    value={buildSite}
                    onChange={(e) => setSelectedSite(e.target.value)}
                  >
                    {legal.map((id) => (
                      <option key={id} value={id}>
                        {actualBuild === 'road' ? 'Road' : 'Intersection'} {id + 1}
                        {actualBuild !== 'road'
                          ? ' · ' +
                            game.board.vertices[id].hexes
                              .map(
                                (h) =>
                                  `${RESOURCE_LABELS[game.board.hexes[h].terrain as Resource] || 'Desert'} ${game.board.hexes[h].number || ''}`,
                              )
                              .join(', ')
                          : ''}
                      </option>
                    ))}
                  </select>
                  <button
                    className="secondary"
                    onClick={() => placement(Number(buildSite), actualBuild)}
                  >
                    Place
                  </button>
                </div>
              </details>
            )}
            {game.phase === 'robber' && isMyTurn && (
              <details className="accessible-placement">
                <summary>
                  Keyboard robber movement <ChevronDown size={12} />
                </summary>
                <div>
                  <select
                    aria-label="Robber destination"
                    value={robberSite}
                    onChange={(e) => setSelectedSite(e.target.value)}
                  >
                    {game.board.hexes
                      .filter((h) => h.id !== game.robberHex)
                      .map((h) => (
                        <option key={h.id} value={h.id}>
                          {RESOURCE_LABELS[h.terrain as Resource] || 'Desert'} {h.number} · Tile{' '}
                          {h.id + 1}
                        </option>
                      ))}
                  </select>
                  <button
                    className="secondary"
                    onClick={() =>
                      dispatch({
                        type: 'MOVE_ROBBER',
                        hex: Number(robberSite),
                      })
                    }
                  >
                    Move
                  </button>
                </div>
              </details>
            )}
            <div className="supply-line">
              <Anchor size={14} />
              <span>{game.deck.length} development cards in the bank</span>
            </div>
          </aside>
        )}
      </main>

      {playing && (
        <footer className="hand-bar">
          <div className="hand-label">
            <span className="eyebrow">
              {screen === 'online' ? 'YOUR RESOURCES' : `${player.name.toUpperCase()}’S HAND`}
            </span>
            <span>
              <LockKeyhole size={12} />
              {handoff !== null ? 'Hand hidden' : 'Only your hand is shown'}
            </span>
          </div>
          <div className="resource-hand">
            {RESOURCES.map((r) => (
              <div className={`resource-card resource-${r}`} key={r}>
                <span className="resource-emblem">
                  <ResourceIcon resource={r} size={25} />
                </span>
                <div>
                  <span>{RESOURCE_LABELS[r]}</span>
                  <strong>{handoff !== null ? '—' : player.resources[r]}</strong>
                </div>
                <small title="Cards remaining in the bank">{game.bank[r]} in bank</small>
              </div>
            ))}
          </div>
          <div className="hand-points">
            <Crown size={23} />
            <span>
              <strong>
                {handoff !== null ? '—' : score(game, player.id, true)}
                <small> / {game.config.targetPoints}</small>
              </strong>
              <span>VICTORY POINTS</span>
            </span>
          </div>
        </footer>
      )}

      {dialog === 'help' && (
        <Modal
          title="Your field guide"
          eyebrow="A LITTLE KNOWLEDGE GOES A LONG WAY"
          onClose={() => setDialog(null)}
          wide
        >
          <div className="rules-grid">
            <section>
              <h3>
                <Flag size={18} /> Found your island
              </h3>
              <p>
                Place two settlements and two adjoining roads, taking turns forward, then backward.
                Keep one empty intersection between all settlements. Your second settlement supplies
                your starting resources.
              </p>
            </section>
            <section>
              <h3>
                <Dice5 size={18} /> Let the island provide
              </h3>
              <p>
                Roll two dice. Every matching tile gives one resource to adjacent settlements, two
                to cities. The robber blocks its tile. Finite bank supplies apply.
              </p>
            </section>
            <section>
              <h3>
                <Hammer size={18} /> Build & trade
              </h3>
              <p>
                Extend your own roads. Build settlements at connected intersections and upgrade them
                to cities. Trade 4:1 with the bank, 3:1 at general harbors, or 2:1 at the matching
                resource harbor. Player trades need consent.
              </p>
            </section>
            <section>
              <h3>
                <Shield size={18} /> Watch for the robber
              </h3>
              <p>
                On a seven, anyone with over seven resources discards half (rounded down). Move the
                robber to a different hex and steal a random card from an adjacent opponent.
              </p>
            </section>
            <section>
              <h3>
                <Sparkles size={18} /> Keep an ace in your hand
              </h3>
              <p>
                Play one development card on your turn, before or after rolling, but never in the
                turn you buy it. Victory point cards stay secret and count automatically. Knights do
                not cause discards.
              </p>
            </section>
            <section>
              <h3>
                <Crown size={18} /> Make your mark
              </h3>
              <p>
                Settlements score 1, cities 2. The longest continuous road (at least 5) and largest
                army (at least 3 knights) each add 2 points. Reach 10 on your own turn to win.
              </p>
            </section>
            <section className="rules-extension">
              <h3>
                <Users size={18} /> A bigger table · 5–6 players
              </h3>
              <p>
                The extension has 30 terrain hexes, extra resources, and paired turns. After the
                main player finishes, the player three seats clockwise takes an action phase. They
                may build, play a development card, and trade with the bank, but cannot trade with
                players. Then the main turn moves clockwise.
              </p>
            </section>
          </div>
          <div className="guide-footer">
            Orbit: drag · Zoom: scroll · Build: 1 / 2 / 3 · Cancel: Esc
            <br />
            Independent fan project. CATAN is a trademark of its respective owners.{' '}
            <a
              href="https://www.catan.com/understand-catan/game-rules"
              target="_blank"
              rel="noreferrer"
            >
              Official rules ↗
            </a>
          </div>
        </Modal>
      )}
      {dialog === 'trade' && (
        <TradeDialog
          game={game}
          me={me}
          online={screen === 'online'}
          busy={busy}
          onClose={() => setDialog(null)}
          onBank={(give, receive) => dispatch({ type: 'BANK_TRADE', give, receive })}
          onPlayer={(target, give, receive) =>
            asyncTask(async () => {
              if (screen === 'online') {
                await connection!.proposeTrade(target, give, receive);
                setToast('Trade offer sent. Waiting for your friend to respond.');
                setDialog(null);
              } else setLocalTrade({ player: target, give, receive });
            })
          }
        />
      )}
      {dialog === 'dev' && (
        <DevDialog
          game={game}
          me={me}
          onClose={() => setDialog(null)}
          onPlay={(action) => {
            void dispatch(action);
            setDialog(null);
          }}
        />
      )}
      {dialog === 'leave' && (
        <Modal title="Leave the island?" onClose={() => setDialog(null)}>
          <p className="muted">
            {screen === 'online'
              ? 'Your seat is saved on this browser. Use “Rejoin online table” to return. Other players can continue while you are away.'
              : 'Your local game is saved automatically. You can resume it from the start screen.'}
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setDialog(null)}>
              Keep playing
            </button>
            <button className="primary" onClick={exitGame}>
              Back to the harbor
            </button>
          </div>
        </Modal>
      )}
      {playing && game.phase === 'discard' && isMyTurn && (
        <DiscardDialog
          game={game}
          playerId={actor}
          onDiscard={(resources) => dispatch({ type: 'DISCARD', player: actor, resources })}
        />
      )}
      {playing && handoff !== null && screen === 'local' && (
        <Modal title={`Over to you, ${game.players[handoff].name}.`} eyebrow="PASS THE ISLAND">
          <div className="handoff-art" style={{ color: game.players[handoff].color }}>
            <Ship size={60} strokeWidth={1} />
          </div>
          <p className="muted center">
            Pass the screen to the next explorer.
            <br />
            Their hand will appear when they’re ready.
          </p>
          <button className="primary full" onClick={() => setHandoff(null)}>
            I’m ready <ArrowRight size={17} />
          </button>
        </Modal>
      )}
      {screen === 'online' && room?.pendingTrade && room.pendingTrade.to === me && (
        <Modal
          title={`${game.players[room.pendingTrade.from].name} offers a trade`}
          eyebrow="A DEAL AT THE HARBOR"
        >
          <p className="muted">You receive</p>
          <ResourceSummary resources={room.pendingTrade.give} />
          <p className="muted">In exchange for</p>
          <ResourceSummary resources={room.pendingTrade.receive} />
          <div className="modal-actions">
            <button
              className="secondary"
              onClick={() => asyncTask(() => connection!.rejectTrade(room.pendingTrade!.id))}
            >
              Decline
            </button>
            <button
              className="primary"
              onClick={() => asyncTask(() => connection!.acceptTrade(room.pendingTrade!.id))}
            >
              Accept trade <Check size={17} />
            </button>
          </div>
        </Modal>
      )}
      {localTrade && (
        <Modal
          title={`${game.players[localTrade.player].name}, accept this trade?`}
          eyebrow="BOTH EXPLORERS MUST AGREE"
          onClose={() => setLocalTrade(null)}
        >
          <p className="muted">
            Receive <ResourceSummary resources={localTrade.give} />
          </p>
          <p className="muted">
            Give <ResourceSummary resources={localTrade.receive} />
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setLocalTrade(null)}>
              Decline
            </button>
            <button
              className="primary"
              onClick={() => {
                void dispatch({ type: 'PLAYER_TRADE', ...localTrade });
                setLocalTrade(null);
                setDialog(null);
              }}
            >
              Accept trade
            </button>
          </div>
        </Modal>
      )}
      {playing && game.phase === 'gameOver' && game.winner !== null && (
        <Modal
          title={`${game.players[game.winner].name}, the island is yours.`}
          eyebrow="A NEW LEGEND IS BORN"
        >
          <div className="winner-art">
            <Crown size={72} strokeWidth={1.2} />
          </div>
          <p className="muted center">
            {score(game, game.winner, true)} victory points. A world well built.
          </p>
          <div className="winner-results">
            {game.players.map((p) => (
              <div key={p.id}>
                <span style={{ color: p.color }}>●</span> {p.name}
                <strong>{score(game, p.id, true)} VP</strong>
              </div>
            ))}
          </div>
          <button className="primary full" onClick={exitGame}>
            Return to the harbor <ArrowRight size={16} />
          </button>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="alert">
          <span>{toast}</span>
          <button aria-label="Dismiss notification" onClick={() => setToast('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
