# Chattr Firestore Security Specification

## 1. Data Invariants
1. **Unique Usernames**: A username reservation at `/usernames/{username}` is valid only if `{username}` matches `^[a-z0-9_.-]{3,24}$`, `uid == request.auth.uid`, and `/users/{uid}` exists after the atomic write batch. Updating a reservation document directly is forbidden (users atomically delete the old reservation and create the new one).
2. **Profile Integrity & PII Isolation**: Public profiles at `/users/{userId}` never store PII (`email`). Email is isolated in `/users/{userId}/private/info` with owner-only read/write access.
3. **Friendship Boundaries**: A friendship at `/friendships/{friendshipId}` can only be created by `requesterId == request.auth.uid` with `status == 'pending'`, targeting an existing `addresseeId != request.auth.uid`. Only `addresseeId` may accept (`pending -> accepted`).
4. **Master Gate on Messages**: Messages in `/conversations/{pairId}/messages/{messageId}` require the parent `/conversations/{pairId}` document to include `request.auth.uid` in `participants`, and creating a conversation requires an `accepted` friendship.
5. **Terminal Call State**: Once a call in `/calls/{callId}` reaches `'ended'`, `'missed'`, or `'declined'`, no subsequent updates are permitted.

## 2. Adversarial "Dirty Dozen" Test Payloads
1. **Duplicate Username Hijack**: User B attempts `create` on `/usernames/alex` when `/usernames/alex` already exists -> `PERMISSION_DENIED`.
2. **Orphaned Username Reservation**: User creates `/usernames/alex` without creating `/users/{uid}` in the same batch -> `PERMISSION_DENIED`.
3. **Shadow Field Injection on Profile**: User adds `isAdmin: true` to `/users/{uid}` -> `PERMISSION_DENIED` (`hasOnly` rejects).
4. **Cross-User Profile Spoof**: User A sets `uid: userB` in `/users/{userA}` -> `PERMISSION_DENIED`.
5. **PII Blanket Read**: User A attempts `get` on `/users/{userB}/private/info` -> `PERMISSION_DENIED`.
6. **Users Directory Scrape**: User A attempts `list` on `/users` -> `PERMISSION_DENIED`.
7. **Self-Accept Friend Request**: Requester attempts to update their own outgoing `pending` request to `accepted` -> `PERMISSION_DENIED`.
8. **Auto-Accepted Friendship Create**: User A creates `/friendships/{pairId}` directly with `status: 'accepted'` -> `PERMISSION_DENIED`.
9. **Unrelated User Reads Messages**: User C attempts `get` on `/conversations/{userA_userB}/messages/{msgId}` -> `PERMISSION_DENIED`.
10. **Non-Sender Edits Message**: Recipient attempts to modify `body` on a message sent by User A -> `PERMISSION_DENIED`.
11. **Client Timestamp Forgery**: User submits `createdAt: 123456` instead of `request.time` -> `PERMISSION_DENIED`.
12. **Terminal Call Reopen**: User attempts to update `/calls/{callId}` from `status: 'ended'` back to `status: 'active'` -> `PERMISSION_DENIED`.
