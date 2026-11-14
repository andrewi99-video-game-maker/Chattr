import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CallLogItem,
  CallStatus,
  CallType,
  ChatMessage,
  FriendItem,
  FriendRequestItem,
  PublicUser,
  SearchUserItem,
} from '../src/types.ts';

const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'relay.db');
export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('wal_autocheckpoint = 100');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    avatar_color TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(requester_id, addressee_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    reply_to_id TEXT NULL,
    reactions_json TEXT NOT NULL DEFAULT '{}',
    kind TEXT NOT NULL DEFAULT 'text',
    read_at INTEGER NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_pair_time
    ON messages(sender_id, recipient_id, created_at);

  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    caller_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    callee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    call_type TEXT NOT NULL CHECK (call_type IN ('voice', 'video')),
    status TEXT NOT NULL CHECK (status IN ('ringing', 'active', 'ended', 'missed', 'declined')),
    started_at INTEGER NOT NULL,
    answered_at INTEGER NULL,
    ended_at INTEGER NULL,
    duration_sec INTEGER NOT NULL DEFAULT 0
  );
`);

try {
  db.exec(`ALTER TABLE messages ADD COLUMN edited_at INTEGER NULL`);
} catch {
  // Column already exists
}

try {
  db.exec(`ALTER TABLE users ADD COLUMN firebase_uid TEXT`);
} catch {
  // Column already exists
}

try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid) WHERE firebase_uid IS NOT NULL`);
} catch {
  // ignore
}

try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(LOWER(username))`);
} catch {
  // Ignore if legacy rows conflict; query checks still enforce case-insensitive uniqueness
}

export function checkpointDb(): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // ignore
  }
}

export function closeDb(): void {
  checkpointDb();
  try {
    db.close();
  } catch {
    // ignore
  }
}

export const USERNAME_REGEX = /^[a-z0-9_.-]{3,24}$/;

export function normalizeUsername(input: string): string {
  return input.trim().replace(/^@+/, '').toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_REGEX.test(username);
}

export const AVATAR_COLORS = [
  '#7895B2', // Dusty Blue
  '#5E7C99', // Muted Steel
  '#6B8E9B', // Slate Teal
  '#4E6780', // Deep Dusty Blue
  '#8C9BA8', // Cool Grey Blue
  '#3B5166', // Midnight Slate
  '#283747', // Dark Slate
];

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 2) return false;
  const [salt, originalHash] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const originalBuf = Buffer.from(originalHash, 'hex');
  if (derived.length !== originalBuf.length) return false;
  return crypto.timingSafeEqual(derived, originalBuf);
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash?: string;
  firebase_uid?: string | null;
  bio: string;
  avatar_color: string;
  created_at: number;
}

export function mapUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarColor: row.avatar_color,
    createdAt: row.created_at,
  };
}

export function createUser(usernameInput: string, password: string, displayNameInput?: string): PublicUser {
  const username = normalizeUsername(usernameInput);
  const displayName = (displayNameInput || '').trim() || username;
  const id = crypto.randomUUID();
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const now = Date.now();
  const passwordHash = hashPassword(password);

  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, firebase_uid, bio, avatar_color, created_at)
     VALUES (?, ?, ?, ?, NULL, '', ?, ?)`
  ).run(id, username, displayName, passwordHash, color, now);

  return {
    id,
    username,
    displayName,
    bio: '',
    avatarColor: color,
    createdAt: now,
  };
}

export function findUserByFirebaseUid(firebaseUid: string): PublicUser | null {
  const row = db
    .prepare(`SELECT id, username, display_name, bio, avatar_color, created_at FROM users WHERE firebase_uid = ?`)
    .get(firebaseUid) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export function createFirebaseUser(params: {
  firebaseUid: string;
  username: string;
  displayName?: string;
  bio?: string;
  avatarColor?: string;
}): PublicUser {
  const username = normalizeUsername(params.username);
  const displayName = (params.displayName || '').trim().slice(0, 40) || username;
  const bio = (params.bio || '').trim().slice(0, 140);
  const color =
    params.avatarColor && AVATAR_COLORS.includes(params.avatarColor)
      ? params.avatarColor
      : AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const now = Date.now();
  const id = params.firebaseUid;

  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, firebase_uid, bio, avatar_color, created_at)
     VALUES (?, ?, ?, 'oauth:firebase', ?, ?, ?, ?)`
  ).run(id, username, displayName, params.firebaseUid, bio, color, now);

  return {
    id,
    username,
    displayName,
    bio,
    avatarColor: color,
    createdAt: now,
  };
}

export function findUserByUsername(username: string): (PublicUser & { passwordHash: string }) | null {
  const clean = normalizeUsername(username);
  if (!clean) return null;
  const row = db
    .prepare(`SELECT * FROM users WHERE LOWER(username) = ?`)
    .get(clean) as UserRow | undefined;
  if (!row || !row.password_hash) return null;
  return {
    ...mapUser(row),
    passwordHash: row.password_hash,
  };
}

export function isUsernameAvailable(username: string, excludeUserId?: string): boolean {
  const clean = normalizeUsername(username);
  if (!isValidUsername(clean)) return false;
  const row = excludeUserId
    ? (db.prepare(`SELECT id FROM users WHERE LOWER(username) = ? AND id != ?`).get(clean, excludeUserId) as
        | { id: string }
        | undefined)
    : (db.prepare(`SELECT id FROM users WHERE LOWER(username) = ?`).get(clean) as { id: string } | undefined);
  return !row;
}

export function getUserById(id: string): PublicUser | null {
  const row = db
    .prepare(`SELECT id, username, display_name, bio, avatar_color, created_at FROM users WHERE id = ?`)
    .get(id) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export function updateUserProfile(
  userId: string,
  updates: { username?: string; displayName?: string; bio?: string; avatarColor?: string }
): { user: PublicUser | null; error?: string; status?: number } {
  const existing = getUserById(userId);
  if (!existing) return { user: null, error: 'User not found', status: 404 };

  let nextUsername = existing.username;
  if (typeof updates.username === 'string') {
    const clean = normalizeUsername(updates.username);
    if (!isValidUsername(clean)) {
      return {
        user: null,
        error: 'Username must be 3–24 characters using letters, numbers, underscores, dots, or hyphens.',
        status: 400,
      };
    }
    if (clean !== existing.username.toLowerCase() && !isUsernameAvailable(clean, userId)) {
      return { user: null, error: 'That username is already taken.', status: 409 };
    }
    nextUsername = clean;
  }

  const displayName =
    typeof updates.displayName === 'string' && updates.displayName.trim().length > 0
      ? updates.displayName.trim().slice(0, 40)
      : existing.displayName;
  const bio = typeof updates.bio === 'string' ? updates.bio.trim().slice(0, 140) : existing.bio;
  const avatarColor =
    typeof updates.avatarColor === 'string' && AVATAR_COLORS.includes(updates.avatarColor)
      ? updates.avatarColor
      : existing.avatarColor;

  try {
    db.prepare(`UPDATE users SET username = ?, display_name = ?, bio = ?, avatar_color = ? WHERE id = ?`).run(
      nextUsername,
      displayName,
      bio,
      avatarColor,
      userId
    );
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
    ) {
      return { user: null, error: 'That username is already taken.', status: 409 };
    }
    throw err;
  }

  return { user: getUserById(userId) };
}

export function updateUserPassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): { ok: boolean; error?: string; status?: number } {
  const row = db
    .prepare(`SELECT password_hash FROM users WHERE id = ?`)
    .get(userId) as { password_hash: string } | undefined;
  if (!row) return { ok: false, error: 'User not found', status: 404 };
  if (row.password_hash === 'oauth:firebase') {
    return { ok: false, error: 'This account uses Google Sign-In instead of a password.', status: 400 };
  }
  if (!verifyPassword(currentPassword, row.password_hash)) {
    return { ok: false, error: 'Current password is incorrect.', status: 401 };
  }
  if (newPassword.length < 4 || newPassword.length > 128) {
    return { ok: false, error: 'New password must be between 4 and 128 characters.', status: 400 };
  }
  const nextHash = hashPassword(newPassword);
  db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(nextHash, userId);
  return { ok: true };
}

export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)`).run(token, userId, Date.now());
  return token;
}

export function getUserBySessionToken(token: string): PublicUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.bio, u.avatar_color, u.created_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

export function deleteSession(token: string): void {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

interface FriendshipRow {
  id: string;
  requester_id: string;
  addressee_id: string;
  status: 'pending' | 'accepted';
  created_at: number;
  updated_at: number;
}

export function getFriendshipBetween(userA: string, userB: string): FriendshipRow | null {
  const row = db
    .prepare(
      `SELECT * FROM friendships
       WHERE (requester_id = ? AND addressee_id = ?)
          OR (requester_id = ? AND addressee_id = ?)`
    )
    .get(userA, userB, userB, userA) as FriendshipRow | undefined;
  return row || null;
}

export function areFriends(userA: string, userB: string): boolean {
  const row = db
    .prepare(
      `SELECT id FROM friendships
       WHERE status = 'accepted'
         AND ((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))`
    )
    .get(userA, userB, userB, userA);
  return Boolean(row);
}

export function getFriendIds(userId: string): string[] {
  const rows = db
    .prepare(
      `SELECT requester_id, addressee_id FROM friendships
       WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`
    )
    .all(userId, userId) as { requester_id: string; addressee_id: string }[];
  return rows.map((r) => (r.requester_id === userId ? r.addressee_id : r.requester_id));
}

export function searchUsers(
  currentUserId: string,
  query: string,
  onlineUserIds?: Set<string>
): SearchUserItem[] {
  const trimmed = normalizeUsername(query);
  const rawTrimmed = query.trim().toLowerCase();
  let rows: UserRow[];
  if (trimmed.length === 0 && rawTrimmed.length === 0) {
    rows = db
      .prepare(
        `SELECT id, username, display_name, bio, avatar_color, created_at
         FROM users
         WHERE id != ?
         ORDER BY created_at DESC
         LIMIT 30`
      )
      .all(currentUserId) as UserRow[];
  } else {
    const userPattern = `%${trimmed || rawTrimmed}%`;
    const namePattern = `%${rawTrimmed}%`;
    rows = db
      .prepare(
        `SELECT id, username, display_name, bio, avatar_color, created_at
         FROM users
         WHERE id != ? AND (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?)
         ORDER BY CASE WHEN LOWER(username) = ? THEN 0 ELSE 1 END, username ASC
         LIMIT 30`
      )
      .all(currentUserId, userPattern, namePattern, trimmed) as UserRow[];
  }

  return rows.map((row) => {
    const rel = getFriendshipBetween(currentUserId, row.id);
    let relationship: SearchUserItem['relationship'] = 'none';
    if (rel) {
      if (rel.status === 'accepted') {
        relationship = 'friends';
      } else if (rel.requester_id === currentUserId) {
        relationship = 'outgoing_pending';
      } else {
        relationship = 'incoming_pending';
      }
    }
    return {
      ...mapUser(row),
      online: onlineUserIds ? onlineUserIds.has(row.id) : false,
      relationship,
      friendshipId: rel ? rel.id : null,
    };
  });
}

interface MessageRow {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  reply_to_id: string | null;
  reactions_json: string;
  kind: 'text' | 'call_event';
  read_at: number | null;
  edited_at: number | null;
  created_at: number;
}

function hydrateMessage(row: MessageRow): ChatMessage {
  let reactions: Record<string, string[]> = {};
  try {
    reactions = JSON.parse(row.reactions_json || '{}') as Record<string, string[]>;
  } catch {
    reactions = {};
  }

  let replyTo: ChatMessage['replyTo'] = null;
  if (row.reply_to_id) {
    const parent = db
      .prepare(`SELECT id, sender_id, body FROM messages WHERE id = ?`)
      .get(row.reply_to_id) as { id: string; sender_id: string; body: string } | undefined;
    if (parent) {
      replyTo = {
        id: parent.id,
        senderId: parent.sender_id,
        body: parent.body,
      };
    }
  }

  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    body: row.body,
    replyToId: row.reply_to_id,
    replyTo,
    reactions,
    kind: row.kind,
    readAt: row.read_at,
    editedAt: row.edited_at ?? null,
    createdAt: row.created_at,
  };
}

export function getFriendsOverview(
  userId: string,
  onlineUserIds: Set<string>,
  inCallUserIds: Set<string>
): {
  friends: FriendItem[];
  incomingRequests: FriendRequestItem[];
  outgoingRequests: FriendRequestItem[];
} {
  const acceptedRows = db
    .prepare(
      `SELECT f.id as friendship_id, u.id, u.username, u.display_name, u.bio, u.avatar_color, u.created_at
       FROM friendships f
       JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
       WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?)`
    )
    .all(userId, userId, userId) as (UserRow & { friendship_id: string })[];

  const friends: FriendItem[] = acceptedRows.map((row) => {
    const lastRow = db
      .prepare(
        `SELECT * FROM messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(userId, row.id, row.id, userId) as MessageRow | undefined;

    const unreadRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages
         WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`
      )
      .get(row.id, userId) as { cnt: number };

    return {
      ...mapUser(row),
      friendshipId: row.friendship_id,
      online: onlineUserIds.has(row.id),
      inCall: inCallUserIds.has(row.id),
      unreadCount: unreadRow?.cnt || 0,
      lastMessage: lastRow ? hydrateMessage(lastRow) : null,
    };
  });

  friends.sort((a, b) => {
    const aTime = a.lastMessage?.createdAt ?? a.createdAt;
    const bTime = b.lastMessage?.createdAt ?? b.createdAt;
    return bTime - aTime;
  });

  const incomingRows = db
    .prepare(
      `SELECT f.id as friendship_id, f.created_at as req_created_at,
              u.id, u.username, u.display_name, u.bio, u.avatar_color, u.created_at
       FROM friendships f
       JOIN users u ON u.id = f.requester_id
       WHERE f.status = 'pending' AND f.addressee_id = ?
       ORDER BY f.created_at DESC`
    )
    .all(userId) as (UserRow & { friendship_id: string; req_created_at: number })[];

  const outgoingRows = db
    .prepare(
      `SELECT f.id as friendship_id, f.created_at as req_created_at,
              u.id, u.username, u.display_name, u.bio, u.avatar_color, u.created_at
       FROM friendships f
       JOIN users u ON u.id = f.addressee_id
       WHERE f.status = 'pending' AND f.requester_id = ?
       ORDER BY f.created_at DESC`
    )
    .all(userId) as (UserRow & { friendship_id: string; req_created_at: number })[];

  return {
    friends,
    incomingRequests: incomingRows.map((r) => ({
      friendshipId: r.friendship_id,
      user: { ...mapUser(r), online: onlineUserIds.has(r.id) },
      createdAt: r.req_created_at,
    })),
    outgoingRequests: outgoingRows.map((r) => ({
      friendshipId: r.friendship_id,
      user: { ...mapUser(r), online: onlineUserIds.has(r.id) },
      createdAt: r.req_created_at,
    })),
  };
}

export function getConversationMessages(userA: string, userB: string, limit = 150): ChatMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY created_at DESC
         LIMIT ?
       ) sub ORDER BY created_at ASC`
    )
    .all(userA, userB, userB, userA, limit) as MessageRow[];
  return rows.map(hydrateMessage);
}

export function markMessagesRead(readerId: string, senderId: string): number {
  const now = Date.now();
  const res = db
    .prepare(`UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`)
    .run(now, senderId, readerId);
  return res.changes;
}

export function insertMessage(params: {
  senderId: string;
  recipientId: string;
  body: string;
  replyToId?: string | null;
  kind?: 'text' | 'call_event';
}): ChatMessage {
  const id = crypto.randomUUID();
  const now = Date.now();
  const kind = params.kind || 'text';
  const replyToId = params.replyToId || null;

  db.prepare(
    `INSERT INTO messages (id, sender_id, recipient_id, body, reply_to_id, reactions_json, kind, read_at, created_at)
     VALUES (?, ?, ?, ?, ?, '{}', ?, NULL, ?)`
  ).run(id, params.senderId, params.recipientId, params.body, replyToId, kind, now);

  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow;
  return hydrateMessage(row);
}

export function toggleMessageReaction(messageId: string, userId: string, emoji: string): ChatMessage | null {
  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow | undefined;
  if (!row) return null;
  if (row.sender_id !== userId && row.recipient_id !== userId) return null;

  let reactions: Record<string, string[]> = {};
  try {
    reactions = JSON.parse(row.reactions_json || '{}') as Record<string, string[]>;
  } catch {
    reactions = {};
  }

  const currentUsers = Array.isArray(reactions[emoji]) ? reactions[emoji] : [];
  if (currentUsers.includes(userId)) {
    const next = currentUsers.filter((id) => id !== userId);
    if (next.length === 0) {
      delete reactions[emoji];
    } else {
      reactions[emoji] = next;
    }
  } else {
    reactions[emoji] = [...currentUsers, userId];
  }

  db.prepare(`UPDATE messages SET reactions_json = ? WHERE id = ?`).run(JSON.stringify(reactions), messageId);
  const updated = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow;
  return hydrateMessage(updated);
}

export function editMessageBySender(messageId: string, userId: string, newBody: string): ChatMessage | null {
  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow | undefined;
  if (!row || row.sender_id !== userId || row.kind !== 'text') return null;
  const now = Date.now();
  db.prepare(`UPDATE messages SET body = ?, edited_at = ? WHERE id = ?`).run(newBody, now, messageId);
  const updated = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow;
  return hydrateMessage(updated);
}

export function deleteMessageBySender(messageId: string, userId: string): { recipientId: string } | null {
  const row = db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId) as MessageRow | undefined;
  if (!row || row.sender_id !== userId) return null;
  db.prepare(`DELETE FROM messages WHERE id = ?`).run(messageId);
  return { recipientId: row.recipient_id };
}

export function createCallRecord(params: {
  id: string;
  callerId: string;
  calleeId: string;
  callType: CallType;
  status?: CallStatus;
}): void {
  db.prepare(
    `INSERT INTO calls (id, caller_id, callee_id, call_type, status, started_at, answered_at, ended_at, duration_sec)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0)`
  ).run(params.id, params.callerId, params.calleeId, params.callType, params.status || 'ringing', Date.now());
}

export function getCallRecord(callId: string): {
  id: string;
  caller_id: string;
  callee_id: string;
  call_type: CallType;
  status: CallStatus;
  started_at: number;
  answered_at: number | null;
  ended_at: number | null;
  duration_sec: number;
} | null {
  const row = db.prepare(`SELECT * FROM calls WHERE id = ?`).get(callId) as
    | {
        id: string;
        caller_id: string;
        callee_id: string;
        call_type: CallType;
        status: CallStatus;
        started_at: number;
        answered_at: number | null;
        ended_at: number | null;
        duration_sec: number;
      }
    | undefined;
  return row || null;
}

export function markCallAnswered(callId: string): void {
  db.prepare(`UPDATE calls SET status = 'active', answered_at = ? WHERE id = ? AND status = 'ringing'`).run(
    Date.now(),
    callId
  );
}

export function finishCallRecord(
  callId: string,
  overrideStatus?: 'missed' | 'declined' | 'ended'
): { status: CallStatus; durationSec: number; callType: CallType; callerId: string; calleeId: string } | null {
  const existing = getCallRecord(callId);
  if (!existing) return null;
  if (existing.status === 'ended' || existing.status === 'missed' || existing.status === 'declined') {
    return null;
  }

  const now = Date.now();
  let finalStatus: CallStatus = overrideStatus || 'ended';
  if (!overrideStatus) {
    finalStatus = existing.answered_at ? 'ended' : 'missed';
  }
  const durationSec =
    finalStatus === 'ended' && existing.answered_at
      ? Math.max(1, Math.round((now - existing.answered_at) / 1000))
      : 0;

  db.prepare(`UPDATE calls SET status = ?, ended_at = ?, duration_sec = ? WHERE id = ?`).run(
    finalStatus,
    now,
    durationSec,
    callId
  );

  return {
    status: finalStatus,
    durationSec,
    callType: existing.call_type,
    callerId: existing.caller_id,
    calleeId: existing.callee_id,
  };
}

export function getUserCallHistory(userId: string): CallLogItem[] {
  const rows = db
    .prepare(
      `SELECT c.*, u.id as peer_id, u.username, u.display_name, u.bio, u.avatar_color, u.created_at as user_created_at
       FROM calls c
       JOIN users u ON u.id = CASE WHEN c.caller_id = ? THEN c.callee_id ELSE c.caller_id END
       WHERE c.caller_id = ? OR c.callee_id = ?
       ORDER BY c.started_at DESC
       LIMIT 60`
    )
    .all(userId, userId, userId) as {
    id: string;
    caller_id: string;
    callee_id: string;
    call_type: CallType;
    status: CallStatus;
    started_at: number;
    answered_at: number | null;
    ended_at: number | null;
    duration_sec: number;
    peer_id: string;
    username: string;
    display_name: string;
    bio: string;
    avatar_color: string;
    user_created_at: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    callerId: r.caller_id,
    calleeId: r.callee_id,
    peer: {
      id: r.peer_id,
      username: r.username,
      displayName: r.display_name,
      bio: r.bio,
      avatarColor: r.avatar_color,
      createdAt: r.user_created_at,
    },
    direction: r.caller_id === userId ? 'outgoing' : 'incoming',
    callType: r.call_type,
    status: r.status,
    startedAt: r.started_at,
    answeredAt: r.answered_at,
    endedAt: r.ended_at,
    durationSec: r.duration_sec,
  }));
}
