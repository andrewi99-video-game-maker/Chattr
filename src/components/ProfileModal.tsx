import { useState, type FormEvent } from 'react';
import { Check, Copy, LogOut, X } from 'lucide-react';
import { apiRequest, ApiError } from '../lib/api.ts';
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

interface ProfileModalProps {
  user: PublicUser;
  onClose: () => void;
  onUpdated: (user: PublicUser) => void;
  onLogout: () => void;
}

export function ProfileModal({ user, onClose, onUpdated, onLogout }: ProfileModalProps) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio);
  const [avatarColor, setAvatarColor] = useState(user.avatarColor);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const data = await apiRequest<{ user: PublicUser }>('/api/auth/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName, bio, avatarColor }),
      });
      onUpdated(data.user);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save profile.');
    } finally {
      setSaving(false);
    }
  }

  function copyUsername() {
    navigator.clipboard?.writeText(user.username).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-[#283747]/25 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-[#FFFFFF] border border-[#E6EBF0] rounded-2xl shadow-[0_8px_24px_rgba(40,55,71,0.08)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-[#E6EBF0] flex items-center justify-between">
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

        <form onSubmit={handleSave} className="p-6 space-y-5">
          <div className="flex items-center gap-4">
            <Avatar name={displayName || user.username} color={avatarColor} size="xl" />
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-[#283747] truncate">
                {displayName || user.username}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="font-mono text-xs text-[#5D6D7E]">@{user.username}</span>
                <button
                  type="button"
                  onClick={copyUsername}
                  className="inline-flex items-center gap-1 text-xs font-medium text-[#7895B2] hover:text-[#5E7C99] cursor-pointer"
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
                disabled={saving}
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
