import { validateRankings, type RankingsData } from './model';

export interface RankingsAccess {
  authenticated: boolean;
  configured: boolean;
  canSetup: boolean;
}
export interface RankingsReply {
  data: RankingsData;
  access: RankingsAccess;
}

export class RankingsError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'RankingsError';
  }
}

async function request(path = '', method = 'GET', body?: unknown): Promise<RankingsReply> {
  let response: Response;
  try {
    response = await fetch(`/api/rankings${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new RankingsError('Could not reach the rankings server. Please try again.', 0);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RankingsError(
      'The rankings service is unavailable. Please try again.',
      response.status,
    );
  }
  const result = payload as Partial<RankingsReply> & { error?: unknown };
  if (!response.ok) {
    throw new RankingsError(
      typeof result?.error === 'string' ? result.error : 'The request could not be completed.',
      response.status,
    );
  }
  if (
    !result?.access ||
    typeof result.access.authenticated !== 'boolean' ||
    typeof result.access.configured !== 'boolean' ||
    typeof result.access.canSetup !== 'boolean'
  ) {
    throw new RankingsError('The rankings response could not be read. Please try again.', 502);
  }
  try {
    return { data: validateRankings(result.data), access: result.access };
  } catch {
    throw new RankingsError(
      'The saved rankings could not be read. Your records have not been changed.',
      502,
    );
  }
}

export const loadRankings = () => request();
export const saveRankings = (data: RankingsData) => request('', 'PUT', data);
export const loginRankings = (username: string, password: string) =>
  request('/login', 'POST', { username, password });
export const logoutRankings = () => request('/logout', 'POST', {});
