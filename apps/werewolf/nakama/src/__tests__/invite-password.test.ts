/**
 * Invite password retrieval via matchSignal + server-only secret storage
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  authorizeAndGetMatchPassword,
  buildGetPasswordSignal,
  handleMatchSignalPayload,
  inviteForOwnerStorage,
  inviteMayRetainPasswordSecret,
  inviteSecretCleanupTombstone,
  invitesDroppedByHistoryCap,
  isAtPendingInviteLimit,
  isBenignStorageDeleteError,
  isInviteVisibleInGetInvites,
  INVITE_HISTORY_CAP,
  INVITE_SECRET_PERMISSION_READ,
  INVITE_SECRET_PERMISSION_WRITE,
  legacyInlineInvitePassword,
  parsePasswordFromMatchSignal,
  resolveAcceptInvitePassword,
  shouldBlockCancelForAcceptedReceiver,
  shouldDeleteSecretAfterHistoryCap,
  shouldDeleteSecretAfterSendRollback,
  shouldDeleteSecretAfterTerminalCommit,
  withoutInviteId,
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

  it('get_invites visibility keeps accepted invites only on received lists', () => {
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

    expect(isInviteVisibleInGetInvites(accepted, now, 'received')).toBe(true);
    expect(isInviteVisibleInGetInvites(accepted, now, 'sent')).toBe(false);
    expect(isInviteVisibleInGetInvites({ ...accepted, status: InviteStatus.PENDING }, now, 'sent')).toBe(true);
    expect(isInviteVisibleInGetInvites(declined, now, 'received')).toBe(false);
    expect(isInviteVisibleInGetInvites(expiredAccepted, now, 'received')).toBe(false);
  });

  it('legacyInlineInvitePassword migrates only retryable credentials', () => {
    const now = Date.now();
    const pending: GameInvite = {
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
      expiresAt: now + 60_000,
      password: 'legacy-inline',
    };

    const secretStore: Record<string, { password: string }> = {};
    const captured = legacyInlineInvitePassword(pending, now);
    expect(captured).toBe('legacy-inline');
    if (captured) {
      secretStore[pending.inviteId] = { password: captured };
      pending.isPrivate = true;
    }
    const stored = inviteForOwnerStorage(pending);
    expect(stored.password).toBeUndefined();
    expect(stored.isPrivate).toBe(true);
    expect(secretStore['inv-legacy']).toEqual({ password: 'legacy-inline' });
    expect(legacyInlineInvitePassword(stored, now)).toBeUndefined();

    // Declined / cancelled / expired must not recreate secrets
    expect(
      legacyInlineInvitePassword({ ...pending, status: InviteStatus.DECLINED, password: 'x' }, now)
    ).toBeUndefined();
    expect(
      legacyInlineInvitePassword({ ...pending, status: InviteStatus.CANCELLED, password: 'x' }, now)
    ).toBeUndefined();
    expect(
      legacyInlineInvitePassword({ ...pending, expiresAt: now - 1, password: 'x' }, now)
    ).toBeUndefined();
    expect(inviteMayRetainPasswordSecret({ ...pending, status: InviteStatus.ACCEPTED }, now)).toBe(true);
  });

  it('history cap deletes secrets only when no retryable counterpart remains', () => {
    const now = Date.now();
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
        expiresAt: now + 60_000,
        isPrivate: true,
      });
      secretStore[inviteId] = { password: `pass-${i}` };
    }

    // Accepted invite still on receiver list — do not delete when sender caps it out
    const acceptedDropped: GameInvite = {
      inviteId: 'inv-keep',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-keep',
      receiverName: 'Guest',
      status: InviteStatus.ACCEPTED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: -1,
      expiresAt: now + 60_000,
      isPrivate: true,
    };
    secretStore['inv-keep'] = { password: 'keep-me' };
    const senderList = [acceptedDropped, ...invites];
    const receiverCounterpart: GameInvite[] = [{ ...acceptedDropped }];

    const dropped = invitesDroppedByHistoryCap(senderList);
    expect(dropped[0].inviteId).toBe('inv-keep');
    expect(shouldDeleteSecretAfterHistoryCap(dropped[0], receiverCounterpart, now)).toBe(false);
    expect(shouldDeleteSecretAfterHistoryCap(dropped[0], [], now)).toBe(true);

    for (const invite of dropped) {
      if (shouldDeleteSecretAfterHistoryCap(invite, receiverCounterpart, now)) {
        delete secretStore[invite.inviteId];
      }
    }
    expect(secretStore['inv-keep']).toEqual({ password: 'keep-me' });

    // Non-retryable dropped rows are always safe to delete
    for (const invite of invitesDroppedByHistoryCap(invites)) {
      expect(shouldDeleteSecretAfterHistoryCap(invite, [], now)).toBe(true);
      delete secretStore[invite.inviteId];
    }
    expect(secretStore['inv-0']).toBeUndefined();
    expect(secretStore[`inv-${INVITE_HISTORY_CAP}`]).toEqual({
      password: `pass-${INVITE_HISTORY_CAP}`,
    });
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

  it('expiry cleanup only targets statuses that may retain secrets', () => {
    const secretStore: Record<string, { password: string }> = {
      'inv-expired': { password: 'stale-secret' },
      'inv-declined': { password: 'should-not-touch' },
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
        expiresAt: 1,
        isPrivate: true,
      },
      {
        inviteId: 'inv-declined',
        matchId: 'm2',
        roomName: 'Private',
        senderId: 'host-1',
        senderName: 'Host',
        receiverId: 'guest-2',
        receiverName: 'Guest2',
        status: InviteStatus.DECLINED,
        currentPlayers: 1,
        maxPlayers: 12,
        createdAt: 1,
        expiresAt: 1,
        isPrivate: true,
      },
    ];

    const now = Date.now();
    for (const invite of invites) {
      if (invite.expiresAt < now) {
        if (
          invite.status === InviteStatus.PENDING ||
          invite.status === InviteStatus.ACCEPTED
        ) {
          delete secretStore[invite.inviteId];
          invite.status = InviteStatus.EXPIRED;
        }
      }
    }

    expect(invites[0].status).toBe(InviteStatus.EXPIRED);
    expect(secretStore['inv-expired']).toBeUndefined();
    expect(invites[1].status).toBe(InviteStatus.DECLINED);
    expect(secretStore['inv-declined']).toEqual({ password: 'should-not-touch' });
  });

  it('send rollback deletes secret only after invite rows are removed', () => {
    const secretStore: Record<string, { password: string }> = {
      'inv-rollback': { password: 'keep-or-drop' },
    };
    const senderInvites: GameInvite[] = [
      {
        inviteId: 'inv-rollback',
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
      },
    ];
    const receiverInvites = [...senderInvites];

    // notificationsSend failed after both writes: roll back rows, then secret
    const rolledSender = withoutInviteId(senderInvites, 'inv-rollback');
    const rolledReceiver = withoutInviteId(receiverInvites, 'inv-rollback');
    expect(rolledSender).toEqual([]);
    expect(rolledReceiver).toEqual([]);
    expect(shouldDeleteSecretAfterSendRollback(true, true, true)).toBe(true);
    if (shouldDeleteSecretAfterSendRollback(true, true, true)) {
      delete secretStore['inv-rollback'];
    }
    expect(secretStore['inv-rollback']).toBeUndefined();

    // Incomplete row rollback must retain the secret so accept via polling works
    secretStore['inv-orphan'] = { password: 'still-needed' };
    expect(shouldDeleteSecretAfterSendRollback(true, true, false)).toBe(false);
    expect(shouldDeleteSecretAfterSendRollback(true, false, true)).toBe(false);
    if (shouldDeleteSecretAfterSendRollback(true, true, false)) {
      delete secretStore['inv-orphan'];
    }
    expect(secretStore['inv-orphan']).toEqual({ password: 'still-needed' });
  });

  it('isBenignStorageDeleteError ignores missing objects but not transient failures', () => {
    expect(isBenignStorageDeleteError('storage object not found')).toBe(true);
    expect(isBenignStorageDeleteError(new Error('Not Found'))).toBe(true);
    expect(isBenignStorageDeleteError('does not exist')).toBe(true);
    expect(isBenignStorageDeleteError('temporary storage unavailable')).toBe(false);
    expect(isBenignStorageDeleteError(new Error('connection reset'))).toBe(false);
    expect(isBenignStorageDeleteError('')).toBe(false);
  });

  it('decline/cancel commit terminal status before secret deletion', () => {
    const secretStore: Record<string, { password: string }> = {
      'inv-decline': { password: 'room-pass' },
    };
    const invite: GameInvite = {
      inviteId: 'inv-decline',
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

    expect(
      shouldDeleteSecretAfterTerminalCommit(InviteStatus.PENDING, InviteStatus.DECLINED)
    ).toBe(true);
    expect(
      shouldDeleteSecretAfterTerminalCommit(InviteStatus.PENDING, InviteStatus.CANCELLED)
    ).toBe(true);
    expect(
      shouldDeleteSecretAfterTerminalCommit(InviteStatus.PENDING, InviteStatus.ACCEPTED)
    ).toBe(false);

    // Commit terminal first — even if delete fails, status is durable and cleanup is retryable
    const previousStatus = invite.status;
    invite.status = InviteStatus.DECLINED;
    expect(shouldDeleteSecretAfterTerminalCommit(previousStatus, invite.status)).toBe(true);

    const deleteOnce = (shouldFail: boolean) => {
      if (shouldFail) {
        const err = new Error('temporary storage unavailable');
        if (!isBenignStorageDeleteError(err)) {
          throw err;
        }
      }
      delete secretStore[invite.inviteId];
    };

    expect(() => deleteOnce(true)).toThrow('temporary storage unavailable');
    expect(invite.status).toBe(InviteStatus.DECLINED);
    expect(secretStore['inv-decline']).toEqual({ password: 'room-pass' });

    // get_invites orphan cleanup retries against the terminal private row
    expect(inviteMayRetainPasswordSecret(invite, Date.now())).toBe(false);
    deleteOnce(false);
    expect(secretStore['inv-decline']).toBeUndefined();
  });

  it('send rollback uses snapshots and retains a cleanup tombstone on secret delete failure', () => {
    const secretStore: Record<string, { password: string }> = {
      'inv-orphan': { password: 'left-behind' },
    };
    const priorSender: GameInvite[] = [
      {
        inviteId: 'inv-older',
        matchId: 'm0',
        roomName: 'Other',
        senderId: 'host-1',
        senderName: 'Host',
        receiverId: 'guest-0',
        receiverName: 'Guest0',
        status: InviteStatus.DECLINED,
        currentPlayers: 1,
        maxPlayers: 12,
        createdAt: 1,
        expiresAt: Date.now() + 60_000,
      },
    ];
    const priorReceiver: GameInvite[] = [...priorSender];
    const invite: GameInvite = {
      inviteId: 'inv-orphan',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.PENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 2,
      expiresAt: Date.now() + 60_000,
      isPrivate: true,
    };

    // Snapshot-based rollback restores prior history (never empty-on-read-error wipe)
    const senderSnapshot = priorSender.slice();
    const receiverSnapshot = priorReceiver.slice();
    const senderWritten = [...senderSnapshot, invite];
    const receiverWritten = [...receiverSnapshot, invite];
    expect(senderWritten).toHaveLength(2);
    expect(withoutInviteId(senderWritten, invite.inviteId)).toEqual(senderSnapshot);

    // After both rows rolled back, secret delete fails → keep tombstone for retry
    expect(shouldDeleteSecretAfterSendRollback(true, true, true)).toBe(true);
    const tombstone = inviteSecretCleanupTombstone(invite);
    expect(tombstone.status).toBe(InviteStatus.CANCELLED);
    expect(tombstone.isPrivate).toBe(true);
    expect(tombstone.password).toBeUndefined();
    expect(isInviteVisibleInGetInvites(tombstone, Date.now(), 'sent')).toBe(false);
    expect(inviteMayRetainPasswordSecret(tombstone, Date.now())).toBe(false);

    const senderAfterFailedSecretDelete = [...senderSnapshot, tombstone];
    expect(senderAfterFailedSecretDelete.map((i) => i.inviteId)).toEqual([
      'inv-older',
      'inv-orphan',
    ]);
    // Polling cleanup can still discover the inviteId
    delete secretStore['inv-orphan'];
    expect(secretStore['inv-orphan']).toBeUndefined();
    expect(receiverSnapshot).toHaveLength(1);
  });

  it('cancel consults receiver accepted status before deleting the secret', () => {
    const secretStore: Record<string, { password: string }> = {
      'inv-partial': { password: 'keep-for-join' },
    };
    expect(
      shouldBlockCancelForAcceptedReceiver(InviteStatus.PENDING, InviteStatus.ACCEPTED)
    ).toBe(true);
    expect(
      shouldBlockCancelForAcceptedReceiver(InviteStatus.PENDING, InviteStatus.PENDING)
    ).toBe(false);
    expect(
      shouldBlockCancelForAcceptedReceiver(InviteStatus.PENDING, undefined)
    ).toBe(false);

    // Partial accept: sender still pending, receiver accepted — sync, do not delete
    if (shouldBlockCancelForAcceptedReceiver(InviteStatus.PENDING, InviteStatus.ACCEPTED)) {
      // secret retained for join retry
    } else {
      delete secretStore['inv-partial'];
    }
    expect(secretStore['inv-partial']).toEqual({ password: 'keep-for-join' });
  });
});
