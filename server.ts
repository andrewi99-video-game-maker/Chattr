import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  areFriends,
  checkpointDb,
  closeDb,
  createCallRecord,
  createFirebaseUser,
  createSession,
  createUser,
  db,
  deleteMessageBySender,
  deleteSession,
  editMessageBySender,
  findUserByFirebaseUid,
  findUserByUsername,
  finishCallRecord,
  getCallRecord,
  getConversationMessages,
  getFriendIds,
  getFriendsOverview,
  getFriendshipBetween,
  getUserById,
  getUserBySessionToken,
  getUserCallHistory,
  insertMessage,
  isUsernameAvailable,
  isValidUsername,
  markCallAnswered,
  markMessagesRead,
  normalizeUsername,
  searchUsers,
  toggleMessageReaction,
  updateUserPassword,
  updateUserProfile,
  verifyPassword,
} from './server/db.ts';
import {
  cloudflareSecurityHeaders,
  createRateLimiter,
  getClientIp,
  getTurnstilePublicConfig,
  verifyTurnstileToken,
} from './server/security.ts';
import type { PublicUser } from './src/types.ts';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

let firebaseApiKey = '';
try {
  const rawCfg = fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf8');
  const parsedCfg = JSON.parse(rawCfg) as { apiKey?: string };
  firebaseApiKey = parsedCfg.apiKey || '';
} catch {
  firebaseApiKey = '';
}

async function verifyFirebaseIdToken(idToken: string): Promise<{
  uid: string;
  email: string;
  displayName: string;
} | null> {
  if (!firebaseApiKey || !idToken.trim()) return null;
  try {
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(firebaseApiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      users?: Array<{
        localId?: string;
        email?: string;
        emailVerified?: boolean;
        displayName?: string;
        disabled?: boolean;
      }>;
    };
    const u = data.users?.[0];
    if (!u?.localId || u.disabled) return null;
    return {
      uid: u.localId,
      email: u.email || '',
      displayName: u.displayName || (u.email ? u.email.split('@')[0] : 'Chattr User'),
    };
  } catch {
    return null;
  }
}

function suggestCleanUsername(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 18);
  const root = base.length >= 3 ? base : 'chattr_user';
  if (isValidUsername(root) && isUsernameAvailable(root)) return root;
  for (let i = 1; i <= 50; i++) {
    const candidate = `${root.slice(0, 18)}_${i}`;
    if (isValidUsername(candidate) && isUsernameAvailable(candidate)) {
      return candidate;
    }
  }
  return `user_${crypto.randomBytes(3).toString('hex')}`;
}

// Active WebSocket connections per userId (supports multiple tabs)
const userSockets = new Map<string, Set<WebSocket>>();
// Active callId -> { callerId, calleeId }
const activeCalls = new Map<string, { callerId: string; calleeId: string }>();

function getOnlineUserIds(): Set<string> {
  const set = new Set<string>();
  for (const [uid, sockets] of userSockets.entries()) {
    if (sockets.size > 0) set.add(uid);
  }
  return set;
}

function getInCallUserIds(): Set<string> {
  const set = new Set<string>();
  for (const call of activeCalls.values()) {
    set.add(call.callerId);
    set.add(call.calleeId);
  }
  return set;
}

function sendToUser(userId: string, event: string, payload: unknown): void {
  const sockets = userSockets.get(userId);
  if (!sockets || sockets.size === 0) return;
  const serialized = JSON.stringify({ event, payload });
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialized);
    }
  }
}

function broadcastPresenceToFriends(userId: string): void {
  const online = userSockets.has(userId) && (userSockets.get(userId)?.size || 0) > 0;
  const inCall = getInCallUserIds().has(userId);
  const friendIds = getFriendIds(userId);
  for (const friendId of friendIds) {
    sendToUser(friendId, 'presence:update', { userId, online, inCall });
  }
}

function formatCallDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

interface AuthedRequest extends express.Request {
  user?: PublicUser;
  authToken?: string;
}

function requireAuth(req: AuthedRequest, res: express.Response, next: express.NextFunction): void {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const user = getUserBySessionToken(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }
  req.user = user;
  req.authToken = token;
  next();
}

async function startServer() {
  const app = express();
  app.set('trust proxy', true);
  app.use(cloudflareSecurityHeaders);
  app.use(express.json({ limit: '1mb' }));

  const apiGeneralLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 300,
    keyPrefix: 'api',
  });
  const authLimiter = createRateLimiter({
    windowMs: 5 * 60_000,
    max: 25,
    keyPrefix: 'auth',
    message: 'Too many authentication attempts. Please wait a few minutes.',
  });
  const writeLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 120,
    keyPrefix: 'write',
    message: 'Slow down slightly before sending more requests.',
  });

  app.use('/api', apiGeneralLimiter);

  app.get('/api/security/status', (req, res) => {
    res.json(getTurnstilePublicConfig(req));
  });

  // --- Auth Routes ---
  app.get('/api/auth/check-username', (req, res) => {
    const raw = typeof req.query.username === 'string' ? req.query.username : '';
    const clean = normalizeUsername(raw);
    if (!clean) {
      res.json({ valid: false, available: false });
      return;
    }
    if (!isValidUsername(clean)) {
      res.json({
        valid: false,
        available: false,
        reason: 'Use 3–24 letters, numbers, underscores, dots, or hyphens.',
      });
      return;
    }
    const excludeId = typeof req.query.excludeUserId === 'string' ? req.query.excludeUserId : undefined;
    const available = isUsernameAvailable(clean, excludeId);
    res.json({
      valid: true,
      available,
      reason: available ? undefined : 'That username is already taken.',
    });
  });

  app.post('/api/auth/signup', authLimiter, async (req, res) => {
    const { username, password, displayName, turnstileToken } = req.body || {};
    const cfCheck = await verifyTurnstileToken(turnstileToken, getClientIp(req));
    if (!cfCheck.ok) {
      res.status(403).json({ error: cfCheck.error });
      return;
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const cleanUsername = normalizeUsername(username);
    if (!isValidUsername(cleanUsername)) {
      res.status(400).json({
        error: 'Username must be 3–24 characters using letters, numbers, underscores, dots, or hyphens.',
      });
      return;
    }

    if (password.length < 4 || password.length > 128) {
      res.status(400).json({ error: 'Password must be between 4 and 128 characters.' });
      return;
    }

    const existing = findUserByUsername(cleanUsername);
    if (existing) {
      res.status(409).json({ error: 'That username is already taken.' });
      return;
    }

    try {
      const user = createUser(cleanUsername, password, typeof displayName === 'string' ? displayName : '');
      const token = createSession(user.id);
      checkpointDb();
      res.status(201).json({ token, user });
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
      ) {
        res.status(409).json({ error: 'That username is already taken.' });
        return;
      }
      throw err;
    }
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const { username, password, turnstileToken } = req.body || {};
    const cfCheck = await verifyTurnstileToken(turnstileToken, getClientIp(req));
    if (!cfCheck.ok) {
      res.status(403).json({ error: cfCheck.error });
      return;
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const record = findUserByUsername(username);
    if (!record) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }
    if (record.passwordHash === 'oauth:firebase') {
      res.status(401).json({ error: 'This account signs in with Google. Use "Continue with Google" below.' });
      return;
    }
    if (!verifyPassword(password, record.passwordHash)) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const token = createSession(record.id);
    const { passwordHash: _ignored, ...publicUser } = record;
    res.json({ token, user: publicUser });
  });

  app.post('/api/auth/firebase', authLimiter, async (req, res) => {
    const { idToken, username, displayName, bio, avatarColor, turnstileToken } = req.body || {};
    if (typeof idToken !== 'string' || !idToken.trim()) {
      res.status(400).json({ error: 'Firebase ID token is required.' });
      return;
    }

    const verified = await verifyFirebaseIdToken(idToken);
    if (!verified) {
      res.status(401).json({ error: 'Could not verify Google session with Firebase.' });
      return;
    }

    const existing = findUserByFirebaseUid(verified.uid);
    if (existing) {
      let currentUser = existing;
      if (
        typeof username === 'string' ||
        typeof displayName === 'string' ||
        typeof bio === 'string' ||
        typeof avatarColor === 'string'
      ) {
        const updated = updateUserProfile(existing.id, {
          username: typeof username === 'string' ? username : undefined,
          displayName: typeof displayName === 'string' ? displayName : undefined,
          bio: typeof bio === 'string' ? bio : undefined,
          avatarColor: typeof avatarColor === 'string' ? avatarColor : undefined,
        });
        if (!updated.user) {
          res.status(updated.status || 400).json({ error: updated.error || 'Could not sync profile.' });
          return;
        }
        currentUser = updated.user;
      }
      const token = createSession(currentUser.id);
      res.json({ token, user: currentUser, needsUsernameSetup: false });
      return;
    }

    // First-time Google user: enforce Turnstile only on initial sign-in if not yet onboarding
    if (typeof username !== 'string' || !username.trim()) {
      const cfCheck = await verifyTurnstileToken(turnstileToken, getClientIp(req));
      if (!cfCheck.ok) {
        res.status(403).json({ error: cfCheck.error });
        return;
      }
      res.json({
        needsUsernameSetup: true,
        firebaseUid: verified.uid,
        email: verified.email,
        suggestedDisplayName: verified.displayName,
        suggestedUsername: suggestCleanUsername(verified.email.split('@')[0] || verified.displayName),
      });
      return;
    }

    const cleanUsername = normalizeUsername(username);
    if (!isValidUsername(cleanUsername)) {
      res.status(400).json({
        error: 'Username must be 3–24 characters using letters, numbers, underscores, dots, or hyphens.',
      });
      return;
    }
    if (!isUsernameAvailable(cleanUsername)) {
      res.status(409).json({ error: 'That username is already taken.' });
      return;
    }

    try {
      const user = createFirebaseUser({
        firebaseUid: verified.uid,
        username: cleanUsername,
        displayName: typeof displayName === 'string' && displayName.trim() ? displayName : verified.displayName,
        bio: typeof bio === 'string' ? bio : '',
        avatarColor: typeof avatarColor === 'string' ? avatarColor : undefined,
      });
      const token = createSession(user.id);
      checkpointDb();
      res.status(201).json({ token, user, needsUsernameSetup: false });
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
      ) {
        res.status(409).json({ error: 'That username is already taken.' });
        return;
      }
      throw err;
    }
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    if (req.authToken) {
      deleteSession(req.authToken);
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user });
  });

  app.patch('/api/auth/profile', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const { username, displayName, bio, avatarColor } = req.body || {};
    const result = updateUserProfile(user.id, { username, displayName, bio, avatarColor });
    if (!result.user) {
      res.status(result.status || 400).json({ error: result.error || 'Failed to update profile.' });
      return;
    }
    const friendIds = getFriendIds(user.id);
    for (const fid of friendIds) {
      sendToUser(fid, 'friends:updated', {});
    }
    res.json({ user: result.user });
  });

  app.post('/api/auth/password', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'Current password and new password are required.' });
      return;
    }
    const result = updateUserPassword(user.id, currentPassword, newPassword);
    if (!result.ok) {
      res.status(result.status || 400).json({ error: result.error || 'Could not update password.' });
      return;
    }
    res.json({ ok: true });
  });

  // --- User Search & Friends Routes ---
  app.get('/api/users/search', requireAuth, (req: AuthedRequest, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const users = searchUsers(req.user!.id, q, getOnlineUserIds());
    res.json({ users });
  });

  app.get('/api/friends', requireAuth, (req: AuthedRequest, res) => {
    const overview = getFriendsOverview(req.user!.id, getOnlineUserIds(), getInCallUserIds());
    res.json(overview);
  });

  app.post('/api/friends/request', requireAuth, writeLimiter, (req: AuthedRequest, res) => {
    const me = req.user!;
    const { username, targetUserId } = req.body || {};

    let target: PublicUser | null = null;
    if (typeof targetUserId === 'string' && targetUserId.trim()) {
      target = getUserById(targetUserId.trim());
    } else if (typeof username === 'string' && username.trim()) {
      const found = findUserByUsername(username.trim());
      if (found) {
        const { passwordHash: _ignored, ...pub } = found;
        target = pub;
      }
    }

    if (!target) {
      res.status(404).json({ error: 'No user found with that username.' });
      return;
    }

    if (target.id === me.id) {
      res.status(400).json({ error: 'You cannot add yourself as a friend.' });
      return;
    }

    const existing = getFriendshipBetween(me.id, target.id);
    if (existing) {
      if (existing.status === 'accepted') {
        res.status(409).json({ error: 'You are already friends.' });
        return;
      }
      if (existing.requester_id === target.id) {
        // Mutual request: auto-accept!
        db.prepare(`UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?`).run(
          Date.now(),
          existing.id
        );
        sendToUser(me.id, 'friends:updated', {});
        sendToUser(target.id, 'friends:updated', {});
        res.json({ status: 'accepted', friendshipId: existing.id });
        return;
      }
      res.status(409).json({ error: 'Friend request already sent.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?)`
    ).run(id, me.id, target.id, now, now);

    sendToUser(me.id, 'friends:updated', {});
    sendToUser(target.id, 'friends:updated', { fromUser: me });
    res.status(201).json({ status: 'pending', friendshipId: id });
  });

  app.post('/api/friends/respond', requireAuth, (req: AuthedRequest, res) => {
    const me = req.user!;
    const { friendshipId, action } = req.body || {};
    if (typeof friendshipId !== 'string' || !['accept', 'decline', 'cancel'].includes(action)) {
      res.status(400).json({ error: 'Invalid request parameters.' });
      return;
    }

    const row = db.prepare(`SELECT * FROM friendships WHERE id = ?`).get(friendshipId) as
      | {
          id: string;
          requester_id: string;
          addressee_id: string;
          status: string;
        }
      | undefined;

    if (!row) {
      res.status(404).json({ error: 'Friend request not found.' });
      return;
    }

    if (action === 'cancel') {
      if (row.requester_id !== me.id || row.status !== 'pending') {
        res.status(403).json({ error: 'Not authorized to cancel this request.' });
        return;
      }
      db.prepare(`DELETE FROM friendships WHERE id = ?`).run(friendshipId);
      sendToUser(row.requester_id, 'friends:updated', {});
      sendToUser(row.addressee_id, 'friends:updated', {});
      res.json({ ok: true });
      return;
    }

    if (row.addressee_id !== me.id || row.status !== 'pending') {
      res.status(403).json({ error: 'Not authorized to respond to this request.' });
      return;
    }

    if (action === 'accept') {
      db.prepare(`UPDATE friendships SET status = 'accepted', updated_at = ? WHERE id = ?`).run(
        Date.now(),
        friendshipId
      );
    } else {
      db.prepare(`DELETE FROM friendships WHERE id = ?`).run(friendshipId);
    }

    sendToUser(row.requester_id, 'friends:updated', {});
    sendToUser(row.addressee_id, 'friends:updated', {});
    res.json({ ok: true });
  });

  app.delete('/api/friends/:friendId', requireAuth, (req: AuthedRequest, res) => {
    const me = req.user!;
    const friendId = String(req.params.friendId);
    const rel = getFriendshipBetween(me.id, friendId);
    if (!rel) {
      res.status(404).json({ error: 'Friendship not found.' });
      return;
    }
    db.prepare(`DELETE FROM friendships WHERE id = ?`).run(rel.id);
    sendToUser(me.id, 'friends:updated', {});
    sendToUser(friendId, 'friends:updated', {});
    res.json({ ok: true });
  });

  // --- Messaging Routes ---
  app.get('/api/messages/:friendId', requireAuth, (req: AuthedRequest, res) => {
    const me = req.user!;
    const friendId = String(req.params.friendId);
    const changed = markMessagesRead(me.id, friendId);
    if (changed > 0) {
      sendToUser(friendId, 'messages:read', { byUserId: me.id });
    }
    const messages = getConversationMessages(me.id, friendId);
    res.json({ messages });
  });

  app.post('/api/messages/:friendId', requireAuth, writeLimiter, (req: AuthedRequest, res) => {
    const me = req.user!;
    const friendId = String(req.params.friendId);
    const { body, replyToId } = req.body || {};

    if (!areFriends(me.id, friendId)) {
      res.status(403).json({ error: 'You must be friends to send messages.' });
      return;
    }

    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'Message cannot be empty.' });
      return;
    }

    const cleanBody = body.trim().slice(0, 4000);
    const message = insertMessage({
      senderId: me.id,
      recipientId: friendId,
      body: cleanBody,
      replyToId: typeof replyToId === 'string' ? replyToId : null,
      kind: 'text',
    });

    sendToUser(me.id, 'message:new', { message });
    sendToUser(friendId, 'message:new', { message });
    res.status(201).json({ message });
  });

  app.post('/api/messages/:messageId/react', requireAuth, (req: AuthedRequest, res) => {
    const me = req.user!;
    const messageId = String(req.params.messageId);
    const { emoji } = req.body || {};
    if (typeof emoji !== 'string' || emoji.trim().length === 0 || emoji.length > 8) {
      res.status(400).json({ error: 'Invalid reaction.' });
      return;
    }
    const updated = toggleMessageReaction(messageId, me.id, emoji.trim());
    if (!updated) {
      res.status(404).json({ error: 'Message not found.' });
      return;
    }
    sendToUser(updated.senderId, 'message:updated', { message: updated });
    sendToUser(updated.recipientId, 'message:updated', { message: updated });
    res.json({ message: updated });
  });

  app.patch('/api/messages/:messageId', requireAuth, (req: AuthedRequest, res) => {
    const me = req.user!;
    const messageId = String(req.params.messageId);
    const { body } = req.body || {};
    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'Message cannot be empty.' });
      return;
    }
    const updated = editMessageBySender(messageId, me.id, body.trim().slice(0, 4000));
    if (!updated) {
      res.status(404).json({ error: 'Message not found or cannot be edited.' });
      return;
    }
    sendToUser(updated.senderId, 'message:updated', { message: updated });
    sendToUser(updated.recipientId, 'message:updated', { message: updated });
    res.json({ message: updated });
  });

  app.delete('/api/messages/:messageId', requireAuth, (req: AuthedRequest, res) => {
    const me = req.user!;
    const messageId = String(req.params.messageId);
    const deleted = deleteMessageBySender(messageId, me.id);
    if (!deleted) {
      res.status(404).json({ error: 'Message not found or not yours to delete.' });
      return;
    }
    sendToUser(me.id, 'message:deleted', { messageId });
    sendToUser(deleted.recipientId, 'message:deleted', { messageId });
    res.json({ ok: true });
  });

  // --- Calls History Route ---
  app.get('/api/calls', requireAuth, (req: AuthedRequest, res) => {
    const calls = getUserCallHistory(req.user!.id);
    res.json({ calls });
  });

  // --- Vite / Static Frontend Serving ---
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // --- HTTP + WebSocket Server ---
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const reqUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (reqUrl.pathname !== '/ws') {
      return;
    }
    const token = reqUrl.searchParams.get('token') || '';
    const user = token ? getUserBySessionToken(token) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, user);
    });
  });

  wss.on('connection', (ws: WebSocket, user: PublicUser) => {
    let sockets = userSockets.get(user.id);
    const wasOffline = !sockets || sockets.size === 0;
    if (!sockets) {
      sockets = new Set();
      userSockets.set(user.id, sockets);
    }
    sockets.add(ws);

    if (wasOffline) {
      broadcastPresenceToFriends(user.id);
    }

    // Send initial connection ack
    ws.send(JSON.stringify({ event: 'ws:ready', payload: { userId: user.id } }));

    ws.on('message', (raw) => {
      let parsed: { event?: string; payload?: Record<string, unknown> };
      try {
        parsed = JSON.parse(raw.toString()) as { event?: string; payload?: Record<string, unknown> };
      } catch {
        return;
      }
      const event = parsed.event;
      const payload = parsed.payload || {};
      if (!event) return;

      if (event === 'typing:start' || event === 'typing:stop') {
        const toUserId = typeof payload.toUserId === 'string' ? payload.toUserId : '';
        if (toUserId && areFriends(user.id, toUserId)) {
          sendToUser(toUserId, event, { fromUserId: user.id });
        }
        return;
      }

      if (event === 'messages:mark_read') {
        const friendId = typeof payload.friendId === 'string' ? payload.friendId : '';
        if (friendId) {
          const changed = markMessagesRead(user.id, friendId);
          if (changed > 0) {
            sendToUser(friendId, 'messages:read', { byUserId: user.id });
          }
        }
        return;
      }

      if (event === 'call:invite') {
        const toUserId = typeof payload.toUserId === 'string' ? payload.toUserId : '';
        const callType = payload.callType === 'video' ? 'video' : 'voice';
        const callId = typeof payload.callId === 'string' ? payload.callId : crypto.randomUUID();
        if (!toUserId || !areFriends(user.id, toUserId)) {
          ws.send(JSON.stringify({ event: 'call:error', payload: { callId, reason: 'You can only call friends.' } }));
          return;
        }

        const peerSockets = userSockets.get(toUserId);
        if (!peerSockets || peerSockets.size === 0) {
          createCallRecord({ id: callId, callerId: user.id, calleeId: toUserId, callType, status: 'missed' });
          const sysMsg = insertMessage({
            senderId: user.id,
            recipientId: toUserId,
            body: `Missed ${callType} call`,
            kind: 'call_event',
          });
          sendToUser(user.id, 'message:new', { message: sysMsg });
          sendToUser(user.id, 'calls:updated', {});
          ws.send(
            JSON.stringify({
              event: 'call:unavailable',
              payload: { callId, reason: 'User is currently offline.' },
            })
          );
          return;
        }

        if (getInCallUserIds().has(toUserId)) {
          ws.send(
            JSON.stringify({
              event: 'call:unavailable',
              payload: { callId, reason: 'User is currently on another call.' },
            })
          );
          return;
        }

        activeCalls.set(callId, { callerId: user.id, calleeId: toUserId });
        createCallRecord({ id: callId, callerId: user.id, calleeId: toUserId, callType, status: 'ringing' });
        broadcastPresenceToFriends(user.id);
        broadcastPresenceToFriends(toUserId);

        sendToUser(toUserId, 'call:incoming', {
          callId,
          callType,
          caller: user,
        });
        return;
      }

      if (event === 'call:accept') {
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        const toUserId = typeof payload.toUserId === 'string' ? payload.toUserId : '';
        const call = getCallRecord(callId);
        if (!call || call.callee_id !== user.id) return;
        markCallAnswered(callId);
        sendToUser(toUserId, 'call:accepted', { callId, byUserId: user.id });
        return;
      }

      if (event === 'call:decline') {
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        const toUserId = typeof payload.toUserId === 'string' ? payload.toUserId : '';
        const finished = finishCallRecord(callId, 'declined');
        activeCalls.delete(callId);
        if (finished) {
          broadcastPresenceToFriends(finished.callerId);
          broadcastPresenceToFriends(finished.calleeId);
          const sysMsg = insertMessage({
            senderId: finished.callerId,
            recipientId: finished.calleeId,
            body: `Declined ${finished.callType} call`,
            kind: 'call_event',
          });
          sendToUser(finished.callerId, 'message:new', { message: sysMsg });
          sendToUser(finished.calleeId, 'message:new', { message: sysMsg });
          sendToUser(finished.callerId, 'calls:updated', {});
          sendToUser(finished.calleeId, 'calls:updated', {});
        }
        sendToUser(toUserId, 'call:declined', { callId, byUserId: user.id });
        return;
      }

      if (event === 'call:end') {
        const callId = typeof payload.callId === 'string' ? payload.callId : '';
        const toUserId = typeof payload.toUserId === 'string' ? payload.toUserId : '';
        const finished = finishCallRecord(callId);
        activeCalls.delete(callId);
        if (finished) {
          broadcastPresenceToFriends(finished.callerId);
          broadcastPresenceToFriends(finished.calleeId);
          const label =
            finished.status === 'ended'
              ? `${finished.callType === 'video' ? 'Video' : 'Voice'} call · ${formatCallDuration(finished.durationSec)}`
              : `Missed ${finished.callType} call`;
          const sysMsg = insertMessage({
            senderId: finished.callerId,
            recipientId: finished.calleeId,
            body: label,
            kind: 'call_event',
          });
          sendToUser(finished.callerId, 'message:new', { message: sysMsg });
          sendToUser(finished.calleeId, 'message:new', { message: sysMsg });
          sendToUser(finished.callerId, 'calls:updated', {});
          sendToUser(finished.calleeId, 'calls:updated', {});
        }
        if (toUserId) {
          sendToUser(toUserId, 'call:ended', { callId, byUserId: user.id });
        }
        return;
      }

      if (
        event === 'call:offer' ||
        event === 'call:answer' ||
        event === 'call:ice-candidate' ||
        event === 'call:media-state'
      ) {
        const toUserId = typeof payload.toUserId === 'string' ? payload.toUserId : '';
        if (toUserId) {
          sendToUser(toUserId, event, { ...payload, fromUserId: user.id });
        }
      }
    });

    ws.on('close', () => {
      const set = userSockets.get(user.id);
      if (set) {
        set.delete(ws);
        if (set.size === 0) {
          userSockets.delete(user.id);
          // End any active calls involving this user if they fully disconnected
          for (const [callId, call] of activeCalls.entries()) {
            if (call.callerId === user.id || call.calleeId === user.id) {
              const peerId = call.callerId === user.id ? call.calleeId : call.callerId;
              const finished = finishCallRecord(callId);
              activeCalls.delete(callId);
              if (finished) {
                const label =
                  finished.status === 'ended'
                    ? `${finished.callType === 'video' ? 'Video' : 'Voice'} call · ${formatCallDuration(finished.durationSec)}`
                    : `Missed ${finished.callType} call`;
                const sysMsg = insertMessage({
                  senderId: finished.callerId,
                  recipientId: finished.calleeId,
                  body: label,
                  kind: 'call_event',
                });
                sendToUser(peerId, 'message:new', { message: sysMsg });
                sendToUser(peerId, 'calls:updated', {});
              }
              sendToUser(peerId, 'call:ended', { callId, byUserId: user.id });
              broadcastPresenceToFriends(peerId);
            }
          }
          broadcastPresenceToFriends(user.id);
        }
      }
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Chattr server listening on http://0.0.0.0:${PORT}`);
  });

  const shutdown = () => {
    closeDb();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
