import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  Crown,
  Flag,
  LockKeyhole,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  Trophy,
  Users,
  X,
} from 'lucide-react';
import {
  buildStandings,
  emptyBreakdown,
  filterRankingsByDate,
  totalVP,
  validateRankings,
  type Breakdown,
  type RankedPlayer,
  type RankingsData,
  type RecordedGame,
} from '../rankings/model';
import {
  loadRankings,
  loginRankings,
  logoutRankings,
  saveRankings,
  watchRankingsAccess,
} from '../rankings/client';
import '../rankings.css';

type Reply = Awaited<ReturnType<typeof loadRankings>>;
type GameDraft = { id: string; date: string; notes: string; rows: PlayerDraft[]; editing: boolean };
type PlayerDraft = { id: string; selection: string; name: string; breakdown: Breakdown };
const numberFields = [
  { key: 'settlements', label: 'Settlements', points: '1 VP each', maximum: 5 },
  { key: 'cities', label: 'Cities', points: '2 VP each', maximum: 4 },
  { key: 'victoryCards', label: 'VP cards', points: '1 VP each', maximum: 6 },
  { key: 'other', label: 'Other VP', points: 'Additional points', maximum: 50 },
] as const;

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}
function errorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  if (error && typeof error === 'object' && 'status' in error && error.status === 409) {
    return `${message} Your draft is still here. Review the latest ledger before saving again.`;
  }
  return message;
}
function newRow(player?: RankedPlayer): PlayerDraft {
  return {
    id: crypto.randomUUID(),
    selection: player?.id ?? 'new',
    name: '',
    breakdown: emptyBreakdown(),
  };
}
function initials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}
function Modal({
  title,
  subtitle,
  children,
  onClose,
  busy = false,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useRef(`rankings-dialog-${crypto.randomUUID()}`).current;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`rankings-modal${wide ? ' rankings-modal-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="rankings-modal-heading">
        <div>
          <p className="rankings-eyebrow">The keeper’s desk</p>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button
          type="button"
          className="rankings-icon"
          aria-label={`Close ${title.toLowerCase()}`}
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function ErrorNotice({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rankings-error">
      {children}
    </div>
  );
}

export default function RankingsPage({ onBack }: { onBack: () => void }) {
  const [reply, setReply] = useState<Reply | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [authOpen, setAuthOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [draft, setDraft] = useState<GameDraft | null>(null);
  const [roster, setRoster] = useState<RankedPlayer[] | null>(null);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [deleteGame, setDeleteGame] = useState<RecordedGame | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [conflict, setConflict] = useState<Reply | null>(null);
  const [needsReview, setNeedsReview] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const data = reply?.data;
  const owner = reply?.access.authenticated ?? false;
  const rangeActive = Boolean(fromDate || toDate);
  // The filtered copy is for presentation only. Owner actions below continue to
  // read and save the complete reply.data, including games outside this range.
  const filtered = useMemo(() => {
    if (!data) return { data: null, error: '' };
    try {
      return {
        data: filterRankingsByDate(data, { from: fromDate || undefined, to: toDate || undefined }),
        error: '',
      };
    } catch (error) {
      return { data: null, error: errorMessage(error) };
    }
  }, [data, fromDate, toDate]);
  const standings = useMemo(
    () =>
      filtered.data
        ? buildStandings(filtered.data).filter((entry) => !rangeActive || entry.gamesPlayed > 0)
        : [],
    [filtered.data, rangeActive],
  );
  const games = useMemo(
    () =>
      filtered.data
        ? [...filtered.data.games].sort(
            (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
          )
        : [],
    [filtered.data],
  );
  const totalPoints = standings.reduce((sum, entry) => sum + entry.totalVP, 0);
  const playersById = useMemo(
    () => new Map(data?.players.map((player) => [player.id, player]) ?? []),
    [data],
  );
  const rangeDescription =
    fromDate && toDate
      ? `${formatDate(fromDate)} to ${formatDate(toDate)} · both dates included`
      : fromDate
        ? `From ${formatDate(fromDate)} onward`
        : toDate
          ? `Through ${formatDate(toDate)}`
          : 'All recorded games';

  async function refresh() {
    setLoading(true);
    setLoadError('');
    try {
      setReply(await loadRankings());
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let mounted = true;
    loadRankings()
      .then((result) => {
        if (mounted) setReply(result);
      })
      .catch((error: unknown) => {
        if (mounted) setLoadError(errorMessage(error));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(
    () =>
      watchRankingsAccess((access) => {
        // Permission changes must not replace an unsaved game or roster draft.
        setReply((current) => (current ? { ...current, access } : current));
      }),
    [],
  );

  function closeAuth() {
    setAuthOpen(false);
    setPassword('');
    setUsername('');
    setAuthError('');
  }
  async function authenticate(event: FormEvent) {
    event.preventDefault();
    setAuthError('');
    setAuthBusy(true);
    try {
      const result = await loginRankings(username, password);
      setReply((previous) =>
        previous && (draft || roster || deleteGame) ? { ...result, data: previous.data } : result,
      );
      closeAuth();
      setNotice('Owner editing is unlocked. Changes you save are visible to everyone.');
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }
  async function lockEditing() {
    setAuthBusy(true);
    setLoadError('');
    try {
      setReply(await logoutRankings());
      setNotice('Editing is locked. The rankings remain visible to everyone.');
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }
  function openGame(game?: RecordedGame) {
    if (!data) return;
    setSaveError('');
    setNeedsReview(false);
    setConflict(null);
    setDraft(
      game
        ? {
            id: game.id,
            date: game.date,
            notes: game.notes,
            editing: true,
            rows: game.results.map((result) => ({
              id: crypto.randomUUID(),
              selection: result.playerId,
              name: '',
              breakdown: { ...result.breakdown },
            })),
          }
        : {
            id: crypto.randomUUID(),
            date: today(),
            notes: '',
            editing: false,
            rows: [newRow(data.players[0]), newRow(data.players[1])],
          },
    );
  }
  function updateRow(id: string, update: Partial<PlayerDraft>) {
    setDraft((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (row.id === id ? { ...row, ...update } : row)),
          }
        : null,
    );
  }
  async function persist(next: RankingsData, success: string) {
    setSaving(true);
    setSaveError('');
    try {
      setReply(await saveRankings(validateRankings(next)));
      setNotice(success);
      return true;
    } catch (error) {
      setSaveError(errorMessage(error));
      if (error && typeof error === 'object' && 'status' in error) {
        if (error.status === 409) setNeedsReview(true);
        if (error.status === 401) {
          setAuthOpen(true);
          setPassword('');
          setAuthError('Your editing session expired. Sign in to keep working on this draft.');
        }
      }
      return false;
    } finally {
      setSaving(false);
    }
  }
  async function submitGame(event: FormEvent) {
    event.preventDefault();
    if (!draft || !data) return;
    const added: RankedPlayer[] = [];
    const results = draft.rows.map((row) => {
      if (row.selection === 'new') added.push({ id: row.id, name: row.name.trim() });
      return {
        playerId: row.selection === 'new' ? row.id : row.selection,
        breakdown: row.breakdown,
      };
    });
    const game: RecordedGame = {
      id: draft.id,
      date: draft.date,
      notes: draft.notes.trim(),
      results,
    };
    const next = {
      ...data,
      players: [...data.players, ...added],
      games: draft.editing
        ? data.games.map((entry) => (entry.id === game.id ? game : entry))
        : [...data.games, game],
    };
    if (
      await persist(
        next,
        draft.editing
          ? 'Game updated. The standings have been recalculated.'
          : 'Game recorded. The standings have been updated.',
      )
    )
      setDraft(null);
  }
  async function submitRoster(event: FormEvent) {
    event.preventDefault();
    if (!roster || !data) return;
    const nextPlayers = newPlayerName.trim()
      ? [...roster, { id: crypto.randomUUID(), name: newPlayerName.trim() }]
      : roster;
    if (await persist({ ...data, players: nextPlayers }, 'Player roster saved.')) {
      setRoster(null);
      setNewPlayerName('');
    }
  }
  async function confirmDelete() {
    if (!deleteGame || !data) return;
    if (
      await persist(
        { ...data, games: data.games.filter((game) => game.id !== deleteGame.id) },
        'Game removed. The standings have been recalculated.',
      )
    )
      setDeleteGame(null);
  }
  function toggleExpanded(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function reviewLatest() {
    setSaving(true);
    try {
      setConflict(await loadRankings());
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }
  const conflictNotice = needsReview && (
    <div className="rankings-conflict">
      <h3>The shared ledger has changed</h3>
      <p>
        {deleteGame
          ? 'Review the latest version of this game before deciding whether to delete it.'
          : 'Your unsaved entries are preserved. Review the latest records, then decide whether to apply your draft to that version.'}
      </p>
      {!conflict ? (
        <button
          className="rankings-button rankings-button-outline"
          type="button"
          disabled={saving}
          onClick={() => void reviewLatest()}
        >
          Review latest changes
        </button>
      ) : (
        <>
          <div className="rankings-conflict-details">
            <strong>Latest ledger · {conflict.data.games.length} games</strong>
            {draft?.editing || deleteGame ? (
              (() => {
                const latest = conflict.data.games.find(
                  (game) => game.id === (deleteGame?.id ?? draft?.id),
                );
                return latest ? (
                  <p>
                    {formatDate(latest.date)}:{' '}
                    {latest.results
                      .map(
                        (result) =>
                          `${conflict.data.players.find((player) => player.id === result.playerId)?.name ?? 'Player'} ${totalVP(result.breakdown)} VP`,
                      )
                      .join(' · ')}
                    {latest.notes && ` — ${latest.notes}`}
                  </p>
                ) : (
                  <p>
                    {deleteGame
                      ? 'This game has already been deleted from the ledger.'
                      : 'This game has been deleted. Keeping your draft will restore it.'}
                  </p>
                );
              })()
            ) : (
              <p>
                Players:{' '}
                {conflict.data.players.map((player) => player.name).join(', ') || 'None yet'}.
              </p>
            )}
          </div>
          <button
            className="rankings-button rankings-button-outline"
            type="button"
            onClick={() => {
              setReply(conflict);
              if (deleteGame) {
                const latest = conflict.data.games.find((game) => game.id === deleteGame.id);
                setDeleteGame(latest ?? null);
                if (!latest)
                  setNotice('This game has already been removed from the shared ledger.');
              }
              if (draft?.editing && !conflict.data.games.some((game) => game.id === draft.id))
                setDraft({ ...draft, editing: false });
              if (roster)
                setRoster([
                  ...roster,
                  ...conflict.data.players.filter(
                    (player) => !roster.some((entry) => entry.id === player.id),
                  ),
                ]);
              setNeedsReview(false);
              setConflict(null);
              setSaveError('');
            }}
          >
            {deleteGame ? 'Continue with the latest game' : 'Keep my draft with the latest ledger'}
          </button>
          <p className="rankings-field-hint">
            {deleteGame
              ? 'After reviewing, use Delete game to confirm removal of the latest record.'
              : 'Review your entries, then save to apply them. Edits to this game or player names will replace their latest values.'}
          </p>
        </>
      )}
    </div>
  );

  return (
    <div className="rankings-page">
      <header className="rankings-topbar">
        <button className="rankings-back" onClick={onBack}>
          <ArrowLeft size={17} />
          <span>Back to Catan</span>
        </button>
        <div className="rankings-brand">
          <Crown size={25} />
          <span>
            CATAN<span>The island chronicles</span>
          </span>
        </div>
        <span className={`rankings-access ${owner ? 'is-owner' : ''}`}>
          <Shield size={14} />
          {owner ? 'Keeper' : 'Public ledger'}
        </span>
      </header>
      <main className="rankings-main">
        <div className="rankings-hero">
          <div className="rankings-hero-copy">
            <p className="rankings-eyebrow">
              <span /> A legacy written in victory points
            </p>
            <h1>Rankings of the Realm</h1>
            <p>
              Every settlement has a story. Keep the scores, honour the players, and watch your
              island’s history unfold.
            </p>
          </div>
          <div className="rankings-hero-seal" aria-hidden="true">
            <Trophy size={53} strokeWidth={1.15} />
            <span>Honour &amp; prosperity</span>
            <i>✦</i>
          </div>
        </div>
        <div className="rankings-toolbar">
          <div className="rankings-shared">
            <Shield size={17} />
            <span>
              Shared ledger <b>·</b> {owner ? 'Owner editing unlocked' : 'Only the owner can edit'}
            </span>
          </div>
          <div className="rankings-actions">
            <button
              className="rankings-button rankings-button-quiet"
              onClick={() => void refresh()}
              disabled={loading || saving}
              aria-label="Refresh rankings"
            >
              <RefreshCw size={15} className={loading ? 'rankings-spinning' : ''} />
              <span>Refresh</span>
            </button>
            {reply &&
              (owner ? (
                <button
                  className="rankings-button rankings-button-quiet"
                  onClick={() => void lockEditing()}
                  disabled={authBusy}
                >
                  <LockKeyhole size={15} />
                  Lock editing
                </button>
              ) : (
                <button
                  className="rankings-button rankings-button-quiet"
                  onClick={() => {
                    setAuthError('');
                    setAuthOpen(true);
                  }}
                  disabled={!reply.access.configured}
                  title={!reply.access.configured ? 'Owner access is unavailable.' : undefined}
                >
                  <LockKeyhole size={15} />
                  Owner sign in
                </button>
              ))}
          </div>
        </div>
        {reply && !reply.access.configured && (
          <p className="rankings-field-hint" role="status">
            Owner access is unavailable. The ledger is available to read.
          </p>
        )}
        {loadError && (
          <ErrorNotice>
            {loadError}{' '}
            <button
              className="rankings-text-button"
              onClick={() => void refresh()}
              disabled={loading}
            >
              Try again
            </button>
          </ErrorNotice>
        )}
        {notice && (
          <div className="rankings-notice" role="status">
            <Check size={17} />
            <span>{notice}</span>
            <button aria-label="Dismiss notification" onClick={() => setNotice('')}>
              <X size={15} />
            </button>
          </div>
        )}
        {loading && !reply && (
          <div className="rankings-loading" role="status">
            <BookOpen size={34} />
            <p>Opening the island ledger…</p>
          </div>
        )}
        {data && (
          <>
            <section className="rankings-date-filter" aria-labelledby="rankings-filter-title">
              <div className="rankings-date-filter-heading">
                <CalendarDays size={21} aria-hidden="true" />
                <div>
                  <h2 id="rankings-filter-title">Date range</h2>
                  <p id="rankings-filter-description" aria-live="polite">
                    {filtered.error ? 'Choose a valid range to view the ledger.' : rangeDescription}
                  </p>
                </div>
              </div>
              <div className="rankings-date-controls">
                <label htmlFor="rankings-from-date">
                  From date
                  <input
                    id="rankings-from-date"
                    type="date"
                    value={fromDate}
                    aria-invalid={Boolean(filtered.error)}
                    aria-describedby={
                      filtered.error ? 'rankings-date-error' : 'rankings-filter-description'
                    }
                    onChange={(event) => setFromDate(event.target.value)}
                  />
                </label>
                <label htmlFor="rankings-to-date">
                  To date
                  <input
                    id="rankings-to-date"
                    type="date"
                    value={toDate}
                    aria-invalid={Boolean(filtered.error)}
                    aria-describedby={
                      filtered.error ? 'rankings-date-error' : 'rankings-filter-description'
                    }
                    onChange={(event) => setToDate(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="rankings-button rankings-button-outline"
                  disabled={!rangeActive}
                  onClick={() => {
                    setFromDate('');
                    setToDate('');
                  }}
                >
                  <X size={14} aria-hidden="true" />
                  All dates
                </button>
              </div>
              {filtered.error && (
                <p id="rankings-date-error" className="rankings-date-error" role="alert">
                  {filtered.error}
                </p>
              )}
            </section>
            {filtered.data && (
              <>
                <div className="rankings-stats" aria-label="Ledger statistics">
                  <div>
                    <Users size={20} />
                    <span>
                      <strong>{standings.length}</strong>
                      {rangeActive ? 'Players in this range' : 'Players in the ledger'}
                    </span>
                  </div>
                  <div>
                    <BookOpen size={20} />
                    <span>
                      <strong>{games.length}</strong>
                      {rangeActive ? 'Games in this range' : 'Games recorded'}
                    </span>
                  </div>
                  <div>
                    <Crown size={20} />
                    <span>
                      <strong>{totalPoints}</strong>Victory points earned
                    </span>
                  </div>
                </div>
                <div className="rankings-columns">
                  <section
                    className="rankings-paper rankings-leaderboard"
                    aria-labelledby="rankings-standings-title"
                  >
                    <div className="rankings-section-heading">
                      <div>
                        <p className="rankings-eyebrow">The standing of the houses</p>
                        <h2 id="rankings-standings-title">Player rankings</h2>
                      </div>
                      <Trophy size={24} strokeWidth={1.3} />
                    </div>
                    {standings.length ? (
                      <div className="rankings-table-wrap">
                        <table className="rankings-table">
                          <caption className="rankings-sr-only">
                            Players ranked by total victory points across{' '}
                            {rangeActive
                              ? 'games in the selected date range'
                              : 'all recorded games'}
                            . Tied totals share a rank.
                          </caption>
                          <thead>
                            <tr>
                              <th scope="col">Rank</th>
                              <th scope="col">Player</th>
                              <th scope="col">Games</th>
                              <th scope="col">Average</th>
                              <th scope="col">Total VP</th>
                              <th scope="col">Wins</th>
                            </tr>
                          </thead>
                          <tbody>
                            {standings.map((entry) => (
                              <tr
                                key={entry.player.id}
                                className={entry.rank === 1 ? 'rankings-first' : ''}
                              >
                                <td>
                                  <span
                                    className={`rankings-place ${entry.rank === 1 ? 'rankings-place-first' : ''}`}
                                  >
                                    {entry.rank === 1 && <Crown size={13} />}
                                    {entry.rank ?? '—'}
                                  </span>
                                </td>
                                <th scope="row">
                                  <span className="rankings-player">
                                    <span className="rankings-player-crest" aria-hidden="true">
                                      {initials(entry.player.name)}
                                    </span>
                                    <span>
                                      {entry.player.name}
                                      {entry.gamesPlayed === 0 && (
                                        <small>Awaiting their first game</small>
                                      )}
                                    </span>
                                  </span>
                                </th>
                                <td>{entry.gamesPlayed}</td>
                                <td>{entry.gamesPlayed ? entry.averageVP.toFixed(1) : '—'}</td>
                                <td className="rankings-total">{entry.totalVP}</td>
                                <td className="rankings-wins">{entry.wins}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="rankings-empty">
                        <Crown size={42} strokeWidth={1} />
                        <h3>
                          {rangeActive ? 'No games in this date range' : 'A new chronicle begins'}
                        </h3>
                        <p>
                          {rangeActive
                            ? 'Choose another range, or select All dates to return to the complete ledger.'
                            : owner
                              ? 'Record your first game and add its players to bring the rankings to life.'
                              : 'The owner hasn’t recorded any players yet. Their first game will begin the rankings.'}
                        </p>
                        {owner && !rangeActive && (
                          <button
                            className="rankings-button rankings-button-primary"
                            onClick={() => openGame()}
                          >
                            <Plus size={16} />
                            Record game
                          </button>
                        )}
                      </div>
                    )}
                    <div className="rankings-table-note">
                      <Flag size={14} />
                      <span>
                        Ranked by total victory points. Equal totals share a rank. Wins count the
                        highest positive VP in a game; tied leaders share a win.
                      </span>
                    </div>
                  </section>
                  <aside className="rankings-ledger-aside">
                    {owner && (
                      <section className="rankings-owner-card">
                        <span className="rankings-owner-icon">
                          <Pencil size={22} />
                        </span>
                        <p className="rankings-eyebrow">You are the keeper</p>
                        <h2>Write the next chapter.</h2>
                        <p>
                          Add a game, enter each player’s points, and the rankings take care of
                          themselves.
                        </p>
                        <button
                          className="rankings-button rankings-button-primary"
                          onClick={() => openGame()}
                        >
                          <Plus size={17} />
                          Record game
                          <ArrowRight size={17} />
                        </button>
                        <button
                          className="rankings-button rankings-button-outline"
                          onClick={() => {
                            setRoster(data.players.map((player) => ({ ...player })));
                            setNewPlayerName('');
                            setSaveError('');
                            setNeedsReview(false);
                            setConflict(null);
                          }}
                        >
                          <Users size={16} />
                          Manage players
                        </button>
                      </section>
                    )}
                    <section className="rankings-guide">
                      <p className="rankings-eyebrow">A tally of triumphs</p>
                      <h3>How points are counted</h3>
                      <dl>
                        <div>
                          <dt>Settlement</dt>
                          <dd>1 VP</dd>
                        </div>
                        <div>
                          <dt>City</dt>
                          <dd>2 VP</dd>
                        </div>
                        <div>
                          <dt>Victory point card</dt>
                          <dd>1 VP</dd>
                        </div>
                        <div>
                          <dt>Longest Road</dt>
                          <dd>2 VP</dd>
                        </div>
                        <div>
                          <dt>Largest Army</dt>
                          <dd>2 VP</dd>
                        </div>
                      </dl>
                      <p>
                        Each game stores the complete breakdown. Additional points can be entered
                        for house rules or other awards.
                      </p>
                    </section>
                  </aside>
                </div>
                <section className="rankings-chronicle" aria-labelledby="rankings-chronicle-title">
                  <div className="rankings-chronicle-heading">
                    <div>
                      <p className="rankings-eyebrow">The island remembers</p>
                      <h2 id="rankings-chronicle-title">Game chronicle</h2>
                    </div>
                    <span>
                      {games.length} {games.length === 1 ? 'record' : 'records'}
                    </span>
                  </div>
                  {games.length === 0 ? (
                    <div className="rankings-paper rankings-chronicle-empty">
                      <BookOpen size={28} strokeWidth={1.3} />
                      <div>
                        <h3>
                          {rangeActive
                            ? 'The chronicle is empty for these dates'
                            : 'No games recorded yet'}
                        </h3>
                        <p>
                          {rangeActive
                            ? 'Change the date range above to see other recorded games.'
                            : 'Dates, players, and every victory point will be preserved here.'}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="rankings-games">
                      {games.map((game) => {
                        const sorted = [...game.results].sort(
                          (a, b) => totalVP(b.breakdown) - totalVP(a.breakdown),
                        );
                        const high = totalVP(sorted[0].breakdown);
                        const isExpanded = expanded.has(game.id);
                        return (
                          <article
                            key={game.id}
                            className={`rankings-paper rankings-game ${isExpanded ? 'is-expanded' : ''}`}
                          >
                            <div className="rankings-game-heading">
                              <button
                                className="rankings-game-toggle"
                                aria-expanded={isExpanded}
                                aria-controls={`game-${game.id}`}
                                onClick={() => toggleExpanded(game.id)}
                              >
                                <span className="rankings-date-mark">
                                  <CalendarDays size={20} />
                                </span>
                                <span>
                                  <strong>{formatDate(game.date)}</strong>
                                  <small>
                                    {game.results.length} players <b>·</b>{' '}
                                    {game.results.reduce(
                                      (sum, result) => sum + totalVP(result.breakdown),
                                      0,
                                    )}{' '}
                                    total VP
                                  </small>
                                </span>
                                <ChevronDown size={19} className="rankings-chevron" />
                              </button>
                              {owner && (
                                <div className="rankings-game-edit">
                                  <button
                                    className="rankings-icon"
                                    aria-label={`Edit game on ${formatDate(game.date)}`}
                                    title="Edit game"
                                    onClick={() => openGame(game)}
                                  >
                                    <Pencil size={16} />
                                  </button>
                                  <button
                                    className="rankings-icon rankings-delete"
                                    aria-label={`Delete game on ${formatDate(game.date)}`}
                                    title="Delete game"
                                    onClick={() => {
                                      setDeleteGame(game);
                                      setSaveError('');
                                      setNeedsReview(false);
                                      setConflict(null);
                                    }}
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                              )}
                            </div>
                            <div className="rankings-result-strip">
                              {sorted.map((result) => (
                                <span
                                  className={
                                    high > 0 && totalVP(result.breakdown) === high
                                      ? 'rankings-result-high'
                                      : ''
                                  }
                                  key={result.playerId}
                                >
                                  {high > 0 && totalVP(result.breakdown) === high && (
                                    <Crown size={12} />
                                  )}
                                  <span>
                                    {playersById.get(result.playerId)?.name ?? 'Unknown player'}
                                  </span>
                                  <b>
                                    {totalVP(result.breakdown)}
                                    <small> VP</small>
                                  </b>
                                </span>
                              ))}
                            </div>
                            {isExpanded && (
                              <div className="rankings-game-details" id={`game-${game.id}`}>
                                {game.notes && <p className="rankings-game-notes">{game.notes}</p>}
                                <p className="rankings-scroll-hint">
                                  Swipe to see all points{' '}
                                  <ArrowRight size={13} aria-hidden="true" />
                                </p>
                                <div
                                  className="rankings-table-wrap"
                                  tabIndex={0}
                                  role="region"
                                  aria-label="Scrollable victory point breakdown"
                                >
                                  <table className="rankings-breakdown-table">
                                    <caption>Victory point breakdown</caption>
                                    <thead>
                                      <tr>
                                        <th scope="col">Player</th>
                                        <th scope="col">Settlements</th>
                                        <th scope="col">Cities</th>
                                        <th scope="col">VP cards</th>
                                        <th scope="col">Longest Road</th>
                                        <th scope="col">Largest Army</th>
                                        <th scope="col">Other</th>
                                        <th scope="col">Total</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {sorted.map(({ playerId, breakdown }) => (
                                        <tr key={playerId}>
                                          <th scope="row">
                                            {playersById.get(playerId)?.name ?? 'Unknown player'}
                                          </th>
                                          <td>
                                            {breakdown.settlements}
                                            <small>{breakdown.settlements} VP</small>
                                          </td>
                                          <td>
                                            {breakdown.cities}
                                            <small>{breakdown.cities * 2} VP</small>
                                          </td>
                                          <td>
                                            {breakdown.victoryCards}
                                            <small>{breakdown.victoryCards} VP</small>
                                          </td>
                                          <td>{breakdown.longestRoad ? '2 VP' : '—'}</td>
                                          <td>{breakdown.largestArmy ? '2 VP' : '—'}</td>
                                          <td>{breakdown.other} VP</td>
                                          <td className="rankings-total">
                                            {totalVP(breakdown)}
                                            <small>VP</small>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}
                            {!isExpanded && (
                              <button
                                className="rankings-view-breakdown"
                                onClick={() => toggleExpanded(game.id)}
                              >
                                View victory point breakdown
                                <ChevronDown size={13} />
                              </button>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
                <footer className="rankings-footer">
                  <span>✦</span>
                  <p>Earned on the island. Remembered in the ledger.</p>
                  <span>✦</span>
                </footer>
              </>
            )}
          </>
        )}
      </main>
      {authOpen && reply && (
        <Modal
          title="Owner sign in"
          subtitle="Sign in with your owner username to manage games and players."
          onClose={closeAuth}
          busy={authBusy}
        >
          <form onSubmit={(event) => void authenticate(event)} className="rankings-form">
            <label htmlFor="rankings-username">
              Owner username
              <input
                id="rankings-username"
                type="text"
                autoComplete="username"
                required
                maxLength={128}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoFocus
              />
            </label>
            <label htmlFor="rankings-password">
              Owner password
              <input
                id="rankings-password"
                type="password"
                autoComplete="current-password"
                required
                maxLength={1024}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {authError && <ErrorNotice>{authError}</ErrorNotice>}
            <div className="rankings-modal-footer">
              <button
                type="button"
                className="rankings-button rankings-button-outline"
                onClick={closeAuth}
                disabled={authBusy}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rankings-button rankings-button-primary"
                disabled={authBusy}
              >
                <LockKeyhole size={15} />
                {authBusy ? 'Unlocking…' : 'Unlock editing'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {draft && data && (
        <Modal
          title={draft.editing ? 'Edit game' : 'Record game'}
          subtitle="Enter the pieces and awards each player finished with. Victory points are calculated automatically."
          onClose={() => setDraft(null)}
          busy={saving}
          wide
        >
          <form className="rankings-form" onSubmit={(event) => void submitGame(event)}>
            <div className="rankings-game-fields">
              <label htmlFor="rankings-game-date">
                Game date
                <input
                  id="rankings-game-date"
                  type="date"
                  required
                  value={draft.date}
                  onChange={(event) => setDraft({ ...draft, date: event.target.value })}
                />
              </label>
              <label htmlFor="rankings-game-notes">
                Notes <span className="rankings-optional">optional</span>
                <input
                  id="rankings-game-notes"
                  maxLength={2000}
                  placeholder="An epic comeback, a new island, a memorable trade…"
                  value={draft.notes}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </label>
            </div>
            <div className="rankings-editor-heading">
              <h3>Players &amp; victory points</h3>
              <span>{draft.rows.length} / 6 players</span>
            </div>
            <p className="rankings-field-hint">
              Enter piece counts, not points: 2 cities are worth 4 VP. Count only settlements still
              on the board, not those upgraded to cities.
            </p>
            <div className="rankings-player-editors">
              {draft.rows.map((row, index) => (
                <fieldset className="rankings-player-editor" key={row.id}>
                  <legend>Player {index + 1}</legend>
                  <div className="rankings-player-editor-top">
                    <div className="rankings-player-select">
                      <label htmlFor={`player-${row.id}`}>
                        Player {index + 1}
                        <select
                          id={`player-${row.id}`}
                          value={row.selection}
                          onChange={(event) => updateRow(row.id, { selection: event.target.value })}
                        >
                          <option value="new">+ Add a new player</option>
                          {data.players.map((player) => (
                            <option
                              key={player.id}
                              value={player.id}
                              disabled={draft.rows.some(
                                (other) => other.id !== row.id && other.selection === player.id,
                              )}
                            >
                              {player.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      {row.selection === 'new' && (
                        <label htmlFor={`player-name-${row.id}`}>
                          New player name
                          <input
                            id={`player-name-${row.id}`}
                            aria-label={`Player ${index + 1} name`}
                            value={row.name}
                            onChange={(event) => updateRow(row.id, { name: event.target.value })}
                            required
                            maxLength={40}
                            placeholder="Player name"
                          />
                        </label>
                      )}
                    </div>
                    <output
                      className="rankings-live-score"
                      aria-label={`Player ${index + 1} total victory points`}
                    >
                      <strong>{totalVP(row.breakdown)}</strong>
                      <span>Victory points</span>
                    </output>
                    <button
                      className="rankings-icon rankings-remove-player"
                      type="button"
                      aria-label={`Remove player ${index + 1}`}
                      disabled={saving || draft.rows.length <= 2}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          rows: draft.rows.filter((other) => other.id !== row.id),
                        })
                      }
                    >
                      <X size={17} />
                    </button>
                  </div>
                  <div className="rankings-number-fields">
                    {numberFields.map((field) => (
                      <label key={field.key}>
                        {field.label}
                        <input
                          type="number"
                          min={0}
                          max={field.maximum}
                          step={1}
                          required
                          aria-label={`Player ${index + 1} ${field.key === 'victoryCards' ? 'victory point cards' : field.key === 'other' ? 'other victory points' : field.key}`}
                          value={row.breakdown[field.key]}
                          onChange={(event) =>
                            updateRow(row.id, {
                              breakdown: {
                                ...row.breakdown,
                                [field.key]: Number(event.target.value),
                              },
                            })
                          }
                        />
                        <small>{field.points}</small>
                      </label>
                    ))}
                  </div>
                  <div className="rankings-awards">
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Player ${index + 1} Longest Road`}
                        checked={row.breakdown.longestRoad}
                        onChange={(event) =>
                          updateRow(row.id, {
                            breakdown: { ...row.breakdown, longestRoad: event.target.checked },
                          })
                        }
                      />
                      <Flag size={16} />
                      <span>Longest Road</span>
                      <b>+2 VP</b>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`Player ${index + 1} Largest Army`}
                        checked={row.breakdown.largestArmy}
                        onChange={(event) =>
                          updateRow(row.id, {
                            breakdown: { ...row.breakdown, largestArmy: event.target.checked },
                          })
                        }
                      />
                      <Shield size={16} />
                      <span>Largest Army</span>
                      <b>+2 VP</b>
                    </label>
                  </div>
                </fieldset>
              ))}
            </div>
            {draft.rows.length < 6 && (
              <button
                className="rankings-button rankings-button-outline rankings-add-player"
                type="button"
                disabled={saving}
                onClick={() => {
                  const available = data.players.find(
                    (player) => !draft.rows.some((row) => row.selection === player.id),
                  );
                  setDraft({ ...draft, rows: [...draft.rows, newRow(available)] });
                }}
              >
                <Plus size={16} />
                Add player
              </button>
            )}
            {saveError && <ErrorNotice>{saveError}</ErrorNotice>}
            {conflictNotice}
            <div className="rankings-modal-footer rankings-game-footer">
              <span>
                <Users size={15} />
                {draft.rows.length} players <b>·</b>{' '}
                {draft.rows.reduce((sum, row) => sum + totalVP(row.breakdown), 0)} VP in this game
              </span>
              <div>
                <button
                  type="button"
                  className="rankings-button rankings-button-outline"
                  disabled={saving}
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rankings-button rankings-button-primary"
                  disabled={saving || needsReview}
                >
                  <Check size={16} />
                  {saving ? 'Saving…' : 'Save game'}
                </button>
              </div>
            </div>
          </form>
        </Modal>
      )}
      {roster && (
        <Modal
          title="Manage players"
          subtitle="Names are shared across the rankings and every recorded game."
          onClose={() => setRoster(null)}
          busy={saving}
        >
          <form className="rankings-form" onSubmit={(event) => void submitRoster(event)}>
            <div className="rankings-roster">
              {roster.map((player, index) => (
                <label key={player.id} htmlFor={`roster-${player.id}`}>
                  Player {index + 1}
                  <input
                    id={`roster-${player.id}`}
                    aria-label={`Rename ${playersById.get(player.id)?.name ?? `player ${index + 1}`}`}
                    value={player.name}
                    required
                    maxLength={40}
                    onChange={(event) =>
                      setRoster(
                        roster.map((entry) =>
                          entry.id === player.id ? { ...entry, name: event.target.value } : entry,
                        ),
                      )
                    }
                  />
                </label>
              ))}
            </div>
            <label htmlFor="rankings-new-player">
              Add a player <span className="rankings-optional">optional</span>
              <input
                id="rankings-new-player"
                placeholder="New player name"
                maxLength={40}
                value={newPlayerName}
                onChange={(event) => setNewPlayerName(event.target.value)}
              />
            </label>
            <p className="rankings-field-hint">
              Players need a recorded game before they receive a rank. You can also add new players
              while recording a game.
            </p>
            {saveError && <ErrorNotice>{saveError}</ErrorNotice>}
            {conflictNotice}
            <div className="rankings-modal-footer">
              <button
                type="button"
                className="rankings-button rankings-button-outline"
                disabled={saving}
                onClick={() => setRoster(null)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rankings-button rankings-button-primary"
                disabled={saving || needsReview}
              >
                {saving ? 'Saving…' : 'Save players'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleteGame && (
        <Modal
          title="Delete game"
          subtitle={`Remove the game recorded on ${formatDate(deleteGame.date)}?`}
          onClose={() => setDeleteGame(null)}
          busy={saving}
        >
          <div className="rankings-form">
            <p>
              This removes the game and all of its victory points from the shared rankings. The
              players stay in your roster.
            </p>
            {saveError && <ErrorNotice>{saveError}</ErrorNotice>}
            {conflictNotice}
            <div className="rankings-modal-footer">
              <button
                className="rankings-button rankings-button-outline"
                onClick={() => setDeleteGame(null)}
                disabled={saving}
              >
                Keep game
              </button>
              <button
                className="rankings-button rankings-button-danger"
                onClick={() => void confirmDelete()}
                disabled={saving || needsReview}
              >
                <Trash2 size={15} />
                {saving ? 'Deleting…' : 'Delete game'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
