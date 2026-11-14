import { useEffect, useState, type FormEvent } from 'react';
import {
  Check,
  MessageSquare,
  Phone,
  Search,
  UserCheck,
  UserMinus,
  UserPlus,
  Video,
  X,
} from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api.ts';
import type { CallType, FriendItem, FriendRequestItem, SearchUserItem } from '../types.ts';
import { Avatar } from './Avatar.tsx';

interface FriendsViewProps {
  friends: FriendItem[];
  incomingRequests: FriendRequestItem[];
  outgoingRequests: FriendRequestItem[];
  onRefreshFriends: () => Promise<void>;
  onOpenChat: (friendId: string) => void;
  onStartCall: (friend: FriendItem, callType: CallType) => void;
}

export function FriendsView({
  friends,
  incomingRequests,
  outgoingRequests,
  onRefreshFriends,
  onOpenChat,
  onStartCall,
}: FriendsViewProps) {
  const [directUsername, setDirectUsername] = useState('');
  const [directStatus, setDirectStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [sendingDirect, setSendingDirect] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchUserItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const data = await apiRequest<{ users: SearchUserItem[] }>(
          `/api/users/search?q=${encodeURIComponent(searchQuery.trim())}`
        );
        if (active) {
          setSearchResults(data.users);
        }
      } catch {
        // ignore transient search errors
      } finally {
        if (active) setSearching(false);
      }
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchQuery, friends, incomingRequests, outgoingRequests]);

  async function handleAddByUsername(e: FormEvent) {
    e.preventDefault();
    const clean = directUsername.trim().replace(/^@/, '').toLowerCase();
    if (!clean) return;
    setDirectStatus(null);
    setSendingDirect(true);
    try {
      const res = await apiRequest<{ status: string }>('/api/friends/request', {
        method: 'POST',
        body: JSON.stringify({ username: clean }),
      });
      setDirectUsername('');
      setDirectStatus({
        type: 'ok',
        text:
          res.status === 'accepted'
            ? `You and @${clean} are now friends.`
            : `Friend request sent to @${clean}.`,
      });
      await onRefreshFriends();
    } catch (err) {
      setDirectStatus({
        type: 'err',
        text: err instanceof ApiError ? err.message : 'Could not send friend request.',
      });
    } finally {
      setSendingDirect(false);
    }
  }

  async function sendRequestToUser(user: SearchUserItem) {
    setBusyId(user.id);
    try {
      await apiRequest('/api/friends/request', {
        method: 'POST',
        body: JSON.stringify({ targetUserId: user.id }),
      });
      await onRefreshFriends();
    } catch {
      // handled via refresh
    } finally {
      setBusyId(null);
    }
  }

  async function respondToRequest(friendshipId: string, action: 'accept' | 'decline' | 'cancel') {
    setBusyId(friendshipId);
    try {
      await apiRequest('/api/friends/respond', {
        method: 'POST',
        body: JSON.stringify({ friendshipId, action }),
      });
      await onRefreshFriends();
    } finally {
      setBusyId(null);
    }
  }

  async function removeFriend(friendId: string) {
    setBusyId(friendId);
    try {
      await apiRequest(`/api/friends/${friendId}`, { method: 'DELETE' });
      await onRefreshFriends();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex-1 flex flex-col bg-[#FFFFFF] min-h-0">
      <div className="px-6 py-5 border-b border-[#E6EBF0]">
        <h1 className="font-display text-xl font-semibold text-[#283747]">Friends &amp; People</h1>
        <p className="text-sm text-[#5D6D7E] mt-0.5">
          Add friends by username, manage requests, and start conversations
        </p>
      </div>

      <div className="flex-1 overflow-y-auto chat-scroll p-6 space-y-8 max-w-4xl w-full">
        {/* Direct Add by @username */}
        <section className="bg-[#F4F6F8] border border-[#E6EBF0] rounded-2xl p-5">
          <h2 className="font-display text-sm font-semibold text-[#283747] mb-1">
            Add Friend by Username
          </h2>
          <p className="text-xs text-[#5D6D7E] mb-3.5">
            Enter your friend&apos;s exact handle to send a friend request right away.
          </p>
          <form onSubmit={handleAddByUsername} className="flex flex-col sm:flex-row gap-2.5">
            <div className="relative flex-1">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-sm text-[#7895B2]">
                @
              </span>
              <input
                type="text"
                value={directUsername}
                onChange={(e) => setDirectUsername(e.target.value.replace(/[^a-zA-Z0-9_@]/g, ''))}
                placeholder="username"
                className="w-full h-11 pl-8 pr-3.5 bg-[#FFFFFF] border border-[#E6EBF0] focus:border-[#7895B2] rounded-xl text-sm font-mono text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20"
              />
            </div>
            <button
              type="submit"
              disabled={sendingDirect || !directUsername.trim()}
              className="h-11 px-5 bg-[#7895B2] hover:bg-[#6684A2] disabled:opacity-50 text-white text-sm font-medium rounded-xl flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <UserPlus className="w-4 h-4" strokeWidth={1.6} />
              <span>{sendingDirect ? 'Sending...' : 'Send Request'}</span>
            </button>
          </form>
          {directStatus && (
            <p
              className={`mt-2.5 text-xs font-medium ${
                directStatus.type === 'ok' ? 'text-emerald-700' : 'text-red-600'
              }`}
            >
              {directStatus.text}
            </p>
          )}
        </section>

        {/* Incoming & Outgoing Friend Requests */}
        {(incomingRequests.length > 0 || outgoingRequests.length > 0) && (
          <section className="space-y-3">
            <h2 className="font-display text-sm font-semibold text-[#283747]">
              Pending Requests ({incomingRequests.length + outgoingRequests.length})
            </h2>

            <div className="border border-[#E6EBF0] rounded-2xl divide-y divide-[#F4F6F8] overflow-hidden bg-[#FFFFFF]">
              {incomingRequests.map((req) => (
                <div key={req.friendshipId} className="px-4 py-3.5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar name={req.user.displayName} color={req.user.avatarColor} size="md" />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#283747] truncate">
                        {req.user.displayName}
                      </div>
                      <div className="text-xs text-[#5D6D7E] flex items-center gap-1.5">
                        <span className="font-mono text-[#7895B2]">@{req.user.username}</span>
                        <span aria-hidden="true">·</span>
                        <span>Wants to connect</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busyId === req.friendshipId}
                      onClick={() => respondToRequest(req.friendshipId, 'accept')}
                      className="min-h-[40px] px-3.5 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" strokeWidth={1.7} />
                      <span>Accept</span>
                    </button>
                    <button
                      type="button"
                      disabled={busyId === req.friendshipId}
                      onClick={() => respondToRequest(req.friendshipId, 'decline')}
                      className="min-h-[40px] px-3 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#5D6D7E] hover:text-[#283747] text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" strokeWidth={1.6} />
                      <span>Decline</span>
                    </button>
                  </div>
                </div>
              ))}

              {outgoingRequests.map((req) => (
                <div
                  key={req.friendshipId}
                  className="px-4 py-3.5 flex items-center justify-between gap-4 bg-[#F4F6F8]/50"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar name={req.user.displayName} color={req.user.avatarColor} size="md" />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#283747] truncate">
                        {req.user.displayName}
                      </div>
                      <div className="text-xs text-[#5D6D7E] flex items-center gap-1.5">
                        <span className="font-mono text-[#7895B2]">@{req.user.username}</span>
                        <span aria-hidden="true">·</span>
                        <span>Request sent</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busyId === req.friendshipId}
                    onClick={() => respondToRequest(req.friendshipId, 'cancel')}
                    className="min-h-[40px] px-3.5 rounded-xl border border-[#E6EBF0] bg-[#FFFFFF] text-[#5D6D7E] hover:text-[#283747] hover:bg-[#F4F6F8] text-xs font-medium transition-colors cursor-pointer shrink-0"
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Current Friends */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-sm font-semibold text-[#283747]">
              Your Friends ({friends.length})
            </h2>
          </div>

          {friends.length === 0 ? (
            <div className="border border-[#E6EBF0] bg-[#F4F6F8]/70 rounded-2xl p-6 flex flex-col sm:flex-row items-center gap-6">
              <div className="w-36 aspect-[4/3] rounded-xl overflow-hidden border border-[#E6EBF0] shrink-0 bg-[#FFFFFF]">
                <img
                  src="/src/assets/images/friends_connect_art_1794565021200.jpg"
                  alt="Add friends artwork"
                  referrerPolicy="no-referrer"
                  className="w-full h-full object-cover"
                />
              </div>
              <div className="text-center sm:text-left">
                <p className="text-sm font-semibold text-[#283747]">No friends added yet</p>
                <p className="text-xs text-[#5D6D7E] mt-1 max-w-md leading-relaxed">
                  Enter a friend&apos;s username above or pick someone from the directory below to send a friend request.
                </p>
              </div>
            </div>
          ) : (
            <div className="border border-[#E6EBF0] rounded-2xl divide-y divide-[#F4F6F8] overflow-hidden bg-[#FFFFFF]">
              {friends.map((friend) => (
                <div
                  key={friend.id}
                  className="px-4 py-3.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 hover:bg-[#F4F6F8]/60 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar
                      name={friend.displayName}
                      color={friend.avatarColor}
                      size="md"
                      online={friend.online}
                      inCall={friend.inCall}
                      showPresence
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#283747] truncate">
                        {friend.displayName}
                      </div>
                      <div className="text-xs text-[#5D6D7E] flex items-center gap-1.5 truncate">
                        <span className="font-mono text-[#7895B2]">@{friend.username}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {friend.inCall ? 'On a call' : friend.online ? 'Online' : 'Offline'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => onOpenChat(friend.id)}
                      className="min-h-[40px] px-3 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <MessageSquare className="w-3.5 h-3.5 text-[#7895B2]" strokeWidth={1.6} />
                      <span>Text</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onStartCall(friend, 'voice')}
                      className="min-w-[40px] min-h-[40px] px-2.5 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] flex items-center justify-center transition-colors cursor-pointer"
                      title="Voice call"
                      aria-label={`Voice call ${friend.displayName}`}
                    >
                      <Phone className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onStartCall(friend, 'video')}
                      className="min-w-[40px] min-h-[40px] px-2.5 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white flex items-center justify-center transition-colors cursor-pointer"
                      title="Video call"
                      aria-label={`Video call ${friend.displayName}`}
                    >
                      <Video className="w-4 h-4" strokeWidth={1.6} />
                    </button>
                    <button
                      type="button"
                      disabled={busyId === friend.id}
                      onClick={() => removeFriend(friend.id)}
                      className="min-w-[40px] min-h-[40px] px-2.5 rounded-xl text-[#94A3B8] hover:text-red-600 hover:bg-red-50 flex items-center justify-center transition-colors cursor-pointer"
                      title="Remove friend"
                      aria-label={`Remove ${friend.displayName}`}
                    >
                      <UserMinus className="w-4 h-4" strokeWidth={1.6} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Discover People */}
        <section className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-[#283747]">
                Find People on Chattr
              </h2>
              <p className="text-xs text-[#5D6D7E]">
                Search registered usernames or browse people who recently joined
              </p>
            </div>
            <div className="relative w-full sm:w-64">
              <Search
                className="w-4 h-4 text-[#7895B2] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                strokeWidth={1.6}
              />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search username or name..."
                className="w-full h-10 pl-9 pr-3 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20"
              />
            </div>
          </div>

          <div className="border border-[#E6EBF0] rounded-2xl divide-y divide-[#F4F6F8] overflow-hidden bg-[#FFFFFF]">
            {searching && searchResults.length === 0 ? (
              <div className="p-6 text-center text-sm text-[#5D6D7E]">Searching directory...</div>
            ) : searchResults.length === 0 ? (
              <div className="p-6 text-center text-sm text-[#5D6D7E]">
                {searchQuery.trim()
                  ? `No accounts matched "${searchQuery.trim()}".`
                  : 'No other users have signed up yet. Open another tab to create a second account and connect!'}
              </div>
            ) : (
              searchResults.map((person) => (
                <div key={person.id} className="px-4 py-3.5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar name={person.displayName} color={person.avatarColor} size="md" />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#283747] truncate">
                        {person.displayName}
                      </div>
                      <div className="text-xs text-[#5D6D7E] truncate">
                        <span className="font-mono text-[#7895B2]">@{person.username}</span>
                        {person.bio ? (
                          <>
                            <span aria-hidden="true"> · </span>
                            <span>{person.bio}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="shrink-0">
                    {person.relationship === 'friends' ? (
                      <button
                        type="button"
                        onClick={() => onOpenChat(person.id)}
                        className="min-h-[40px] px-3.5 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <UserCheck className="w-3.5 h-3.5 text-[#7895B2]" strokeWidth={1.6} />
                        <span>Friends · Message</span>
                      </button>
                    ) : person.relationship === 'outgoing_pending' ? (
                      <button
                        type="button"
                        disabled={busyId === person.friendshipId}
                        onClick={() =>
                          person.friendshipId && respondToRequest(person.friendshipId, 'cancel')
                        }
                        className="min-h-[40px] px-3.5 rounded-xl border border-[#E6EBF0] text-[#5D6D7E] hover:bg-[#F4F6F8] text-xs font-medium transition-colors cursor-pointer"
                      >
                        Requested
                      </button>
                    ) : person.relationship === 'incoming_pending' ? (
                      <button
                        type="button"
                        disabled={busyId === person.friendshipId}
                        onClick={() =>
                          person.friendshipId && respondToRequest(person.friendshipId, 'accept')
                        }
                        className="min-h-[40px] px-3.5 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5" strokeWidth={1.7} />
                        <span>Accept</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyId === person.id}
                        onClick={() => sendRequestToUser(person)}
                        className="min-h-[40px] px-3.5 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <UserPlus className="w-3.5 h-3.5" strokeWidth={1.6} />
                        <span>Add Friend</span>
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
