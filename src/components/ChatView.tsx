import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import {
  ArrowDown,
  ArrowLeft,
  Check,
  CheckCheck,
  Copy,
  Info,
  Pencil,
  Phone,
  Reply,
  Search,
  Send,
  ShieldCheck,
  Smile,
  Trash2,
  UserMinus,
  Video,
  X,
} from 'lucide-react';
import { CHATTR_ASSETS } from '../lib/assets.ts';
import type { CallType, ChatMessage, FriendItem, PublicUser } from '../types.ts';
import { Avatar } from './Avatar.tsx';
import { SafeImage } from './SafeImage.tsx';

const QUICK_EMOJIS = ['👍', '❤️', '😂', '🔥', '🎉', '🙏'];

interface ChatViewProps {
  currentUser: PublicUser;
  friend: FriendItem;
  messages: ChatMessage[];
  loading: boolean;
  isTyping: boolean;
  onBackMobile: () => void;
  onSendMessage: (body: string, replyToId?: string | null) => Promise<void>;
  onEditMessage: (messageId: string, body: string) => Promise<void>;
  onReactMessage: (messageId: string, emoji: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  onTypingChange: (typing: boolean) => void;
  onStartCall: (friend: FriendItem, callType: CallType) => void;
  onRemoveFriend: (friendId: string) => Promise<void>;
}

function formatMessageTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDayDivider(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate()
  ) {
    return 'Yesterday';
  }
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

export function ChatView({
  currentUser,
  friend,
  messages,
  loading,
  isTyping,
  onBackMobile,
  onSendMessage,
  onEditMessage,
  onReactMessage,
  onDeleteMessage,
  onTypingChange,
  onStartCall,
  onRemoveFriend,
}: ChatViewProps) {
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<ChatMessage | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [emojiMenuFor, setEmojiMenuFor] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [showComposerEmoji, setShowComposerEmoji] = useState(false);
  const [showInfoPanel, setShowInfoPanel] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [sending, setSending] = useState(false);

  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [highlightedMsgId, setHighlightedMsgId] = useState<string | null>(null);

  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prevFriendIdRef = useRef<string>(friend.id);

  // Auto-scroll on initial load or when near bottom
  useEffect(() => {
    const el = scrollContainerRef.current;
    const switchedFriend = prevFriendIdRef.current !== friend.id;
    prevFriendIdRef.current = friend.id;
    if (switchedFriend) {
      scrollEndRef.current?.scrollIntoView({ behavior: 'auto' });
      return;
    }
    if (!el) {
      scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 180) {
      scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, isTyping, friend.id]);

  useEffect(() => {
    setReplyTo(null);
    setEditingMsg(null);
    setEmojiMenuFor(null);
    setShowComposerEmoji(false);
    setConfirmRemove(false);
    setShowSearch(false);
    setSearchQuery('');
    setShowScrollBottom(false);
  }, [friend.id]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(128, Math.max(44, ta.scrollHeight))}px`;
  }, [draft]);

  function handleScroll() {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollBottom(distanceFromBottom > 240);
  }

  function scrollToMessage(id: string) {
    const target = document.getElementById(`msg-${id}`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightedMsgId(id);
    window.setTimeout(() => {
      setHighlightedMsgId((cur) => (cur === id ? null : cur));
    }, 1500);
  }

  function handleDraftChange(val: string) {
    setDraft(val);
    onTypingChange(true);
    if (typingTimerRef.current) {
      window.clearTimeout(typingTimerRef.current);
    }
    typingTimerRef.current = window.setTimeout(() => {
      onTypingChange(false);
    }, 1800);
  }

  async function submitMessage(e?: FormEvent) {
    e?.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setSending(true);
    onTypingChange(false);
    if (typingTimerRef.current) window.clearTimeout(typingTimerRef.current);
    try {
      await onSendMessage(trimmed, replyTo?.id ?? null);
      setDraft('');
      setReplyTo(null);
      setShowComposerEmoji(false);
      textareaRef.current?.focus();
      window.setTimeout(() => {
        scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 30);
    } finally {
      setSending(false);
    }
  }

  async function submitEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingMsg) return;
    const trimmed = editDraft.trim();
    if (!trimmed || trimmed === editingMsg.body) {
      setEditingMsg(null);
      return;
    }
    await onEditMessage(editingMsg.id, trimmed);
    setEditingMsg(null);
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submitMessage();
    }
  }

  function handleCopyMessage(msg: ChatMessage) {
    navigator.clipboard?.writeText(msg.body).catch(() => {});
    setCopiedId(msg.id);
    window.setTimeout(() => {
      setCopiedId((cur) => (cur === msg.id ? null : cur));
    }, 1500);
  }

  const displayedMessages = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter((m) => m.body.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  const lastOutgoingId = [...messages]
    .reverse()
    .find((m) => m.senderId === currentUser.id && m.kind === 'text')?.id;

  return (
    <div className="flex-1 flex min-w-0 min-h-0 bg-[#FFFFFF]">
      <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
        {/* Chat Header */}
        <header className="h-16 px-4 sm:px-6 border-b border-[#E6EBF0] bg-[#FFFFFF] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBackMobile}
              className="md:hidden min-w-[44px] min-h-[44px] -ml-2 flex items-center justify-center rounded-xl text-[#5D6D7E] hover:bg-[#F4F6F8] cursor-pointer"
              aria-label="Back to conversations"
            >
              <ArrowLeft className="w-5 h-5" strokeWidth={1.6} />
            </button>
            <Avatar
              name={friend.displayName}
              color={friend.avatarColor}
              size="md"
              online={friend.online}
              inCall={friend.inCall}
              showPresence
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-display text-base font-semibold text-[#283747] truncate">
                  {friend.displayName}
                </h2>
                <span className="hidden sm:inline font-mono text-xs text-[#7895B2] truncate">
                  @{friend.username}
                </span>
              </div>
              <div className="text-xs text-[#5D6D7E] truncate">
                {isTyping ? (
                  <span className="text-[#7895B2] font-medium">Typing...</span>
                ) : friend.inCall ? (
                  <span className="text-amber-600 font-medium">In a call</span>
                ) : friend.online ? (
                  <span className="text-emerald-600">Online</span>
                ) : (
                  <span>Offline</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setShowSearch((v) => !v);
                if (showSearch) setSearchQuery('');
              }}
              className={`min-w-[40px] min-h-[40px] rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                showSearch
                  ? 'bg-[#7895B2]/15 text-[#7895B2]'
                  : 'text-[#5D6D7E] hover:bg-[#F4F6F8] hover:text-[#283747]'
              }`}
              title="Search messages"
              aria-label="Search conversation"
            >
              <Search className="w-4 h-4" strokeWidth={1.6} />
            </button>
            <button
              type="button"
              onClick={() => onStartCall(friend, 'voice')}
              className="min-w-[40px] min-h-[40px] px-3 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer"
              title="Start voice call"
            >
              <Phone className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
              <span className="hidden lg:inline">Voice Call</span>
            </button>
            <button
              type="button"
              onClick={() => onStartCall(friend, 'video')}
              className="min-w-[40px] min-h-[40px] px-3 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white flex items-center gap-1.5 text-xs font-medium transition-colors cursor-pointer"
              title="Start video call"
            >
              <Video className="w-4 h-4" strokeWidth={1.6} />
              <span className="hidden lg:inline">Video Call</span>
            </button>
            <button
              type="button"
              onClick={() => setShowInfoPanel((v) => !v)}
              className={`min-w-[40px] min-h-[40px] rounded-xl flex items-center justify-center transition-colors cursor-pointer ${
                showInfoPanel
                  ? 'bg-[#7895B2]/15 text-[#7895B2]'
                  : 'text-[#5D6D7E] hover:bg-[#F4F6F8] hover:text-[#283747]'
              }`}
              aria-label="Toggle friend details"
            >
              <Info className="w-4 h-4" strokeWidth={1.6} />
            </button>
          </div>
        </header>

        {/* Collapsible In-Chat Search */}
        {showSearch && (
          <div className="px-4 sm:px-6 py-2.5 border-b border-[#E6EBF0] bg-[#F4F6F8] flex items-center gap-2 shrink-0">
            <Search className="w-4 h-4 text-[#7895B2] shrink-0" strokeWidth={1.6} />
            <input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search in conversation..."
              className="flex-1 bg-transparent text-sm text-[#283747] placeholder:text-[#94A3B8] focus:outline-none"
            />
            {searchQuery && (
              <span className="font-mono text-xs text-[#5D6D7E] tabular-nums">
                {displayedMessages.length} found
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setShowSearch(false);
                setSearchQuery('');
              }}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[#5D6D7E] hover:bg-[#E8EDF2] cursor-pointer"
              aria-label="Close search"
            >
              <X className="w-4 h-4" strokeWidth={1.6} />
            </button>
          </div>
        )}

        {/* Messages Timeline */}
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto chat-scroll chat-canvas-bg px-4 sm:px-6 py-5"
          onClick={() => setEmojiMenuFor(null)}
        >
          {loading ? (
            <div className="h-full flex items-center justify-center text-sm text-[#5D6D7E]">
              Loading conversation...
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6">
              <div className="w-56 aspect-[4/3] rounded-2xl overflow-hidden border border-[#E6EBF0] bg-[#F4F6F8] mb-5">
                <SafeImage
                  src={CHATTR_ASSETS.friendsConnectArt}
                  alt="Connected friends illustration"
                  className="w-full h-full object-cover"
                />
              </div>
              <h3 className="font-display text-lg font-semibold text-[#283747]">
                {friend.displayName}
              </h3>
              <p className="font-mono text-xs text-[#7895B2] mt-0.5">@{friend.username}</p>
              <p className="text-sm text-[#5D6D7E] mt-2.5 max-w-sm">
                You are connected as friends. Say hello below or start a voice or video call.
              </p>
              <div className="mt-5 flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => void onSendMessage(`Hey ${friend.displayName.split(' ')[0]}!`)}
                  className="h-10 px-4 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium transition-colors cursor-pointer"
                >
                  Say Hey
                </button>
                <button
                  type="button"
                  onClick={() => onStartCall(friend, 'voice')}
                  className="h-10 px-4 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] text-[#283747] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <Phone className="w-3.5 h-3.5 text-[#7895B2]" strokeWidth={1.6} />
                  <span>Voice Call</span>
                </button>
              </div>
            </div>
          ) : displayedMessages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center px-6 text-sm text-[#5D6D7E]">
              No messages matched &ldquo;{searchQuery.trim()}&rdquo;.
            </div>
          ) : (
            displayedMessages.map((msg, idx) => {
              const prev = idx > 0 ? displayedMessages[idx - 1] : null;
              const next = idx < displayedMessages.length - 1 ? displayedMessages[idx + 1] : null;

              const showDayDivider =
                !prev ||
                new Date(prev.createdAt).toDateString() !== new Date(msg.createdAt).toDateString();

              if (msg.kind === 'call_event') {
                return (
                  <div key={msg.id} id={`msg-${msg.id}`} className="my-4">
                    {showDayDivider && (
                      <div className="flex items-center gap-3 my-5">
                        <div className="flex-1 h-px bg-[#E6EBF0]" />
                        <span className="text-[11px] font-medium text-[#64748B]">
                          {formatDayDivider(msg.createdAt)}
                        </span>
                        <div className="flex-1 h-px bg-[#E6EBF0]" />
                      </div>
                    )}
                    <div className="flex items-center justify-center">
                      <div className="inline-flex items-center gap-2 py-1 text-xs text-[#5D6D7E] tabular-nums">
                        <Phone className="w-3.5 h-3.5 text-[#7895B2]" strokeWidth={1.6} />
                        <span>{msg.body}</span>
                        <span aria-hidden="true">·</span>
                        <span className="text-[#94A3B8]">{formatMessageTime(msg.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                );
              }

              const isMine = msg.senderId === currentUser.id;
              const isEditingThis = editingMsg?.id === msg.id;
              const groupedWithPrev =
                Boolean(prev) &&
                prev!.kind === 'text' &&
                prev!.senderId === msg.senderId &&
                !showDayDivider &&
                msg.createdAt - prev!.createdAt < 120_000;

              const groupedWithNext =
                Boolean(next) &&
                next!.kind === 'text' &&
                next!.senderId === msg.senderId &&
                new Date(next!.createdAt).toDateString() === new Date(msg.createdAt).toDateString() &&
                next!.createdAt - msg.createdAt < 120_000;

              const reactionEntries = Object.entries(msg.reactions || {}).filter(
                ([, users]) => users.length > 0
              );

              const showTimestamp =
                !groupedWithNext ||
                msg.id === lastOutgoingId ||
                reactionEntries.length > 0 ||
                Boolean(msg.editedAt);

              const bubbleRadiusClass = isMine
                ? `${groupedWithPrev ? 'rounded-tr-lg' : 'rounded-tr-2xl'} ${
                    groupedWithNext ? 'rounded-br-lg' : 'rounded-br-sm'
                  } rounded-l-2xl`
                : `${groupedWithPrev ? 'rounded-tl-lg' : 'rounded-tl-2xl'} ${
                    groupedWithNext ? 'rounded-bl-lg' : 'rounded-bl-sm'
                  } rounded-r-2xl`;

              return (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className={`${groupedWithPrev ? 'mt-1' : 'mt-3.5'} rounded-xl transition-colors duration-300 ${
                    highlightedMsgId === msg.id ? 'bg-[#7895B2]/10 -mx-2 px-2 py-1' : ''
                  }`}
                >
                  {showDayDivider && (
                    <div className="flex items-center gap-3 my-5">
                      <div className="flex-1 h-px bg-[#E6EBF0]" />
                      <span className="text-[11px] font-medium text-[#64748B]">
                        {formatDayDivider(msg.createdAt)}
                      </span>
                      <div className="flex-1 h-px bg-[#E6EBF0]" />
                    </div>
                  )}

                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                    className={`group flex flex-col ${isMine ? 'items-end' : 'items-start'}`}
                  >
                    {isEditingThis ? (
                      <form
                        onSubmit={submitEdit}
                        className="w-full max-w-md bg-[#F4F6F8] border border-[#7895B2] rounded-2xl p-2.5 space-y-2"
                      >
                        <textarea
                          rows={2}
                          autoFocus
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') setEditingMsg(null);
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              void submitEdit(e as unknown as FormEvent);
                            }
                          }}
                          className="w-full bg-[#FFFFFF] border border-[#E6EBF0] rounded-xl px-3 py-2 text-sm text-[#283747] focus:outline-none focus:border-[#7895B2] resize-none"
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => setEditingMsg(null)}
                            className="px-3 py-1 rounded-lg text-xs font-medium text-[#5D6D7E] hover:bg-[#E8EDF2] cursor-pointer"
                          >
                            Cancel
                          </button>
                          <button
                            type="submit"
                            className="px-3 py-1 rounded-lg text-xs font-medium bg-[#7895B2] hover:bg-[#6684A2] text-white cursor-pointer"
                          >
                            Save
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div
                        className={`relative flex items-end gap-1.5 max-w-[85%] sm:max-w-[70%] ${
                          isMine ? 'flex-row-reverse' : 'flex-row'
                        }`}
                      >
                        <div
                          className={`${bubbleRadiusClass} px-4 py-2.5 text-sm leading-relaxed break-words ${
                            isMine
                              ? 'bg-[#7895B2] text-white shadow-[0_1px_3px_rgba(40,55,71,0.12)]'
                              : 'bg-[#FFFFFF] text-[#283747] border border-[#E6EBF0] shadow-[0_1px_2px_rgba(40,55,71,0.04)]'
                          }`}
                        >
                          {msg.replyTo && (
                            <button
                              type="button"
                              onClick={() => scrollToMessage(msg.replyTo!.id)}
                              className={`w-full text-left mb-2 px-2.5 py-1.5 rounded-xl text-xs transition-opacity hover:opacity-90 cursor-pointer ${
                                isMine
                                  ? 'bg-white/15 text-white/95'
                                  : 'bg-[#FFFFFF] border border-[#E6EBF0] text-[#5D6D7E]'
                              }`}
                            >
                              <div className="font-medium opacity-90">
                                {msg.replyTo.senderId === currentUser.id
                                  ? 'You'
                                  : friend.displayName}
                              </div>
                              <div className="truncate">{msg.replyTo.body}</div>
                            </button>
                          )}
                          <div className="whitespace-pre-wrap">{msg.body}</div>
                        </div>

                        {/* Message hover actions */}
                        <div
                          className={`opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity flex items-center gap-0.5 shrink-0 ${
                            emojiMenuFor === msg.id ? 'opacity-100' : ''
                          }`}
                        >
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEmojiMenuFor((cur) => (cur === msg.id ? null : msg.id));
                            }}
                            className="w-8 h-8 rounded-xl flex items-center justify-center text-[#94A3B8] hover:text-[#283747] hover:bg-[#F4F6F8] cursor-pointer"
                            title="React"
                            aria-label="Add reaction"
                          >
                            <Smile className="w-4 h-4" strokeWidth={1.6} />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setReplyTo(msg);
                              textareaRef.current?.focus();
                            }}
                            className="w-8 h-8 rounded-xl flex items-center justify-center text-[#94A3B8] hover:text-[#283747] hover:bg-[#F4F6F8] cursor-pointer"
                            title="Reply"
                            aria-label="Reply to message"
                          >
                            <Reply className="w-4 h-4" strokeWidth={1.6} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCopyMessage(msg)}
                            className="w-8 h-8 rounded-xl flex items-center justify-center text-[#94A3B8] hover:text-[#283747] hover:bg-[#F4F6F8] cursor-pointer"
                            title="Copy text"
                            aria-label="Copy message"
                          >
                            {copiedId === msg.id ? (
                              <Check className="w-3.5 h-3.5 text-emerald-600" strokeWidth={1.7} />
                            ) : (
                              <Copy className="w-3.5 h-3.5" strokeWidth={1.6} />
                            )}
                          </button>
                          {isMine && (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingMsg(msg);
                                  setEditDraft(msg.body);
                                }}
                                className="w-8 h-8 rounded-xl flex items-center justify-center text-[#94A3B8] hover:text-[#283747] hover:bg-[#F4F6F8] cursor-pointer"
                                title="Edit message"
                                aria-label="Edit message"
                              >
                                <Pencil className="w-3.5 h-3.5" strokeWidth={1.6} />
                              </button>
                              <button
                                type="button"
                                onClick={() => onDeleteMessage(msg.id)}
                                className="w-8 h-8 rounded-xl flex items-center justify-center text-[#94A3B8] hover:text-red-600 hover:bg-red-50 cursor-pointer"
                                title="Delete message"
                                aria-label="Delete message"
                              >
                                <Trash2 className="w-4 h-4" strokeWidth={1.6} />
                              </button>
                            </>
                          )}
                        </div>

                        {/* Quick reaction popover */}
                        {emojiMenuFor === msg.id && (
                          <div
                            onClick={(e) => e.stopPropagation()}
                            className={`absolute -top-11 z-20 bg-[#FFFFFF] border border-[#E6EBF0] rounded-xl shadow-[0_2px_8px_rgba(40,55,71,0.08)] px-1.5 py-1 flex items-center gap-1 ${
                              isMine ? 'right-0' : 'left-0'
                            }`}
                          >
                            {QUICK_EMOJIS.map((em) => (
                              <button
                                key={em}
                                type="button"
                                onClick={() => {
                                  void onReactMessage(msg.id, em);
                                  setEmojiMenuFor(null);
                                }}
                                className="w-8 h-8 rounded-lg hover:bg-[#F4F6F8] flex items-center justify-center text-base cursor-pointer"
                              >
                                {em}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Reactions row */}
                    {reactionEntries.length > 0 && (
                      <div className="flex items-center gap-1 mt-1">
                        {reactionEntries.map(([emoji, users]) => {
                          const iReacted = users.includes(currentUser.id);
                          return (
                            <button
                              key={emoji}
                              type="button"
                              onClick={() => onReactMessage(msg.id, emoji)}
                              className={`px-2 py-0.5 rounded-full text-xs border flex items-center gap-1 transition-colors cursor-pointer tabular-nums ${
                                iReacted
                                  ? 'bg-[#7895B2]/12 border-[#7895B2]/40 text-[#283747]'
                                  : 'bg-[#FFFFFF] border-[#E6EBF0] text-[#5D6D7E] hover:bg-[#F4F6F8]'
                              }`}
                            >
                              <span>{emoji}</span>
                              <span>{users.length}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {/* Timestamp & Read receipt */}
                    {showTimestamp && (
                      <div className="flex items-center gap-1 mt-1 text-[11px] text-[#94A3B8] tabular-nums">
                        <span>{formatMessageTime(msg.createdAt)}</span>
                        {msg.editedAt && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>Edited</span>
                          </>
                        )}
                        {isMine && msg.id === lastOutgoingId && (
                          <>
                            <span aria-hidden="true">·</span>
                            {msg.readAt ? (
                              <span className="inline-flex items-center gap-0.5 text-[#7895B2]">
                                <CheckCheck className="w-3.5 h-3.5" strokeWidth={1.6} />
                                <span>Seen</span>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-0.5">
                                <Check className="w-3.5 h-3.5" strokeWidth={1.6} />
                                <span>Sent</span>
                              </span>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </motion.div>
                </div>
              );
            })
          )}

          {isTyping && (
            <div className="flex items-start mt-3">
              <div className="bg-[#FFFFFF] border border-[#E6EBF0] shadow-[0_1px_2px_rgba(40,55,71,0.04)] rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[#7895B2] animate-bounce [animation-delay:0ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#7895B2] animate-bounce [animation-delay:150ms]" />
                <span className="w-1.5 h-1.5 rounded-full bg-[#7895B2] animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>

        {/* Scroll-to-bottom Floating Button */}
        {showScrollBottom && (
          <button
            type="button"
            onClick={() => scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="absolute bottom-20 right-6 z-10 w-10 h-10 rounded-full bg-[#FFFFFF] border border-[#E6EBF0] shadow-[0_4px_12px_rgba(40,55,71,0.08)] flex items-center justify-center text-[#7895B2] hover:bg-[#F4F6F8] transition-colors cursor-pointer"
            title="Jump to latest"
            aria-label="Scroll to latest messages"
          >
            <ArrowDown className="w-4 h-4" strokeWidth={1.7} />
          </button>
        )}

        {/* Message Composer */}
        <footer className="border-t border-[#E6EBF0] bg-[#FFFFFF] px-4 sm:px-6 py-3 shrink-0">
          {replyTo && (
            <div className="mb-2.5 px-3 py-2 bg-[#F4F6F8] border border-[#E6EBF0] rounded-xl flex items-center justify-between gap-3">
              <div className="min-w-0 text-xs">
                <span className="font-medium text-[#283747]">
                  Replying to {replyTo.senderId === currentUser.id ? 'yourself' : friend.displayName}
                </span>
                <p className="text-[#5D6D7E] truncate mt-0.5">{replyTo.body}</p>
              </div>
              <button
                type="button"
                onClick={() => setReplyTo(null)}
                className="w-7 h-7 rounded-lg flex items-center justify-center text-[#5D6D7E] hover:text-[#283747] hover:bg-[#E8EDF2] cursor-pointer shrink-0"
                aria-label="Cancel reply"
              >
                <X className="w-4 h-4" strokeWidth={1.6} />
              </button>
            </div>
          )}

          {showComposerEmoji && (
            <div className="mb-2.5 flex items-center gap-1.5 flex-wrap">
              {['😀', '😂', '❤️', '👍', '🔥', '🎉', '🙌', '👀', '✨', '📞'].map((em) => (
                <button
                  key={em}
                  type="button"
                  onClick={() => {
                    handleDraftChange(draft + em);
                    textareaRef.current?.focus();
                  }}
                  className="w-9 h-9 rounded-xl bg-[#F4F6F8] hover:bg-[#E8EDF2] border border-[#E6EBF0] flex items-center justify-center text-base cursor-pointer"
                >
                  {em}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={submitMessage} className="flex items-end gap-2">
            <button
              type="button"
              onClick={() => setShowComposerEmoji((v) => !v)}
              className={`min-w-[44px] min-h-[44px] rounded-xl flex items-center justify-center transition-colors cursor-pointer shrink-0 ${
                showComposerEmoji
                  ? 'bg-[#7895B2]/15 text-[#7895B2]'
                  : 'bg-[#F4F6F8] text-[#5D6D7E] hover:bg-[#E8EDF2] hover:text-[#283747]'
              }`}
              aria-label="Toggle emoji tray"
            >
              <Smile className="w-5 h-5" strokeWidth={1.6} />
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              value={draft}
              onChange={(e) => handleDraftChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${friend.displayName}...`}
              className="flex-1 min-h-[44px] max-h-32 py-2.5 px-4 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-2xl text-sm text-[#283747] placeholder:text-[#94A3B8] resize-none focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20"
            />

            <button
              type="submit"
              disabled={!draft.trim() || sending}
              className="min-w-[44px] min-h-[44px] px-4 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] disabled:opacity-45 text-white text-sm font-medium flex items-center justify-center gap-1.5 transition-colors cursor-pointer shrink-0"
              aria-label="Send message"
            >
              <Send className="w-4 h-4" strokeWidth={1.6} />
              <span className="hidden sm:inline">Send</span>
            </button>
          </form>
        </footer>
      </div>

      {/* Friend Info Side Panel */}
      {showInfoPanel && (
        <aside className="hidden lg:flex w-72 border-l border-[#E6EBF0] bg-[#F4F6F8]/60 flex-col p-6 shrink-0">
          <div className="flex items-center justify-between mb-6">
            <h3 className="font-display text-sm font-semibold text-[#283747]">Contact Details</h3>
            <button
              type="button"
              onClick={() => setShowInfoPanel(false)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-[#5D6D7E] hover:text-[#283747] hover:bg-[#E8EDF2] cursor-pointer"
            >
              <X className="w-4 h-4" strokeWidth={1.6} />
            </button>
          </div>

          <div className="flex flex-col items-center text-center pb-6 border-b border-[#E6EBF0]">
            <Avatar
              name={friend.displayName}
              color={friend.avatarColor}
              size="xl"
              online={friend.online}
              inCall={friend.inCall}
              showPresence
            />
            <div className="font-display text-base font-semibold text-[#283747] mt-3.5">
              {friend.displayName}
            </div>
            <div className="font-mono text-xs text-[#7895B2] mt-0.5">@{friend.username}</div>
            {friend.bio && <p className="text-xs text-[#5D6D7E] mt-3 leading-relaxed">{friend.bio}</p>}
          </div>

          <div className="py-5 space-y-2.5 border-b border-[#E6EBF0]">
            <button
              type="button"
              onClick={() => onStartCall(friend, 'voice')}
              className="w-full h-10 px-3.5 rounded-xl bg-[#FFFFFF] border border-[#E6EBF0] hover:bg-[#F4F6F8] text-[#283747] text-xs font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Phone className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
              <span>Start Voice Call</span>
            </button>
            <button
              type="button"
              onClick={() => onStartCall(friend, 'video')}
              className="w-full h-10 px-3.5 rounded-xl bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Video className="w-4 h-4" strokeWidth={1.6} />
              <span>Start Video Call</span>
            </button>
          </div>

          <div className="py-4 text-xs text-[#5D6D7E] space-y-1.5">
            <div className="flex items-center gap-1.5 font-medium text-[#283747]">
              <ShieldCheck className="w-4 h-4 text-[#7895B2] shrink-0" strokeWidth={1.6} />
              <span>Connection Privacy</span>
            </div>
            <p className="leading-relaxed">
              Messages travel over HTTPS/WSS with friend-only access control. Voice and video calls use direct WebRTC DTLS-SRTP media encryption.
            </p>
          </div>

          <div className="mt-auto pt-4">
            {confirmRemove ? (
              <div className="space-y-2">
                <p className="text-xs text-[#5D6D7E] text-center">
                  Remove @{friend.username} from your friends?
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(false)}
                    className="h-9 rounded-xl bg-[#FFFFFF] border border-[#E6EBF0] text-xs font-medium text-[#5D6D7E] hover:bg-[#F4F6F8] cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void onRemoveFriend(friend.id)}
                    className="h-9 rounded-xl bg-red-600 hover:bg-red-700 text-xs font-medium text-white cursor-pointer"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRemove(true)}
                className="w-full h-10 px-3.5 rounded-xl text-xs font-medium text-red-600 hover:bg-red-50 flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <UserMinus className="w-4 h-4" strokeWidth={1.6} />
                <span>Remove Friend</span>
              </button>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
