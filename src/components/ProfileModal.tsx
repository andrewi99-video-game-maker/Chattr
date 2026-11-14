import { useEffect, useState, type FormEvent } from 'react';
import { Check, ChevronDown, Copy, Lock, LogOut, X } from 'lucide-react';
import { apiRequest, ApiError, setLastUsername } from '../lib/api.ts';
import { auth } from '../lib/firebase.ts';
import {
  claimUsernameAndSaveProfileFirestore,
  isUsernameAvailableFirestore,
} from '../lib/firestoreChattr.ts';
import type { PublicUser } from '../types.ts';
import { Avatar } from './Avatar.tsx';

const COLOR_SWATCHES = [
  '#7895B2',
  '#5E7C99',
  '#6B8E9B',
  '#4E6780',
  '#8C9BA8',
  '#3B5166',
  '#283747',
];

const USERNAME_REGEX = /^[a-z0-9_.-]{3,24}$/;

interface ProfileModalProps {
  user: PublicUser;
  authMode: 'local' | 'firebase';
  onClose: () => void;
  onUpdated: (user: PublicUser) => void;
  onLogout: () => void;
}

export function ProfileModal({ user, authMode, onClose, onUpdated, onLogout }: ProfileModalProps) {
  const [username, setUsername] = useState(user.username);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio);
  const [avatarColor, setAvatarColor] = useState(user.avatarColor);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showPasswordSection, setShowPasswordSection] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordStatus, setPasswordStatus] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [changingPassword, setChangingPassword] = useState(false);
  const [availability, setAvailability] = useState<{
    checking: boolean;
    available?: boolean;
    reason?: string;
  }>({ checking: false });

  const cleanUsername = username.trim().replace(/^@+/, '').toLowerCase();

  useEffect(() => {
    if (!cleanUsername || cleanUsername === user.username.toLowerCase()) {
      setAvailability({ checking: false });
      return;
    }
    if (!USERNAME_REGEX.test(cleanUsername)) {
      setAvailability({
        checking: false,
        available: false,
        reason:
          cleanUsername.length < 3
            ? 'At least 3 characters required.'
            : 'Use only letters, numbers, _, ., or -.',
      });
      return;
    }

    let active = true;
    setAvailability({ checking: true });
    const timer = window.setTimeout(async () => {
      try {
        const res = await apiRequest<{ valid: boolean; available: boolean; reason?: string }>(
          `/api/auth/check-username?username=${encodeURIComponent(cleanUsername)}&excludeUserId=${encodeURIComponent(user.id)}`
        );
        if (!active) return;
        if (!res.available) {
          setAvailability({ checking: false, available: false, reason: res.reason });
          return;
        }
        if (authMode === 'firebase' && auth.currentUser) {
          const fsRes = await isUsernameAvailableFirestore(cleanUsername, user.id);
          if (!active) return;
          setAvailability({ checking: false, available: fsRes.available, reason: fsRes.reason });
          return;
        }
        setAvailability({ checking: false, available: res.available, reason: res.reason });
      } catch {
        if (active) setAvailability({ checking: false });
      }
    }, 240);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [cleanUsername, user.id, user.username, authMode]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!USERNAME_REGEX.test(cleanUsername)) {
      setError('Username must be 3–24 characters using letters, numbers, underscores, dots, or hyphens.');
      return;
    }
    if (availability.available === false) {
      setError(availability.reason || 'That username is already taken.');
      return;
    }

    setSaving(true);
    try {
      if (authMode === 'firebase' && auth.currentUser) {
        await claimUsernameAndSaveProfileFirestore({
          uid: user.id,
          email: auth.currentUser.email || '',
          username: cleanUsername,
          displayName,
          bio,
          avatarColor,
        });
      }

      const data = await apiRequest<{ user: PublicUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          username: cleanUsername,
          displayName,
          bio,
          avatarColor,
        }),
      });
      setLastUsername(data.user.username);
      onUpdated({ ...data.user, authProvider: authMode === 'firebase' ? 'google' : 'local' });
      onClose();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
          ? err.message
          : 'Failed to save profile.'
      );
    } finally {
      setSaving(false);
    }
  }

  async function handlePasswordSave() {
    setPasswordStatus(null);
    if (!currentPassword || newPassword.length < 4) {
      setPasswordStatus({ type: 'err', text: 'Enter your current password and a new 4+ character password.' });
      return;
    }
    setChangingPassword(true);
    try {
      await apiRequest('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword('');
      setNewPassword('');
      setPasswordStatus({ type: 'ok', text: 'Password updated.' });
    } catch (err) {
      setPasswordStatus({
        type: 'err',
        text: err instanceof ApiError ? err.message : 'Could not update password.',
      });
    } finally {
      setChangingPassword(false);
    }
  }

  function copyUsername() {
    navigator.clipboard?.writeText(`@${cleanUsername || user.username}`).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-[#283747]/25 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#FFFFFF] border border-[#E6EBF0] rounded-2xl shadow-[0_8px_24px_rgba(40,55,71,0.08)] overflow-hidden max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[#E6EBF0] flex items-center justify-between shrink-0">
          <h2 className="font-display text-lg font-semibold text-[#283747]">Your Profile</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-xl text-[#5D6D7E] hover:bg-[#F4F6F8] hover:text-[#283747] transition-colors cursor-pointer"
            aria-label="Close profile settings"
          >
            <X className="w-5 h-5" strokeWidth={1.6} />
          </button>
        </div>

        <form onSubmit={handleSave} className="p-6 space-y-5 overflow-y-auto chat-scroll">
          <div className="flex items-center gap-4">
            <Avatar name={displayName || cleanUsername || user.username} color={avatarColor} size="xl" />
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-[#283747] truncate">
                {displayName || cleanUsername || user.username}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-mono text-xs text-[#5D6D7E] truncate">
                  @{cleanUsername || user.username}
                </span>
                <button
                  type="button"
                  onClick={copyUsername}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#7895B2] hover:text-[#5E7C99] cursor-pointer shrink-0"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5" strokeWidth={1.6} />
                  ) : (
                    <Copy className="w-3.5 h-3.5" strokeWidth={1.6} />
                  )}
                  <span>{copied ? 'Copied' : 'Copy handle'}</span>
                </button>
              </div>
            </div>
          </div>

          <div>
            <span className="block text-sm font-medium text-[#283747] mb-2">Avatar Color</span>
            <div className="flex items-center gap-2.5 flex-wrap">
              {COLOR_SWATCHES.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  onClick={() => setAvatarColor(swatch)}
                  className={`w-9 h-9 rounded-full flex items-center justify-center transition-transform cursor-pointer ${
                    avatarColor === swatch ? 'ring-2 ring-offset-2 ring-[#7895B2] scale-105' : 'hover:scale-105'
                  }`}
                  style={{ backgroundColor: swatch }}
                  aria-label={`Select color ${swatch}`}
                >
                  {avatarColor === swatch && <Check className="w-4 h-4 text-white" strokeWidth={1.8} />}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <label htmlFor="profile-username" className="block text-sm font-medium text-[#283747]">
                Username
              </label>
              {cleanUsername && cleanUsername !== user.username.toLowerCase() && (
                <span
                  className={`text-xs font-medium ${
                    availability.checking
                      ? 'text-[#64748B]'
                      : availability.available
                      ? 'text-emerald-600 inline-flex items-center gap-1'
                      : 'text-red-600'
                  }`}
                >
                  {availability.checking ? (
                    'Checking...'
                  ) : availability.available ? (
                    <>
                      <Check className="w-3.5 h-3.5" strokeWidth={1.8} />
                      <span>Available</span>
                    </>
                  ) : (
                    availability.reason || ''
                  )}
                </span>
              )}
            </div>
            <div className="relative">
              <span className="absolute left-3.5 top-1/2 -translate-y-1/2 font-mono text-sm text-[#7895B2]">
                @
              </span>
              <input
                id="profile-username"
                type="text"
                value={username}
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (error) setError(null);
                }}
                maxLength={25}
                required
                className="w-full h-10 pl-8 pr-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm font-mono text-[#283747] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="profile-display-name"
              className="block text-sm font-medium text-[#283747] mb-1.5"
            >
              Display Name
            </label>
            <input
              id="profile-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              required
              className="w-full h-10 px-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm text-[#283747] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20"
            />
          </div>

          <div>
            <label htmlFor="profile-bio" className="block text-sm font-medium text-[#283747] mb-1.5">
              Status Note
            </label>
            <input
              id="profile-bio"
              type="text"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Available for calls, studying, etc."
              maxLength={140}
              className="w-full h-10 px-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20"
            />
          </div>

          {/* Collapsible Password Update (for username+password accounts) */}
          {authMode === 'firebase' ? (
            <div className="border-t border-[#E6EBF0] pt-4 text-xs text-[#5D6D7E] flex items-center justify-between">
              <span>Account authentication</span>
              <span className="font-medium text-[#283747]">Google Sign-In</span>
            </div>
          ) : (
            <div className="border-t border-[#E6EBF0] pt-4">
              <button
                type="button"
                onClick={() => setShowPasswordSection((v) => !v)}
                className="w-full flex items-center justify-between text-sm font-medium text-[#283747] hover:text-[#7895B2] transition-colors cursor-pointer"
              >
                <span className="inline-flex items-center gap-2">
                  <Lock className="w-4 h-4 text-[#7895B2]" strokeWidth={1.6} />
                  <span>Change Password</span>
                </span>
                <ChevronDown
                  className={`w-4 h-4 text-[#5D6D7E] transition-transform ${
                    showPasswordSection ? 'rotate-180' : ''
                  }`}
                  strokeWidth={1.6}
                />
              </button>

              {showPasswordSection && (
                <div className="mt-3 space-y-2.5 p-3.5 rounded-xl bg-[#F4F6F8] border border-[#E6EBF0]">
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Current password"
                    className="w-full h-9 px-3 bg-[#FFFFFF] border border-[#E6EBF0] focus:border-[#7895B2] rounded-lg text-xs text-[#283747] focus:outline-none"
                  />
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="New password (4+ characters)"
                    className="w-full h-9 px-3 bg-[#FFFFFF] border border-[#E6EBF0] focus:border-[#7895B2] rounded-lg text-xs text-[#283747] focus:outline-none"
                  />
                  {passwordStatus && (
                    <p
                      className={`text-xs font-medium ${
                        passwordStatus.type === 'ok' ? 'text-emerald-700' : 'text-red-600'
                      }`}
                    >
                      {passwordStatus.text}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={changingPassword}
                    onClick={() => void handlePasswordSave()}
                    className="h-9 px-3.5 rounded-lg bg-[#7895B2] hover:bg-[#6684A2] text-white text-xs font-medium transition-colors cursor-pointer"
                  >
                    {changingPassword ? 'Updating...' : 'Update Password'}
                  </button>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="pt-2 border-t border-[#E6EBF0] flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={onLogout}
              className="min-h-[40px] px-3.5 py-2 rounded-xl text-sm font-medium text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors cursor-pointer"
            >
              <LogOut className="w-4 h-4" strokeWidth={1.6} />
              <span>Sign Out</span>
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[40px] px-4 py-2 rounded-xl text-sm font-medium text-[#5D6D7E] hover:bg-[#F4F6F8] hover:text-[#283747] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || availability.checking || availability.available === false}
                className="min-h-[40px] px-4 py-2 rounded-xl text-sm font-medium text-white bg-[#7895B2] hover:bg-[#6684A2] disabled:opacity-60 transition-colors cursor-pointer"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
