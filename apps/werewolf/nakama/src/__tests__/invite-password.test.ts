/**
 * Invite password retrieval via matchSignal + server-only secret storage
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  authorizeAndGetMatchPassword,
  buildGetPasswordSignal,
  handleMatchSignalPayload,
  inviteForOwnerStorage,
  invitesDroppedByHistoryCap,
  isAtPendingInviteLimit,
  isInviteVisibleInGetInvites,
  INVITE_HISTORY_CAP,
  INVITE_SECRET_PERMISSION_READ,
  INVITE_SECRET_PERMISSION_WRITE,
  legacyInlineInvitePassword,
  parsePasswordFromMatchSignal,
  resolveAcceptInvitePassword,
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
      isPrivate: true,
      password: invitePassword,
    });
    expect(ownerInvite.password).toBeUndefined();
    expect(ownerInvite.isPrivate).toBe(true);

    // Server-only secret store (simulated) holds the password until accept
    const secretStore: Record<string, { password: string }> = {
      'inv-e2e': { password: invitePassword! },
    };

    // Accept path returns password from server-only store, not from owner storage
    const acceptResolved = resolveAcceptInvitePassword(
      ownerInvite.isPrivate,
      secretStore['inv-e2e']?.password
    );
    expect(acceptResolved.ok).toBe(true);
    if (acceptResolved.ok) {
      // Secret is retained after accept so join retries can re-fetch until expiry
      const acceptPayload = {
        success: true,
        matchId: state.matchId,
        password: acceptResolved.password,
      };
      expect(acceptPayload.password).toBe('invite-secret');
      expect(secretStore['inv-e2e']).toEqual({ password: 'invite-secret' });

      const retryResolved = resolveAcceptInvitePassword(
        ownerInvite.isPrivate,
        secretStore['inv-e2e']?.password
      );
      expect(retryResolved).toEqual({ ok: true, password: 'invite-secret' });
    }
  });

  it('resolveAcceptInvitePassword requires secret for private invites', () => {
    expect(resolveAcceptInvitePassword(true, undefined)).toEqual({
      ok: false,
      error: 'Private room password unavailable',
    });
    expect(resolveAcceptInvitePassword(true, '')).toEqual({
      ok: false,
      error: 'Private room password unavailable',
    });
    expect(resolveAcceptInvitePassword(true, 'room-pass')).toEqual({
      ok: true,
      password: 'room-pass',
    });
  });

  it('resolveAcceptInvitePassword allows public invites without a secret', () => {
    expect(resolveAcceptInvitePassword(false, undefined)).toEqual({ ok: true, password: undefined });
    expect(resolveAcceptInvitePassword(undefined, undefined)).toEqual({
      ok: true,
      password: undefined,
    });
  });

  it('resolveAcceptInvitePassword migrates legacy inline password without isPrivate', () => {
    // Pending invite from previous server: password inline, no isPrivate, no secret row
    expect(resolveAcceptInvitePassword(undefined, undefined, 'legacy-pass')).toEqual({
      ok: true,
      password: 'legacy-pass',
    });
    // Explicit private prefers secret, falls back to legacy
    expect(resolveAcceptInvitePassword(true, undefined, 'legacy-pass')).toEqual({
      ok: true,
      password: 'legacy-pass',
    });
    expect(resolveAcceptInvitePassword(true, 'secret-pass', 'legacy-pass')).toEqual({
      ok: true,
      password: 'secret-pass',
    });
  });

  it('accepted secret is retained for join retry until expiry cleanup', () => {
    const secretStore: Record<string, { password: string }> = {
      'inv-accepted': { password: 'join-me' },
    };
    const invite: GameInvite = {
      inviteId: 'inv-accepted',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.ACCEPTED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      isPrivate: true,
    };

    // Re-fetch after failed join
    const retry = resolveAcceptInvitePassword(
      invite.isPrivate,
      secretStore[invite.inviteId]?.password
    );
    expect(retry).toEqual({ ok: true, password: 'join-me' });
    expect(secretStore['inv-accepted']).toEqual({ password: 'join-me' });

    // Expiry cleanup drops the retained accepted secret
    invite.expiresAt = 1;
    const now = Date.now();
    if (invite.expiresAt < now) {
      delete secretStore[invite.inviteId];
    }
    expect(secretStore['inv-accepted']).toBeUndefined();
  });

  it('expire path drops server-only secrets so they do not accumulate', () => {
    const secretStore: Record<string, { password: string }> = {
      'inv-expired': { password: 'stale-secret' },
      'inv-pending': { password: 'live-secret' },
    };
    const invites: GameInvite[] = [
      {
        inviteId: 'inv-expired',
        matchId: 'm1',
        roomName: 'Private',
        senderId: 'host-1',
        senderName: 'Host',
        receiverId: 'guest-1',
        receiverName: 'Guest',
        status: InviteStatus.PENDING,
        currentPlayers: 1,
        maxPlayers: 12,
        createdAt: 1,
        expiresAt: 1, // already expired
        isPrivate: true,
      },
      {
        inviteId: 'inv-pending',
        matchId: 'm2',
        roomName: 'Private',
        senderId: 'host-1',
        senderName: 'Host',
        receiverId: 'guest-2',
        receiverName: 'Guest2',
        status: InviteStatus.PENDING,
        currentPlayers: 1,
        maxPlayers: 12,
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
        isPrivate: true,
      },
    ];

    const now = Date.now();
    for (const invite of invites) {
      if (invite.status === InviteStatus.PENDING && invite.expiresAt < now) {
        invite.status = InviteStatus.EXPIRED;
        delete secretStore[invite.inviteId];
      }
    }

    expect(invites[0].status).toBe(InviteStatus.EXPIRED);
    expect(secretStore['inv-expired']).toBeUndefined();
    expect(secretStore['inv-pending']).toEqual({ password: 'live-secret' });
  });

  it('missing private secret leaves invite pending (retryable)', () => {
    const invite: GameInvite = {
      inviteId: 'inv-race',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.PENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      isPrivate: true,
    };
    const secretStore: Record<string, { password: string }> = {}; // concurrent cancel wiped it

    const resolved = resolveAcceptInvitePassword(invite.isPrivate, secretStore[invite.inviteId]?.password);
    expect(resolved.ok).toBe(false);
    // Status must remain pending so the client can retry after secret is restored
    expect(invite.status).toBe(InviteStatus.PENDING);
  });

  it('get_invites visibility keeps unexpired accepted invites for join retries', () => {
    const now = Date.now();
    const accepted: GameInvite = {
      inviteId: 'inv-accepted',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.ACCEPTED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now + 60_000,
      isPrivate: true,
    };
    const declined: GameInvite = { ...accepted, inviteId: 'inv-declined', status: InviteStatus.DECLINED };
    const expiredAccepted: GameInvite = {
      ...accepted,
      inviteId: 'inv-expired',
      expiresAt: now - 1,
    };

    expect(isInviteVisibleInGetInvites(accepted, now)).toBe(true);
    expect(isInviteVisibleInGetInvites({ ...accepted, status: InviteStatus.PENDING }, now)).toBe(true);
    expect(isInviteVisibleInGetInvites(declined, now)).toBe(false);
    expect(isInviteVisibleInGetInvites(expiredAccepted, now)).toBe(false);
  });

  it('legacyInlineInvitePassword captures credentials before owner-storage strip', () => {
    const legacy: GameInvite = {
      inviteId: 'inv-legacy',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.PENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
      password: 'legacy-inline',
    };

    const secretStore: Record<string, { password: string }> = {};
    const captured = legacyInlineInvitePassword(legacy);
    expect(captured).toBe('legacy-inline');
    if (captured) {
      secretStore[legacy.inviteId] = { password: captured };
      legacy.isPrivate = true;
    }
    const stored = inviteForOwnerStorage(legacy);
    expect(stored.password).toBeUndefined();
    expect(stored.isPrivate).toBe(true);
    expect(secretStore['inv-legacy']).toEqual({ password: 'legacy-inline' });
    expect(legacyInlineInvitePassword(stored)).toBeUndefined();
  });

  it('history cap identifies dropped invites so secrets can be deleted', () => {
    const secretStore: Record<string, { password: string }> = {};
    const invites: GameInvite[] = [];
    for (let i = 0; i < INVITE_HISTORY_CAP + 3; i++) {
      const inviteId = `inv-${i}`;
      invites.push({
        inviteId,
        matchId: 'm1',
        roomName: 'Private',
        senderId: 'host-1',
        senderName: 'Host',
        receiverId: `guest-${i}`,
        receiverName: 'Guest',
        status: InviteStatus.DECLINED,
        currentPlayers: 1,
        maxPlayers: 12,
        createdAt: i,
        expiresAt: Date.now() + 60_000,
        isPrivate: true,
      });
      secretStore[inviteId] = { password: `pass-${i}` };
    }

    const dropped = invitesDroppedByHistoryCap(invites);
    expect(dropped).toHaveLength(3);
    expect(dropped.map((i) => i.inviteId)).toEqual(['inv-0', 'inv-1', 'inv-2']);
    for (const invite of dropped) {
      delete secretStore[invite.inviteId];
    }
    expect(secretStore['inv-0']).toBeUndefined();
    expect(secretStore['inv-2']).toBeUndefined();
    expect(secretStore[`inv-${INVITE_HISTORY_CAP}`]).toEqual({
      password: `pass-${INVITE_HISTORY_CAP}`,
    });
    expect(invites.slice(-INVITE_HISTORY_CAP)).toHaveLength(INVITE_HISTORY_CAP);
  });

  it('pending invite limit blocks further sends before secrets accumulate', () => {
    const now = Date.now();
    const invites: GameInvite[] = Array.from({ length: INVITE_CONFIG.MAX_PENDING }, (_, i) => ({
      inviteId: `inv-p-${i}`,
      matchId: 'm1',
      roomName: 'Room',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: `guest-${i}`,
      receiverName: 'Guest',
      status: InviteStatus.PENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now + 60_000,
    }));
    expect(isAtPendingInviteLimit(invites, now)).toBe(true);
    expect(isAtPendingInviteLimit(invites.slice(0, -1), now)).toBe(false);
  });
});
