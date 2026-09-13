/**
 * Private-room invite password helpers.
 * Password stays out of the public match label; authorized match players
 * retrieve it via matchSignal when sending invites.
 */

import { GameState } from './types';

export const MATCH_SIGNAL_GET_PASSWORD = 'get_password';

export interface GetPasswordSignalRequest {
  action: typeof MATCH_SIGNAL_GET_PASSWORD;
  userId: string;
}

export type GetPasswordSignalResponse =
  | { success: true; password: string | null }
  | { success: false; error: string };

/**
 * Return match password only when the requester is a player in the match.
 */
export function authorizeAndGetMatchPassword(
  state: Pick<GameState, 'password' | 'players'>,
  requesterId: string
): GetPasswordSignalResponse {
  if (!requesterId || !state.players.has(requesterId)) {
    return { success: false, error: 'unauthorized' };
  }
  return { success: true, password: state.password };
}

export function buildGetPasswordSignal(userId: string): string {
  return JSON.stringify({
    action: MATCH_SIGNAL_GET_PASSWORD,
    userId,
  } satisfies GetPasswordSignalRequest);
}

/**
 * Parse nk.matchSignal response and extract a usable password string.
 */
export function parsePasswordFromMatchSignal(response: string): string | undefined {
  if (!response) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(response) as GetPasswordSignalResponse;
    if (parsed && parsed.success === true && typeof parsed.password === 'string' && parsed.password.length > 0) {
      return parsed.password;
    }
  } catch {
    // Response is not JSON (e.g. legacy "signal acknowledged")
    return undefined;
  }
  return undefined;
}

/**
 * Handle matchSignal payload. Unknown / non-JSON signals keep legacy ack behavior.
 */
export function handleMatchSignalPayload(
  state: Pick<GameState, 'password' | 'players'>,
  data: string
): string {
  try {
    const request = JSON.parse(data) as { action?: string; userId?: string };
    if (request.action === MATCH_SIGNAL_GET_PASSWORD) {
      return JSON.stringify(authorizeAndGetMatchPassword(state, request.userId || ''));
    }
  } catch {
    // Non-JSON signals fall through to acknowledge
  }
  return 'signal acknowledged';
}
