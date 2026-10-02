import { validateRankings, type RankingsData } from './model';
import { RankingsError, type RankingsAccess, type RankingsReply } from './types';

async function requestPayload(path = '', method = 'GET', body?: unknown): Promise<unknown> {
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
  if (!response.ok) {
    const error =
      payload && typeof payload === 'object' && 'error' in payload ? payload.error : undefined;
    throw new RankingsError(
      typeof error === 'string' ? error : 'The request could not be completed.',
      response.status,
    );
  }
  return payload;
}
function access(payload: unknown): RankingsAccess {
  const value =
    payload && typeof payload === 'object' && 'access' in payload ? payload.access : undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    !('authenticated' in value) ||
    typeof value.authenticated !== 'boolean' ||
    !('configured' in value) ||
    typeof value.configured !== 'boolean' ||
    !('canSetup' in value) ||
    typeof value.canSetup !== 'boolean'
  ) {
    throw new RankingsError('The rankings response could not be read. Please try again.', 502);
  }
  return {
    authenticated: value.authenticated,
    configured: value.configured,
    canSetup: value.canSetup,
  };
}
async function request(path = '', method = 'GET', body?: unknown): Promise<RankingsReply> {
  const payload = await requestPayload(path, method, body);
  const permission = access(payload);
  try {
    return { data: validateRankings((payload as Partial<RankingsReply>).data), access: permission };
  } catch {
    throw new RankingsError(
      'The saved rankings could not be read. Your records have not been changed.',
      502,
    );
  }
}

export const loadRankingsAccess = async () => access(await requestPayload('/access'));
export const loadRankings = () => request();
export const saveRankings = (data: RankingsData) => request('', 'PUT', data);
export const loginRankings = (username: string, password: string) =>
  request('/login', 'POST', { username, password });
export const logoutRankings = () => request('/logout', 'POST', {});
