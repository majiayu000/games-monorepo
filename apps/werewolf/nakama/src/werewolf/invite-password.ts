/**
 * Private-room invite password helpers.
 * Password stays out of the public match label; authorized match players
 * retrieve it via matchSignal when sending invites. The secret is then kept
 * in server-only storage (never owner-readable invite records) until accept.
 */

import { GameInvite, GameState, InviteStatus, INVITE_CONFIG } from './types';

export const MATCH_SIGNAL_GET_PASSWORD = 'get_password';

/** Nakama storage ACL: no client reads (server RPCs only). */
export const INVITE_SECRET_PERMISSION_READ = 0;
/** Nakama storage ACL: no client writes (server RPCs only). */
export const INVITE_SECRET_PERMISSION_WRITE = 0;

/** Max invites retained in owner-readable history lists. */
export const INVITE_HISTORY_CAP = 50;

/**
 * Strip password before writing invites to owner-readable storage.
 */
export function inviteForOwnerStorage(invite: GameInvite): GameInvite {
  const { password: _omit, ...rest } = invite;
  return rest;
}

/** Rows kept only so get_invites can retry orphan secret deletes. */
export function isInviteSecretCleanupOnly(invite: GameInvite): boolean {
  return invite.secretCleanupOnly === true;
}

/**
 * Invites that may still need their server-only password secret
 * (provisional send, pending accept, or accepted join retry before expiry).
 */
export function inviteMayRetainPasswordSecret(invite: GameInvite, now: number): boolean {
  if (invite.expiresAt < now) {
    return false;
  }
  return (
    invite.status === InviteStatus.SENDING ||
    invite.status === InviteStatus.PENDING ||
    invite.status === InviteStatus.ACCEPTED
  );
}

/**
 * Invites the client may list via get_invites.
 * Pending shows in both lists. Unexpired accepted is receiver-only so join
 * retries keep an inviteId without giving senders a broken Cancel UX.
 * Provisional SENDING rows stay hidden until the receiver commit promotes them.
 */
export function isInviteVisibleInGetInvites(
  invite: GameInvite,
  now: number,
  listType: 'sent' | 'received' = 'received'
): boolean {
  if (isInviteSecretCleanupOnly(invite)) {
    return false;
  }
  if (invite.expiresAt < now) {
    return false;
  }
  if (invite.status === InviteStatus.PENDING) {
    return true;
  }
  if (invite.status === InviteStatus.ACCEPTED) {
    return listType === 'received';
  }
  return false;
}

/** Statuses that still count against MAX_PENDING while unexpired. */
export function countsTowardPendingInviteLimit(
  invite: GameInvite,
  now: number
): boolean {
  return (
    invite.expiresAt >= now &&
    (invite.status === InviteStatus.SENDING ||
      invite.status === InviteStatus.PENDING)
  );
}

/** Sender cancel is only valid after the invite is fully published as PENDING. */
export function canCancelSenderInvite(status: InviteStatus): boolean {
  return status === InviteStatus.PENDING;
}

/** Expiry may claim these live statuses before deleting credentials. */
export function canExpireInviteStatus(status: InviteStatus): boolean {
  return (
    status === InviteStatus.SENDING ||
    status === InviteStatus.PENDING ||
    status === InviteStatus.ACCEPTED
  );
}

/**
 * Legacy private invites store the password inline. Capture it so callers can
 * migrate to server-only storage before inviteForOwnerStorage strips it.
 * Only retryable (unexpired pending/accepted) credentials are migrated —
 * declined/cancelled/expired must not recreate orphan secrets.
 */
export function legacyInlineInvitePassword(
  invite: GameInvite,
  now: number = Date.now()
): string | undefined {
  if (!inviteMayRetainPasswordSecret(invite, now)) {
    return undefined;
  }
  if (typeof invite.password === 'string' && invite.password.length > 0) {
    return invite.password;
  }
  return undefined;
}

/**
 * Invites dropped when a list is capped to the last `limit` entries.
 * Cleanup-only tombstones are excluded from the user-visible history budget.
 * Callers should delete secrets only when no retryable counterpart remains.
 */
export function invitesDroppedByHistoryCap(
  invites: GameInvite[],
  limit: number = INVITE_HISTORY_CAP
): GameInvite[] {
  const regular = invites.filter((invite) => !isInviteSecretCleanupOnly(invite));
  if (regular.length <= limit) {
    return [];
  }
  return regular.slice(0, regular.length - limit);
}

/**
 * Persist owner-readable history: cap regular rows, keep every outstanding
 * cleanup tombstone outside that budget so unresolved secret deletes are never
 * silently dropped when more than `limit` orphans accumulate.
 */
export function invitesForOwnerHistoryStorage(
  invites: GameInvite[],
  limit: number = INVITE_HISTORY_CAP
): GameInvite[] {
  const regular = invites.filter((invite) => !isInviteSecretCleanupOnly(invite));
  const cleanup = invites.filter((invite) => isInviteSecretCleanupOnly(invite));
  return [...regular.slice(-limit), ...cleanup].map(inviteForOwnerStorage);
}

/**
 * Upsert a cleanup tombstone without relying on an unversioned full-list restore.
 */
export function mergeCleanupTombstoneIntoInviteList(
  invites: GameInvite[],
  tombstoneSource: GameInvite
): GameInvite[] {
  const tombstone = inviteSecretCleanupTombstone(tombstoneSource);
  return [
    ...invites.filter((invite) => invite.inviteId !== tombstone.inviteId),
    tombstone,
  ];
}

/**
 * Whether a history-capped row's secret is safe to delete.
 * If the dropped invite is still retryable, keep the secret unless the
 * counterpart list also lacks a retryable copy of the same inviteId.
 */
export function shouldDeleteSecretAfterHistoryCap(
  dropped: GameInvite,
  counterpartInvites: GameInvite[],
  now: number
): boolean {
  if (!inviteMayRetainPasswordSecret(dropped, now)) {
    return true;
  }
  return !counterpartInvites.some(
    (other) =>
      other.inviteId === dropped.inviteId &&
      inviteMayRetainPasswordSecret(other, now)
  );
}

export function countPendingInvites(invites: GameInvite[], now: number): number {
  return invites.filter((invite) => countsTowardPendingInviteLimit(invite, now)).length;
}

export function isAtPendingInviteLimit(
  invites: GameInvite[],
  now: number,
  maxPending: number = INVITE_CONFIG.MAX_PENDING
): boolean {
  return countPendingInvites(invites, now) >= maxPending;
}

/**
 * Remove a single invite from an in-memory list (send-failure rollback).
 */
export function withoutInviteId(invites: GameInvite[], inviteId: string): GameInvite[] {
  return invites.filter((invite) => invite.inviteId !== inviteId);
}

/**
 * Send-failure rollback may only remove the provisional row this send created.
 * A concurrent accept that already committed ACCEPTED (or any terminal row)
 * must be preserved so join retries keep their inviteId + secret.
 */
export function canRollbackSendInviteRow(status: InviteStatus): boolean {
  return (
    status === InviteStatus.SENDING ||
    status === InviteStatus.PENDING
  );
}

/**
 * After a legacy migrate + OCC accept conflict, delete the migrated secret only
 * when the winning durable row no longer needs credentials for join retry.
 */
export function shouldDeleteMigratedSecretAfterAcceptConflict(
  winningStatus: InviteStatus | undefined,
  now: number = Date.now(),
  expiresAt?: number
): boolean {
  if (winningStatus === undefined) {
    // Row gone (cancel/decline cleanup) — migrated secret would orphan.
    return true;
  }
  if (typeof expiresAt === 'number' && expiresAt < now) {
    return true;
  }
  return (
    winningStatus !== InviteStatus.SENDING &&
    winningStatus !== InviteStatus.PENDING &&
    winningStatus !== InviteStatus.ACCEPTED
  );
}

/**
 * Sender-side expiry must not wipe credentials while the receiver already
 * accepted on its independent storage object.
 */
export function shouldDeleteSecretAfterSenderExpiry(
  receiverStatus: InviteStatus | undefined
): boolean {
  return receiverStatus !== InviteStatus.ACCEPTED;
}

/**
 * Pending-slot OCC conflicts are not proof the list is full — retry while the
 * refreshed sender list still has capacity.
 */
export function shouldRetryPendingInviteClaimAfterConflict(
  refreshedListIsFull: boolean
): boolean {
  return !refreshedListIsFull;
}

/**
 * Versioned invite list read result. `version` is null when the storage
 * object does not exist yet (first write should use create-only OCC).
 */
export interface InviteListRecord {
  invites: GameInvite[];
  version: string | null;
}

/**
 * Nakama OCC: missing object → create-only (`*`); otherwise exact version.
 */
export function storageWriteVersionFor(expectedVersion: string | null): string {
  return expectedVersion === null ? '*' : expectedVersion;
}

/**
 * Terminal private rows that still need orphan secret cleanup retries.
 */
export function needsTerminalSecretCleanup(invite: GameInvite, now: number): boolean {
  return invite.isPrivate === true && !inviteMayRetainPasswordSecret(invite, now);
}

/**
 * After a successful secret delete, clear the private marker so get_invites
 * polling does not re-issue storageDelete on every refresh.
 */
export function markInviteSecretCleanupComplete(invite: GameInvite): void {
  invite.isPrivate = false;
  invite.password = undefined;
}

/**
 * Apply cleanup markers onto a freshly read invite list (OCC-safe merge).
 * Returns true when at least one row still needed marking.
 */
export function applyInviteSecretCleanupMarkers(
  invites: GameInvite[],
  inviteIds: ReadonlyArray<string>
): boolean {
  const idSet = new Set(inviteIds);
  let changed = false;
  for (const invite of invites) {
    if (!idSet.has(invite.inviteId)) {
      continue;
    }
    if (invite.isPrivate === true || invite.password !== undefined) {
      markInviteSecretCleanupComplete(invite);
      changed = true;
    }
  }
  return changed;
}

/**
 * Whether a storageDelete failure is safe to ignore (object already absent).
 * Transient / unknown errors must be propagated so callers can retry.
 */
export function isBenignStorageDeleteError(error: unknown): boolean {
  const message = String(error ?? '').toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes('not found') ||
    message.includes('not_found') ||
    message.includes('does not exist') ||
    message.includes('no storage object') ||
    message.includes('storage object not found')
  );
}

/**
 * Nakama conditional write / version mismatch failures.
 */
export function isStorageVersionConflictError(error: unknown): boolean {
  const message = String(error ?? '').toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes('version') ||
    message.includes('concurrent') ||
    message.includes('occ') ||
    message.includes('conflict') ||
    message.includes('does not match') ||
    message.includes('precondition')
  );
}

/**
 * After send persistence fails, delete the password secret only when no
 * invite row remains that could still be accepted via polling.
 */
export function shouldDeleteSecretAfterSendRollback(
  secretWritten: boolean,
  senderInviteRolledBack: boolean,
  receiverInviteRolledBack: boolean
): boolean {
  return secretWritten && senderInviteRolledBack && receiverInviteRolledBack;
}

/**
 * When send-rollback / history-cap secret deletion fails after the invite row
 * is gone, keep a terminal private tombstone so get_invites can retry cleanup.
 * Marked secretCleanupOnly so history capping cannot evict live invites.
 */
export function inviteSecretCleanupTombstone(invite: GameInvite): GameInvite {
  return inviteForOwnerStorage({
    ...invite,
    status: InviteStatus.CANCELLED,
    isPrivate: true,
    password: undefined,
    secretCleanupOnly: true,
  });
}

/**
 * Sender cancel must not wipe a password while the receiver already accepted
 * (partial accept left the sender copy pending).
 */
export function shouldBlockCancelForAcceptedReceiver(
  senderStatus: InviteStatus,
  receiverStatus: InviteStatus | undefined
): boolean {
  return (
    senderStatus === InviteStatus.PENDING &&
    receiverStatus === InviteStatus.ACCEPTED
  );
}

/**
 * Terminal decline/cancel: commit durable status first, then delete the secret.
 * Transient delete failures stay retryable via get_invites orphan cleanup.
 */
export function shouldDeleteSecretAfterTerminalCommit(
  previousStatus: InviteStatus,
  nextStatus: InviteStatus
): boolean {
  if (previousStatus !== InviteStatus.PENDING) {
    return false;
  }
  return (
    nextStatus === InviteStatus.DECLINED ||
    nextStatus === InviteStatus.CANCELLED
  );
}

/**
 * Accept path: private invites must resolve a non-empty password before the
 * invite may be committed as ACCEPTED.
 *
 * Prefer the server-only secret store. Fall back to a legacy inline
 * `invite.password` for pending records created before the secret migration
 * (those lack `isPrivate` and a secret row).
 */
export function resolveAcceptInvitePassword(
  isPrivate: boolean | undefined,
  secretPassword: string | undefined,
  legacyPassword?: string | undefined
): { ok: true; password?: string } | { ok: false; error: string } {
  const fromSecret =
    typeof secretPassword === 'string' && secretPassword.length > 0
      ? secretPassword
      : undefined;
  const fromLegacy =
    typeof legacyPassword === 'string' && legacyPassword.length > 0
      ? legacyPassword
      : undefined;
  const password = fromSecret ?? fromLegacy;

  // Explicit private flag, or legacy private invite (password inline, no isPrivate).
  const effectivelyPrivate = isPrivate === true || (!!fromLegacy && isPrivate !== false);

  if (effectivelyPrivate) {
    if (!password) {
      return { ok: false, error: 'Private room password unavailable' };
    }
    return { ok: true, password };
  }
  return { ok: true, password: fromSecret };
}

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
