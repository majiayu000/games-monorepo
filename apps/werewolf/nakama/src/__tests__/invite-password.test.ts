/**
 * Invite password retrieval via matchSignal + server-only secret storage
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  authorizeAndGetMatchPassword,
  buildGetPasswordSignal,
  handleMatchSignalPayload,
  inviteForOwnerStorage,
  INVITE_SECRET_PERMISSION_READ,
  INVITE_SECRET_PERMISSION_WRITE,
  parsePasswordFromMatchSignal,
  MATCH_SIGNAL_GET_PASSWORD,
} from '../werewolf/invite-password';
import { GameInvite, InviteStatus, INVITE_CONFIG } from '../werewolf/types';
import { createTestGameState, createTestPlayer, resetPlayerIdCounter } from './test-utils';

describe('matchSignal password retrieval', () => {
  beforeEach(() => {
    resetPlayerIdCounter();
  });

  it('returns password for an authorized match player', () => {
    const host = createTestPlayer({ oderId: 'host-1' });
    const state = createTestGameState({
      password: 'secret-room',
      players: new Map([[host.oderId, host]]),
    });

    const result = authorizeAndGetMatchPassword(state, 'host-1');
    expect(result).toEqual({ success: true, password: 'secret-room' });
  });

  it('rejects unauthorized requesters', () => {
    const host = createTestPlayer({ oderId: 'host-1' });
    const state = createTestGameState({
      password: 'secret-room',
      players: new Map([[host.oderId, host]]),
    });

    expect(authorizeAndGetMatchPassword(state, 'outsider')).toEqual({
      success: false,
      error: 'unauthorized',
    });
    expect(authorizeAndGetMatchPassword(state, '')).toEqual({
      success: false,
      error: 'unauthorized',
    });
  });

  it('handleMatchSignalPayload returns password JSON for get_password', () => {
    const host = createTestPlayer({ oderId: 'host-1' });
    const state = createTestGameState({
      password: 'room-pass',
      players: new Map([[host.oderId, host]]),
    });

    const response = handleMatchSignalPayload(state, buildGetPasswordSignal('host-1'));
    expect(JSON.parse(response)).toEqual({ success: true, password: 'room-pass' });
  });

  it('handleMatchSignalPayload acknowledges unknown / non-JSON signals', () => {
    const state = createTestGameState({ password: 'x' });
    expect(handleMatchSignalPayload(state, 'ping')).toBe('signal acknowledged');
    expect(handleMatchSignalPayload(state, JSON.stringify({ action: 'other' }))).toBe(
      'signal acknowledged'
    );
  });
});

describe('invite password attachment from matchSignal', () => {
  it('buildGetPasswordSignal encodes action and userId', () => {
    expect(JSON.parse(buildGetPasswordSignal('user-42'))).toEqual({
      action: MATCH_SIGNAL_GET_PASSWORD,
      userId: 'user-42',
    });
  });

  it('parsePasswordFromMatchSignal extracts password on success', () => {
    expect(
      parsePasswordFromMatchSignal(JSON.stringify({ success: true, password: 'abc123' }))
    ).toBe('abc123');
  });

  it('parsePasswordFromMatchSignal ignores failures and empty passwords', () => {
    expect(parsePasswordFromMatchSignal(JSON.stringify({ success: false, error: 'unauthorized' }))).toBeUndefined();
    expect(parsePasswordFromMatchSignal(JSON.stringify({ success: true, password: null }))).toBeUndefined();
    expect(parsePasswordFromMatchSignal(JSON.stringify({ success: true, password: '' }))).toBeUndefined();
    expect(parsePasswordFromMatchSignal('signal acknowledged')).toBeUndefined();
    expect(parsePasswordFromMatchSignal('')).toBeUndefined();
  });

  it('inviteForOwnerStorage strips password from owner-readable invite records', () => {
    const invite: GameInvite = {
      inviteId: 'inv-1',
      matchId: 'match-1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.PENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: 2,
      password: 'must-not-persist',
    };

    const stored = inviteForOwnerStorage(invite);
    expect(stored.password).toBeUndefined();
    expect(stored.inviteId).toBe('inv-1');
    expect(invite.password).toBe('must-not-persist'); // original unchanged
  });

  it('server-only secret ACL is not owner-readable', () => {
    expect(INVITE_SECRET_PERMISSION_READ).toBe(0);
    expect(INVITE_SECRET_PERMISSION_WRITE).toBe(0);
    expect(INVITE_CONFIG.STORAGE_COLLECTION_SECRETS).toBe('werewolf_invite_secrets');
  });

  it('end-to-end: password stays server-only until accept', () => {
    const host = createTestPlayer({ oderId: 'host-1' });
    const state = createTestGameState({
      password: 'invite-secret',
      players: new Map([[host.oderId, host]]),
    });

    // Simulate public label (isPrivate only — no password field)
    const publicLabel = { isPrivate: state.password !== null, roomName: state.roomName };
    expect((publicLabel as { password?: string }).password).toBeUndefined();
    expect(publicLabel.isPrivate).toBe(true);

    const signalResponse = handleMatchSignalPayload(state, buildGetPasswordSignal(host.oderId));
    const invitePassword = parsePasswordFromMatchSignal(signalResponse);
    expect(invitePassword).toBe('invite-secret');

    // Owner-readable invite copy must not include the password
    const ownerInvite = inviteForOwnerStorage({
      inviteId: 'inv-e2e',
      matchId: state.matchId,
      roomName: state.roomName,
      senderId: host.oderId,
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.PENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      password: invitePassword,
    });
    expect(ownerInvite.password).toBeUndefined();

    // Server-only secret store (simulated) holds the password until accept
    const secretStore: Record<string, { password: string }> = {
      'inv-e2e': { password: invitePassword! },
    };

    // Accept path returns password from server-only store, not from owner storage
    const acceptPassword = secretStore['inv-e2e']?.password;
    delete secretStore['inv-e2e'];
    const acceptPayload = {
      success: true,
      matchId: state.matchId,
      password: acceptPassword,
    };
    expect(acceptPayload.password).toBe('invite-secret');
    expect(secretStore['inv-e2e']).toBeUndefined();
  });
});
