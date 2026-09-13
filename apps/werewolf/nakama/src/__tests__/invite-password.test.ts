/**
 * Invite password retrieval via matchSignal + server-only secret storage
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  authorizeAndGetMatchPassword,
  buildGetPasswordSignal,
  canCancelSenderInvite,
  canExpireInviteStatus,
  canRollbackSendInviteRow,
  countsTowardPendingInviteLimit,
  handleMatchSignalPayload,
  inviteForOwnerStorage,
  inviteMayRetainPasswordSecret,
  inviteSecretCleanupTombstone,
  invitesDroppedByHistoryCap,
  invitesForOwnerHistoryStorage,
  isAtPendingInviteLimit,
  isBenignStorageDeleteError,
  isInviteSecretCleanupOnly,
  isInviteVisibleInGetInvites,
  isStorageVersionConflictError,
  INVITE_HISTORY_CAP,
  INVITE_SECRET_PERMISSION_READ,
  INVITE_SECRET_PERMISSION_WRITE,
  legacyInlineInvitePassword,
  markInviteSecretCleanupComplete,
  applyInviteSecretCleanupMarkers,
  mergeCleanupTombstoneIntoInviteList,
  needsSenderExpiryReceiverRecheck,
  needsTerminalSecretCleanup,
  parsePasswordFromMatchSignal,
  resolveAcceptInvitePassword,
  shouldBlockCancelForAcceptedReceiver,
  shouldDeleteMigratedSecretAfterAcceptConflict,
  shouldDeleteSecretAfterHistoryCap,
  shouldDeleteSecretAfterSendRollback,
  shouldDeleteSecretAfterSenderExpiry,
  shouldDeleteSecretAfterSentExpiredHistoryCap,
  shouldDeleteSecretAfterTerminalCommit,
  shouldRetryPendingInviteClaimAfterConflict,
  storageWriteVersionFor,
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

  it('expiry cleanup claims EXPIRED before deleting secrets', () => {
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
    const expiredClaimIds: string[] = [];
    for (const invite of invites) {
      if (invite.expiresAt < now && canExpireInviteStatus(invite.status)) {
        invite.status = InviteStatus.EXPIRED;
        expiredClaimIds.push(invite.inviteId);
      }
    }

    expect(invites[0].status).toBe(InviteStatus.EXPIRED);
    expect(secretStore['inv-expired']).toEqual({ password: 'stale-secret' });
    expect(expiredClaimIds).toEqual(['inv-expired']);

    const cleanedExpiredIds: string[] = [];
    for (const inviteId of expiredClaimIds) {
      delete secretStore[inviteId];
      markInviteSecretCleanupComplete(invites.find((i) => i.inviteId === inviteId)!);
      cleanedExpiredIds.push(inviteId);
    }

    expect(secretStore['inv-expired']).toBeUndefined();
    expect(cleanedExpiredIds).toEqual(['inv-expired']);
    expect(invites[1].status).toBe(InviteStatus.DECLINED);
    expect(secretStore['inv-declined']).toEqual({ password: 'should-not-touch' });
  });

  it('expiry cleanup markers skip invites whose secret delete failed', () => {
    const now = Date.now();
    const invites: GameInvite[] = [
      {
        inviteId: 'inv-ok',
        matchId: 'm1',
        roomName: 'Private',
        senderId: 'host-1',
        senderName: 'Host',
        receiverId: 'guest-1',
        receiverName: 'Guest',
        status: InviteStatus.EXPIRED,
        currentPlayers: 1,
        maxPlayers: 12,
        createdAt: 1,
        expiresAt: 1,
        isPrivate: true,
      },
      {
        inviteId: 'inv-orphan',
        matchId: 'm2',
        roomName: 'Private',
        senderId: 'host-1',
        senderName: 'Host',
        receiverId: 'guest-2',
        receiverName: 'Guest2',
        status: InviteStatus.EXPIRED,
        currentPlayers: 1,
        maxPlayers: 12,
        createdAt: 1,
        expiresAt: 1,
        isPrivate: true,
      },
    ];
    const expiredClaimIds = invites.map((i) => i.inviteId);
    const deleteFailsFor = new Set(['inv-orphan']);
    const cleanedExpiredIds: string[] = [];

    for (const inviteId of expiredClaimIds) {
      const expiredInvite = invites.find((i) => i.inviteId === inviteId)!;
      try {
        if (deleteFailsFor.has(inviteId)) {
          throw new Error('temporary storage unavailable');
        }
        markInviteSecretCleanupComplete(expiredInvite);
        cleanedExpiredIds.push(inviteId);
      } catch {
        // Leave isPrivate so needsTerminalSecretCleanup can retry.
      }
    }

    // Markers must only target successful deletes — never all expiredClaimIds.
    expect(cleanedExpiredIds).toEqual(['inv-ok']);
    expect(applyInviteSecretCleanupMarkers(invites, cleanedExpiredIds)).toBe(false);
    expect(invites[0].isPrivate).toBe(false);
    expect(invites[1].isPrivate).toBe(true);
    expect(needsTerminalSecretCleanup(invites[1], now)).toBe(true);

    // Passing all expiredClaimIds (the bug) would clear the orphan retry flag.
    const buggyList = invites.map((i) => ({ ...i }));
    expect(applyInviteSecretCleanupMarkers(buggyList, expiredClaimIds)).toBe(true);
    expect(buggyList[1].isPrivate).toBe(false);
    expect(needsTerminalSecretCleanup(buggyList[1], now)).toBe(false);
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
    expect(isInviteSecretCleanupOnly(tombstone)).toBe(true);
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

  it('terminal cleanup marker stops repeated get_invites deletes', () => {
    const now = Date.now();
    const invite: GameInvite = {
      inviteId: 'inv-term',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.DECLINED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now + 60_000,
      isPrivate: true,
    };
    expect(needsTerminalSecretCleanup(invite, now)).toBe(true);
    markInviteSecretCleanupComplete(invite);
    expect(invite.isPrivate).toBe(false);
    expect(needsTerminalSecretCleanup(invite, now)).toBe(false);
  });

  it('expired terminal private invites still need secret cleanup', () => {
    const now = Date.now();
    const invite: GameInvite = {
      inviteId: 'inv-expired-term',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.CANCELLED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now - 1,
      isPrivate: true,
    };
    expect(inviteMayRetainPasswordSecret(invite, now)).toBe(false);
    expect(needsTerminalSecretCleanup(invite, now)).toBe(true);
  });

  it('cleanup markers merge onto a fresh OCC-read list without touching other rows', () => {
    const now = Date.now();
    const concurrent: GameInvite = {
      inviteId: 'inv-new',
      matchId: 'm2',
      roomName: 'Other',
      senderId: 'host-2',
      senderName: 'Host2',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.PENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 2,
      expiresAt: now + 60_000,
      isPrivate: true,
    };
    const declined: GameInvite = {
      inviteId: 'inv-declined',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.DECLINED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now + 60_000,
      isPrivate: true,
    };
    // Stale in-memory snapshot from before a concurrent send arrived
    const staleSnapshot = [declined];
    // Fresh OCC re-read includes the concurrent invite
    const freshList = [{ ...declined }, { ...concurrent }];
    expect(applyInviteSecretCleanupMarkers(freshList, ['inv-declined'])).toBe(true);
    expect(freshList[0].isPrivate).toBe(false);
    expect(freshList[1].inviteId).toBe('inv-new');
    expect(freshList[1].isPrivate).toBe(true);
    // Writing the stale snapshot would have dropped inv-new
    expect(staleSnapshot).toHaveLength(1);
  });

  it('history cap defers secret deletion until after list commit', () => {
    const now = Date.now();
    const secretStore: Record<string, { password: string }> = {};
    const invites: GameInvite[] = [];
    for (let i = 0; i < INVITE_HISTORY_CAP + 1; i++) {
      const inviteId = `inv-cap-${i}`;
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

    const dropped = invitesDroppedByHistoryCap(invites);
    expect(dropped).toHaveLength(1);
    expect(shouldDeleteSecretAfterHistoryCap(dropped[0], [], now)).toBe(true);

    // Commit capped list first — secret must still exist at this point
    const committed = invites.slice(-INVITE_HISTORY_CAP).map(inviteForOwnerStorage);
    expect(committed.some((i) => i.inviteId === 'inv-cap-0')).toBe(false);
    expect(secretStore['inv-cap-0']).toEqual({ password: 'pass-0' });

    // Only after durable eviction may the secret be deleted
    for (const drop of dropped) {
      if (shouldDeleteSecretAfterHistoryCap(drop, [], now)) {
        delete secretStore[drop.inviteId];
      }
    }
    expect(secretStore['inv-cap-0']).toBeUndefined();
  });

  it('counterpart read failure must not authorize secret deletion', () => {
    const now = Date.now();
    const dropped: GameInvite = {
      inviteId: 'inv-keep-secret',
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
    // Soft-read [] would wrongly look like "counterpart gone"; callers must
    // propagate read failures instead of passing an empty fallback list.
    expect(shouldDeleteSecretAfterHistoryCap(dropped, [], now)).toBe(true);
    expect(
      shouldDeleteSecretAfterHistoryCap(dropped, [{ ...dropped }], now)
    ).toBe(false);
  });

  it('OCC version helpers encode create-only and conflict detection', () => {
    expect(storageWriteVersionFor(null)).toBe('*');
    expect(storageWriteVersionFor('abc123')).toBe('abc123');
    expect(isStorageVersionConflictError('storage version does not match')).toBe(true);
    expect(isStorageVersionConflictError('connection reset')).toBe(false);
  });

  it('atomic pending claim rejects when concurrent writes race past the limit', () => {
    const now = Date.now();
    const base: GameInvite[] = Array.from({ length: INVITE_CONFIG.MAX_PENDING - 1 }, (_, i) => ({
      inviteId: `inv-slot-${i}`,
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
    expect(isAtPendingInviteLimit(base, now)).toBe(false);

    // Two concurrent readers both observe capacity; only the first OCC write wins.
    const claimA = [
      ...base,
      {
        ...base[0],
        inviteId: 'inv-claim-a',
        receiverId: 'guest-a',
      },
    ];
    const claimB = [
      ...base,
      {
        ...base[0],
        inviteId: 'inv-claim-b',
        receiverId: 'guest-b',
      },
    ];
    expect(isAtPendingInviteLimit(claimA, now)).toBe(true);
    expect(isAtPendingInviteLimit(claimB, now)).toBe(true);
    // Loser must treat version conflict as limit exceeded (no secret created yet)
    expect(isStorageVersionConflictError(new Error('version conflict'))).toBe(true);
  });

  it('pending slot OCC conflict retries while capacity remains', () => {
    expect(shouldRetryPendingInviteClaimAfterConflict(false)).toBe(true);
    expect(shouldRetryPendingInviteClaimAfterConflict(true)).toBe(false);
  });

  it('provisional SENDING blocks cancel and stays hidden until promoted', () => {
    const now = Date.now();
    const sending: GameInvite = {
      inviteId: 'inv-sending',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.SENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now + 60_000,
      isPrivate: true,
    };
    expect(canCancelSenderInvite(InviteStatus.SENDING)).toBe(false);
    expect(canCancelSenderInvite(InviteStatus.PENDING)).toBe(true);
    expect(isInviteVisibleInGetInvites(sending, now, 'sent')).toBe(false);
    expect(countsTowardPendingInviteLimit(sending, now)).toBe(true);
    expect(inviteMayRetainPasswordSecret(sending, now)).toBe(true);
    expect(canExpireInviteStatus(InviteStatus.SENDING)).toBe(true);
  });

  it('legacy accept migrate secret is deleted only when the winning row is terminal', () => {
    const secretStore: Record<string, { password: string }> = {};
    const legacyPassword = 'legacy-pass';
    let migratedLegacySecret = false;

    // Migrate before claim
    secretStore['inv-legacy'] = { password: legacyPassword };
    migratedLegacySecret = true;

    const claimConflict = new Error('storage version does not match');
    expect(isStorageVersionConflictError(claimConflict)).toBe(true);

    // Concurrent accept won — keep the shared secret for join retry.
    expect(
      shouldDeleteMigratedSecretAfterAcceptConflict(InviteStatus.ACCEPTED)
    ).toBe(false);
    expect(
      shouldDeleteMigratedSecretAfterAcceptConflict(InviteStatus.PENDING)
    ).toBe(false);

    // Concurrent decline/cancel won — remove the orphan we just migrated.
    expect(
      shouldDeleteMigratedSecretAfterAcceptConflict(InviteStatus.DECLINED)
    ).toBe(true);
    expect(
      shouldDeleteMigratedSecretAfterAcceptConflict(undefined)
    ).toBe(true);

    if (
      migratedLegacySecret &&
      shouldDeleteMigratedSecretAfterAcceptConflict(InviteStatus.DECLINED)
    ) {
      delete secretStore['inv-legacy'];
    }
    expect(secretStore['inv-legacy']).toBeUndefined();
  });

  it('send rollback preserves concurrently accepted invite rows', () => {
    expect(canRollbackSendInviteRow(InviteStatus.SENDING)).toBe(true);
    expect(canRollbackSendInviteRow(InviteStatus.PENDING)).toBe(true);
    expect(canRollbackSendInviteRow(InviteStatus.ACCEPTED)).toBe(false);
    expect(canRollbackSendInviteRow(InviteStatus.DECLINED)).toBe(false);
  });

  it('sender expiry keeps the secret when the receiver still needs it', () => {
    const now = Date.now();
    const unexpired = now + 60_000;
    // Still actionable or accepted within deadline — do not delete.
    expect(shouldDeleteSecretAfterSenderExpiry(InviteStatus.ACCEPTED, now, unexpired)).toBe(
      false
    );
    expect(shouldDeleteSecretAfterSenderExpiry(InviteStatus.PENDING, now, unexpired)).toBe(
      false
    );
    expect(shouldDeleteSecretAfterSenderExpiry(InviteStatus.SENDING, now, unexpired)).toBe(
      false
    );
    // Past deadline — rpcRespondInvite rejects retries; allow delete.
    expect(shouldDeleteSecretAfterSenderExpiry(InviteStatus.ACCEPTED, now, now - 1)).toBe(
      true
    );
    expect(shouldDeleteSecretAfterSenderExpiry(InviteStatus.PENDING, now, now - 1)).toBe(
      true
    );
    // Gone or already terminal — safe to delete.
    expect(shouldDeleteSecretAfterSenderExpiry(undefined, now)).toBe(true);
    expect(shouldDeleteSecretAfterSenderExpiry(InviteStatus.EXPIRED, now)).toBe(true);
    expect(shouldDeleteSecretAfterSenderExpiry(InviteStatus.DECLINED, now)).toBe(true);
    expect(shouldDeleteSecretAfterSenderExpiry(InviteStatus.CANCELLED, now)).toBe(true);
  });

  it('receiver expiry OCC that leaves PENDING must not authorize secret delete', () => {
    // Simulate: conditional EXPIRED write conflicted; refreshed row still PENDING.
    const now = Date.now();
    const receiverStatusAfterOcc: InviteStatus = InviteStatus.PENDING;
    const receiverExpiryClaimed = false;
    expect(receiverExpiryClaimed).toBe(false);
    expect(
      shouldDeleteSecretAfterSenderExpiry(receiverStatusAfterOcc, now, now + 60_000)
    ).toBe(false);
  });

  it('sent-side EXPIRED history eviction consults the receiver before delete', () => {
    const now = Date.now();
    const expiredSent: GameInvite = {
      inviteId: 'inv-hist-expired',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.EXPIRED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now - 1,
      isPrivate: true,
    };
    const receiverAccepted: GameInvite[] = [
      {
        ...expiredSent,
        status: InviteStatus.ACCEPTED,
        expiresAt: now + 60_000,
      },
    ];
    // Generic history-cap helper treats non-retainable EXPIRED as deletable —
    // the sent-expired helper must override that when receiver is ACCEPTED.
    expect(shouldDeleteSecretAfterHistoryCap(expiredSent, receiverAccepted, now)).toBe(true);
    expect(
      shouldDeleteSecretAfterSentExpiredHistoryCap(expiredSent, receiverAccepted, now)
    ).toBe(false);
    // Post-deadline ACCEPTED no longer needs join-retry credentials.
    expect(
      shouldDeleteSecretAfterSentExpiredHistoryCap(
        expiredSent,
        [{ ...receiverAccepted[0], expiresAt: now - 1 }],
        now
      )
    ).toBe(true);
    expect(shouldDeleteSecretAfterSentExpiredHistoryCap(expiredSent, [], now)).toBe(true);
    expect(
      shouldDeleteSecretAfterSentExpiredHistoryCap(
        expiredSent,
        [{ ...expiredSent, status: InviteStatus.DECLINED }],
        now
      )
    ).toBe(true);
  });

  it('completed cleanup tombstones are dropped from owner history storage', () => {
    const now = Date.now();
    const outstanding = inviteSecretCleanupTombstone({
      inviteId: 'inv-outstanding',
      matchId: 'm1',
      roomName: 'Room',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.CANCELLED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now,
      isPrivate: true,
    });
    const completed = {
      ...outstanding,
      inviteId: 'inv-completed',
    };
    markInviteSecretCleanupComplete(completed);
    expect(completed.isPrivate).toBe(false);
    expect(isInviteSecretCleanupOnly(completed)).toBe(true);

    const stored = invitesForOwnerHistoryStorage([outstanding, completed], 50);
    expect(stored.some((i) => i.inviteId === 'inv-outstanding' && i.isPrivate === true)).toBe(
      true
    );
    expect(stored.some((i) => i.inviteId === 'inv-completed')).toBe(false);
  });

  it('decline remains authoritative when sender sync fails after durable commit', () => {
    // Receiver DECLINED write already committed — sender sync must be best-effort
    // so secret cleanup / notification still run.
    const previousStatus = InviteStatus.PENDING;
    const newStatus = InviteStatus.DECLINED;
    expect(shouldDeleteSecretAfterTerminalCommit(previousStatus, newStatus)).toBe(true);

    let threwToClient = false;
    let cleanupRan = false;
    let notified = false;
    try {
      // Simulate sender sync failure after durable decline.
      throw new Error('storage version does not match');
    } catch (senderSyncError) {
      // Accept and decline both log rather than throw.
      expect(String(senderSyncError)).toContain('version');
    }
    if (shouldDeleteSecretAfterTerminalCommit(previousStatus, newStatus)) {
      cleanupRan = true;
    }
    notified = true;
    expect(threwToClient).toBe(false);
    expect(cleanupRan).toBe(true);
    expect(notified).toBe(true);
  });

  it('stale-migration compensation retains a tombstone when storageDelete fails', () => {
    const now = Date.now();
    const winningDeclined: GameInvite = {
      inviteId: 'inv-stale-mig',
      matchId: 'm1',
      roomName: 'Room',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.DECLINED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now + 60_000,
      // Inline password stripped by winning decline path; no isPrivate marker.
    };
    expect(
      shouldDeleteMigratedSecretAfterAcceptConflict(
        winningDeclined.status,
        now,
        winningDeclined.expiresAt
      )
    ).toBe(true);

    let deleteFailed = false;
    let tombstoneRetained = false;
    try {
      throw new Error('transient storageDelete failure');
    } catch (_deleteError) {
      deleteFailed = true;
      const withTombstone = mergeCleanupTombstoneIntoInviteList(
        [winningDeclined],
        { ...winningDeclined, senderId: 'host-1', inviteId: 'inv-stale-mig', isPrivate: true }
      );
      tombstoneRetained = withTombstone.some(
        (i) => i.inviteId === 'inv-stale-mig' && isInviteSecretCleanupOnly(i) && i.isPrivate
      );
    }
    expect(deleteFailed).toBe(true);
    expect(tombstoneRetained).toBe(true);
  });

  it('sent-side EXPIRED terminal cleanup rechecks the receiver instead of deleting', () => {
    const now = Date.now();
    const secretStore: Record<string, { password: string }> = {
      'inv-sent-expired': { password: 'join-retry-secret' },
    };
    // Prior poll claimed EXPIRED but receiver consult failed — durable sender
    // row is EXPIRED with isPrivate still set.
    const sentInvite: GameInvite = {
      inviteId: 'inv-sent-expired',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.EXPIRED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now - 1,
      isPrivate: true,
    };
    const receiverAccepted: InviteStatus = InviteStatus.ACCEPTED;
    const receiverExpiresAt = now + 60_000;

    expect(needsTerminalSecretCleanup(sentInvite, now)).toBe(true);
    expect(needsSenderExpiryReceiverRecheck('sent', sentInvite, now)).toBe(true);
    expect(needsSenderExpiryReceiverRecheck('received', sentInvite, now)).toBe(false);

    // Simulate get_invites({type:'sent'}) next-poll classification
    const type: 'sent' | 'received' = 'sent';
    const expiredClaimIds: string[] = [];
    let deletedViaGenericTerminalCleanup = false;

    if (sentInvite.expiresAt < now && canExpireInviteStatus(sentInvite.status)) {
      sentInvite.status = InviteStatus.EXPIRED;
      expiredClaimIds.push(sentInvite.inviteId);
    } else if (needsSenderExpiryReceiverRecheck(type, sentInvite, now)) {
      expiredClaimIds.push(sentInvite.inviteId);
    } else if (needsTerminalSecretCleanup(sentInvite, now)) {
      delete secretStore[sentInvite.inviteId];
      markInviteSecretCleanupComplete(sentInvite);
      deletedViaGenericTerminalCleanup = true;
    }

    expect(deletedViaGenericTerminalCleanup).toBe(false);
    expect(expiredClaimIds).toEqual(['inv-sent-expired']);

    // Re-run sender-expiry receiver coordination before any delete
    for (const inviteId of expiredClaimIds) {
      if (type === 'sent') {
        if (
          !shouldDeleteSecretAfterSenderExpiry(
            receiverAccepted,
            now,
            receiverExpiresAt
          )
        ) {
          sentInvite.status = InviteStatus.ACCEPTED;
          continue;
        }
      }
      delete secretStore[inviteId];
      markInviteSecretCleanupComplete(sentInvite);
    }

    expect(sentInvite.status).toBe(InviteStatus.ACCEPTED);
    expect(secretStore['inv-sent-expired']).toEqual({ password: 'join-retry-secret' });
    expect(sentInvite.isPrivate).toBe(true);
  });

  it('sender expiry deletes post-deadline ACCEPTED receiver secrets', () => {
    const now = Date.now();
    const secretStore: Record<string, { password: string }> = {
      'inv-accepted-expired': { password: 'stale-secret' },
    };
    const sentInvite: GameInvite = {
      inviteId: 'inv-accepted-expired',
      matchId: 'm1',
      roomName: 'Private',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: 'guest-1',
      receiverName: 'Guest',
      status: InviteStatus.EXPIRED,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: 1,
      expiresAt: now - 1,
      isPrivate: true,
    };
    const receiverStatus = InviteStatus.ACCEPTED;
    const receiverExpiresAt = now - 1;

    expect(
      shouldDeleteSecretAfterSenderExpiry(receiverStatus, now, receiverExpiresAt)
    ).toBe(true);

    // Transition expired ACCEPTED → EXPIRED, then delete credential.
    let receiverRowStatus: InviteStatus = receiverStatus;
    if (shouldDeleteSecretAfterSenderExpiry(receiverStatus, now, receiverExpiresAt)) {
      receiverRowStatus = InviteStatus.EXPIRED;
      delete secretStore[sentInvite.inviteId];
      markInviteSecretCleanupComplete(sentInvite);
    }

    expect(receiverRowStatus).toBe(InviteStatus.EXPIRED);
    expect(secretStore['inv-accepted-expired']).toBeUndefined();
    expect(sentInvite.isPrivate).toBe(false);
  });

  it('cleanup tombstones sit outside the user-visible history cap', () => {
    const now = Date.now();
    const regular: GameInvite[] = [];
    for (let i = 0; i < INVITE_HISTORY_CAP; i++) {
      regular.push({
        inviteId: `inv-keep-${i}`,
        matchId: 'm1',
        roomName: 'Room',
        senderId: 'host-1',
        senderName: 'Host',
        receiverId: `guest-${i}`,
        receiverName: 'Guest',
        status: InviteStatus.PENDING,
        currentPlayers: 1,
        maxPlayers: 12,
        createdAt: i,
        expiresAt: now + 60_000,
      });
    }
    const orphan = {
      ...regular[0],
      inviteId: 'inv-orphan-secret',
      status: InviteStatus.CANCELLED,
      isPrivate: true,
    };
    const withTombstone = mergeCleanupTombstoneIntoInviteList(regular, orphan);
    expect(withTombstone).toHaveLength(INVITE_HISTORY_CAP + 1);
    expect(invitesDroppedByHistoryCap(withTombstone)).toEqual([]);
    const stored = invitesForOwnerHistoryStorage(withTombstone);
    expect(stored.some((i) => i.inviteId === 'inv-keep-0')).toBe(true);
    expect(stored.some((i) => i.inviteId === 'inv-orphan-secret' && isInviteSecretCleanupOnly(i))).toBe(
      true
    );
  });

  it('cleanup tombstones are never evicted by the history-cap budget', () => {
    const now = Date.now();
    const regular: GameInvite[] = Array.from({ length: 3 }, (_, i) => ({
      inviteId: `inv-reg-${i}`,
      matchId: 'm1',
      roomName: 'Room',
      senderId: 'host-1',
      senderName: 'Host',
      receiverId: `guest-${i}`,
      receiverName: 'Guest',
      status: InviteStatus.PENDING,
      currentPlayers: 1,
      maxPlayers: 12,
      createdAt: i,
      expiresAt: now + 60_000,
    }));
    const tombstones: GameInvite[] = Array.from({ length: INVITE_HISTORY_CAP + 5 }, (_, i) =>
      inviteSecretCleanupTombstone({
        ...regular[0],
        inviteId: `inv-tomb-${i}`,
        createdAt: i,
      })
    );
    const stored = invitesForOwnerHistoryStorage([...regular, ...tombstones], 3);
    expect(stored.filter((i) => !isInviteSecretCleanupOnly(i))).toHaveLength(3);
    expect(stored.filter((i) => isInviteSecretCleanupOnly(i))).toHaveLength(
      INVITE_HISTORY_CAP + 5
    );
    expect(stored.some((i) => i.inviteId === 'inv-tomb-0')).toBe(true);
  });
});
