/**
 * RPC functions for finding and creating poker matches
 */

import { clampStartingChips, isPositiveBlind, normalizeBlind } from './user_chips';

// Module name must match the registered match handler
const POKER_MATCH_MODULE = 'poker';

// Server default when client omits startingChips
const DEFAULT_PRIVATE_STARTING_CHIPS = 1000;
const DEFAULT_SMALL_BLIND = 10;
const DEFAULT_BIG_BLIND = 20;

/**
 * Parse and validate a blinds pair. Rejects non-positive / non-finite values that
 * would mint chips via postBlinds on wallet-backed tables.
 */
function parseBlindsPair(
  smallRaw: unknown,
  bigRaw: unknown
): { ok: true; smallBlind: number; bigBlind: number } | { ok: false; error: string } {
  if (smallRaw !== undefined && smallRaw !== null && smallRaw !== '' && !isPositiveBlind(
    typeof smallRaw === 'string' ? Number(smallRaw) : smallRaw
  )) {
    return { ok: false, error: 'smallBlind must be a positive integer' };
  }
  if (bigRaw !== undefined && bigRaw !== null && bigRaw !== '' && !isPositiveBlind(
    typeof bigRaw === 'string' ? Number(bigRaw) : bigRaw
  )) {
    return { ok: false, error: 'bigBlind must be a positive integer' };
  }

  const smallBlind = smallRaw === undefined || smallRaw === null || smallRaw === ''
    ? DEFAULT_SMALL_BLIND
    : normalizeBlind(smallRaw, DEFAULT_SMALL_BLIND);
  const bigBlind = bigRaw === undefined || bigRaw === null || bigRaw === ''
    ? DEFAULT_BIG_BLIND
    : normalizeBlind(bigRaw, DEFAULT_BIG_BLIND);

  if (bigBlind < smallBlind) {
    return { ok: false, error: 'bigBlind must be >= smallBlind' };
  }

  return { ok: true, smallBlind, bigBlind };
}

/**
 * Require at least two seats so solo tables cannot farm authoritative hand stats.
 */
function parseMinPlayers(
  raw: unknown
): { ok: true; minPlayers?: number } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true };
  }
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: 'minPlayers must be an integer >= 2' };
  }
  if (value < 2) {
    return { ok: false, error: 'minPlayers must be >= 2' };
  }
  return { ok: true, minPlayers: value };
}

interface FindMatchRequest {
  minPlayers?: number;
  maxPlayers?: number;
  blinds?: string; // e.g., "10/20"
}

interface FindMatchResponse {
  matchId: string;
  label: string;
  created: boolean;
}

interface CreatePrivateMatchRequest {
  label?: string;
  minPlayers?: number;
  maxPlayers?: number;
  smallBlind?: number;
  bigBlind?: number;
  startingChips?: number;
}

/**
 * Find an available match or create a new one
 */
export const findMatchRpc: nkruntime.RpcFunction = function(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {

  logger.info('Find match RPC called', { userId: ctx.userId, payload });

  let request: FindMatchRequest = {};
  if (payload && payload.length > 0) {
    try {
      request = JSON.parse(payload);
    } catch (e) {
      logger.error('Failed to parse payload', { error: e });
    }
  }

  // Query parameters for match listing
  const limit = 10;
  const authoritative = true;
  const label = ''; // Empty to match any label
  const minSize = 0;
  const maxSize = (request.maxPlayers || 9) - 1; // Look for matches with space

  // List existing matches
  const matches = nk.matchList(limit, authoritative, label, minSize, maxSize, '');

  // Try to find a suitable match
  for (const match of matches) {
    try {
      const matchLabel = JSON.parse(match.label || '{}');

      // Check if blinds match (if specified)
      if (request.blinds && matchLabel.blinds !== request.blinds) {
        continue;
      }

      // Check if match has space
      if (matchLabel.players < matchLabel.maxPlayers) {
        logger.info('Found existing match', { matchId: match.matchId });

        const response: FindMatchResponse = {
          matchId: match.matchId,
          label: match.label || '',
          created: false
        };

        return JSON.stringify(response);
      }
    } catch (e) {
      logger.warn('Failed to parse match label', { matchId: match.matchId, error: e });
    }
  }

  // No suitable match found, create a new one
  logger.info('No suitable match found, creating new one');

  const params: { [key: string]: string } = {
    label: 'Texas Hold\'em'
  };

  const minPlayers = parseMinPlayers(request.minPlayers);
  if (!minPlayers.ok) {
    logger.warn('Rejected find_match with invalid minPlayers', {
      minPlayers: request.minPlayers,
      error: minPlayers.error,
    });
    throw Error(minPlayers.error);
  }
  if (minPlayers.minPlayers !== undefined) {
    params.minPlayers = minPlayers.minPlayers.toString();
  }
  if (request.maxPlayers) {
    params.maxPlayers = request.maxPlayers.toString();
  }
  if (request.blinds) {
    const [small, big] = request.blinds.split('/');
    const blinds = parseBlindsPair(small, big);
    if (!blinds.ok) {
      logger.warn('Rejected find_match with invalid blinds', { blinds: request.blinds, error: blinds.error });
      throw Error(blinds.error);
    }
    params.smallBlind = blinds.smallBlind.toString();
    params.bigBlind = blinds.bigBlind.toString();
  }

  const matchId = nk.matchCreate(POKER_MATCH_MODULE, params);

  logger.info('Created new match', { matchId });

  const response: FindMatchResponse = {
    matchId: matchId,
    label: params.label,
    created: true
  };

  return JSON.stringify(response);
};

/**
 * Room info for listing
 */
interface RoomInfo {
  matchId: string;
  label: string;
  players: number;
  maxPlayers: number;
  spectators: number;
  blinds: string;
  phase: string;
  createdAt?: number;
}

interface ListRoomsResponse {
  rooms: RoomInfo[];
  total: number;
}

/**
 * List all available poker rooms
 */
export const listRoomsRpc: nkruntime.RpcFunction = function(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {

  logger.info('List rooms RPC called', { userId: ctx.userId });

  const limit = 50;
  const authoritative = true;
  const label = '';
  const minSize = 0;
  const maxSize = 9; // Max players per table

  const matches = nk.matchList(limit, authoritative, label, minSize, maxSize, '');

  const rooms: RoomInfo[] = [];

  for (const match of matches) {
    try {
      const matchLabel = JSON.parse(match.label || '{}');

      rooms.push({
        matchId: match.matchId,
        label: matchLabel.name || 'Texas Hold\'em',
        players: matchLabel.players || match.size,
        maxPlayers: matchLabel.maxPlayers || 9,
        spectators: matchLabel.spectators || 0,
        blinds: matchLabel.blinds || '10/20',
        phase: matchLabel.phase || 'waiting',
        createdAt: matchLabel.createdAt,
      });
    } catch (e) {
      logger.warn('Failed to parse match label', { matchId: match.matchId, error: e });
      // Include match with default values
      rooms.push({
        matchId: match.matchId,
        label: 'Texas Hold\'em',
        players: match.size,
        maxPlayers: 9,
        spectators: 0,
        blinds: '10/20',
        phase: 'unknown',
      });
    }
  }

  // Sort by player count (most players first), then by creation time
  rooms.sort((a, b) => {
    if (b.players !== a.players) {
      return b.players - a.players;
    }
    return (b.createdAt || 0) - (a.createdAt || 0);
  });

  const response: ListRoomsResponse = {
    rooms,
    total: rooms.length,
  };

  logger.info('Listed rooms', { count: rooms.length });

  return JSON.stringify(response);
};

/**
 * Create a private match with custom settings
 */
export const createPrivateMatchRpc: nkruntime.RpcFunction = function(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {

  logger.info('Create private match RPC called', { userId: ctx.userId, payload });

  let request: CreatePrivateMatchRequest = {};
  if (payload && payload.length > 0) {
    try {
      request = JSON.parse(payload);
    } catch (e) {
      logger.error('Failed to parse payload', { error: e });
    }
  }

  // Build match parameters
  const params: { [key: string]: string } = {
    label: request.label || 'Private Game'
  };

  const minPlayers = parseMinPlayers(request.minPlayers);
  if (!minPlayers.ok) {
    logger.warn('Rejected create_private_match with invalid minPlayers', {
      minPlayers: request.minPlayers,
      error: minPlayers.error,
    });
    throw Error(minPlayers.error);
  }
  if (minPlayers.minPlayers !== undefined) {
    params.minPlayers = minPlayers.minPlayers.toString();
  }
  if (request.maxPlayers) {
    params.maxPlayers = request.maxPlayers.toString();
  }
  // Never trust client blinds — reject non-positive values that mint via postBlinds
  if (request.smallBlind !== undefined || request.bigBlind !== undefined) {
    const blinds = parseBlindsPair(request.smallBlind, request.bigBlind);
    if (!blinds.ok) {
      logger.warn('Rejected create_private_match with invalid blinds', {
        smallBlind: request.smallBlind,
        bigBlind: request.bigBlind,
        error: blinds.error,
      });
      throw Error(blinds.error);
    }
    params.smallBlind = blinds.smallBlind.toString();
    params.bigBlind = blinds.bigBlind.toString();
  }

  // Never trust raw client startingChips — clamp to server bounds
  const requestedStarting =
    typeof request.startingChips === 'number'
      ? request.startingChips
      : DEFAULT_PRIVATE_STARTING_CHIPS;
  params.startingChips = clampStartingChips(requestedStarting).toString();

  // Create the match
  const matchId = nk.matchCreate(POKER_MATCH_MODULE, params);

  logger.info('Created private match', { matchId, params });

  return JSON.stringify({
    matchId: matchId,
    label: params.label
  });
};
