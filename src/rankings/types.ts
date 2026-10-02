import type { RankingsData } from './model';

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
