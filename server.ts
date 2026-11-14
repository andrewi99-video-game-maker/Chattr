import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  areFriends,
  createCallRecord,
  createSession,
  createUser,
  db,
  deleteMessageBySender,
  deleteSession,
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
  markCallAnswered,
  markMessagesRead,
  searchUsers,
  toggleMessageReaction,
  updateUserProfile,
  verifyPassword,
} from './server/db.ts';
import type { PublicUser } from './src/types.ts';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

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
  app.use(express.json({ limit: '1mb' }));

  // --- Auth Routes ---
  app.post('/api/auth/signup', (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(cleanUsername)) {
      res.status(400).json({
        error: 'Username must be 3–24 characters using letters, numbers, or underscores.',
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

    const user = createUser(cleanUsername, password, typeof displayName === 'string' ? displayName : '');
    const token = createSession(user.id);
    res.status(201).json({ token, user });
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const record = findUserByUsername(username);
    if (!record || !verifyPassword(password, record.passwordHash)) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const token = createSession(record.id);
    const { passwordHash: _ignored, ...publicUser } = record;
    res.json({ token, user: publicUser });
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
    const { displayName, bio, avatarColor } = req.body || {};
    const updated = updateUserProfile(user.id, { displayName, bio, avatarColor });
    if (!updated) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const friendIds = getFriendIds(user.id);
    for (const fid of friendIds) {
      sendToUser(fid, 'friends:updated', {});
    }
    res.json({ user: updated });
  });

  // --- User Search & Friends Routes ---
  app.get('/api/users/search', requireAuth, (req: AuthedRequest, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const users = searchUsers(req.user!.id, q);
    res.json({ users });
  });

  app.get('/api/friends', requireAuth, (req: AuthedRequest, res) => {
    const overview = getFriendsOverview(req.user!.id, getOnlineUserIds(), getInCallUserIds());
    res.json(overview);
  });

  app.post('/api/friends/request', requireAuth, (req: AuthedRequest, res) => {
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

  app.post('/api/messages/:friendId', requireAuth, (req: AuthedRequest, res) => {
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
    console.log(`Relay server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
