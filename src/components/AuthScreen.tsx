import { useState, type FormEvent } from 'react';
import { ArrowRight, Lock, MessageSquare, PhoneCall, UserPlus } from 'lucide-react';
import { apiRequest, ApiError, setStoredToken } from '../lib/api.ts';
import type { PublicUser } from '../types.ts';

interface AuthScreenProps {
  onAuthenticated: (user: PublicUser, token: string) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const cleanUser = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(cleanUser)) {
      setError('Username must be 3–24 characters using letters, numbers, or underscores.');
      return;
    }
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const payload =
        mode === 'signup'
          ? { username: cleanUser, displayName: displayName.trim(), password }
          : { username: cleanUser, password };

      const data = await apiRequest<{ token: string; user: PublicUser }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setStoredToken(data.token);
      onAuthenticated(data.user, data.token);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Unable to reach server. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FFFFFF] text-[#283747] flex flex-col">
      <header className="w-full max-w-6xl mx-auto px-6 py-5 flex items-center justify-between gap-8 border-b border-[#E6EBF0]">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <img
            src="/assets/aistudio/Dusty_Blue_Chat_Bubble_Icon__1__dfe423b3.png"
            alt="Chattr logo"
            className="w-9 h-9 rounded-xl object-cover shrink-0"
          />
          <span className="font-display text-xl font-semibold tracking-tight text-[#283747]">
            Chattr
          </span>
        </div>
        <div className="text-xs text-[#64748B] whitespace-nowrap shrink-0">
          Private texting &amp; calling
        </div>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-10 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
        {/* Left Editorial Column */}
        <div className="lg:col-span-7 space-y-8">
          <div className="space-y-3.5">
            <h1 className="font-display text-4xl lg:text-5xl font-semibold tracking-tight text-[#283747] leading-[1.1] [text-wrap:balance]">
              Text and call friends with just a username.
            </h1>
            <p className="text-base text-[#5D6D7E] leading-relaxed max-w-xl">
              No email addresses or phone numbers required. Claim a handle, set a password, add friends, and start talking right away.
            </p>
          </div>

          <div className="rounded-2xl overflow-hidden border border-[#E6EBF0] bg-[#F4F6F8]">
            <div className="aspect-[16/9] overflow-hidden bg-[#F4F6F8]">
              <img
                src="/src/assets/images/auth_studio_scene_1794565019077.jpg"
                alt="Chattr clean modern desk workspace"
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </div>

            <div className="p-5 sm:p-6 bg-[#FFFFFF] border-t border-[#E6EBF0] grid grid-cols-1 sm:grid-cols-3 gap-5">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#283747]">
                  <UserPlus className="w-4 h-4 text-[#7895B2] shrink-0" strokeWidth={1.6} />
                  <span>Username Accounts</span>
                </div>
                <p className="text-xs text-[#5D6D7E] leading-relaxed">
                  Sign up in seconds with a handle and password.
                </p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#283747]">
                  <MessageSquare className="w-4 h-4 text-[#7895B2] shrink-0" strokeWidth={1.6} />
                  <span>Live Messaging</span>
                </div>
                <p className="text-xs text-[#5D6D7E] leading-relaxed">
                  Rounded bubbles, replies, reactions, and read status.
                </p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#283747]">
                  <PhoneCall className="w-4 h-4 text-[#7895B2] shrink-0" strokeWidth={1.6} />
                  <span>Voice &amp; Video</span>
                </div>
                <p className="text-xs text-[#5D6D7E] leading-relaxed">
                  Direct peer-to-peer calls with live audio controls.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Right Sign Up / Sign In Card */}
        <div className="lg:col-span-5">
          <div className="bg-[#FFFFFF] border border-[#E6EBF0] rounded-2xl p-6 sm:p-8 shadow-[0_1px_3px_rgba(40,55,71,0.04)] max-w-md w-full mx-auto lg:ml-auto lg:mr-0">
            <div className="flex items-center gap-1 p-1 bg-[#F4F6F8] rounded-xl mb-6">
              <button
                type="button"
                onClick={() => {
                  setMode('signup');
                  setError(null);
                }}
                className={`flex-1 py-2 px-4 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  mode === 'signup'
                    ? 'bg-[#FFFFFF] text-[#283747] shadow-[0_1px_2px_rgba(40,55,71,0.06)]'
                    : 'text-[#5D6D7E] hover:text-[#283747]'
                }`}
              >
                Create Account
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                }}
                className={`flex-1 py-2 px-4 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  mode === 'login'
                    ? 'bg-[#FFFFFF] text-[#283747] shadow-[0_1px_2px_rgba(40,55,71,0.06)]'
                    : 'text-[#5D6D7E] hover:text-[#283747]'
                }`}
              >
                Sign In
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label
                  htmlFor="auth-username"
                  className="block text-sm font-medium text-[#283747] mb-1.5"
                >
                  Username
                </label>
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#7895B2] font-mono text-sm select-none">
                    @
                  </span>
                  <input
                    id="auth-username"
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                    placeholder="alex_rivera"
                    maxLength={24}
                    required
                    className="w-full h-11 pl-8 pr-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm font-mono text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20 transition-colors"
                  />
                </div>
                <p className="mt-1 text-xs text-[#64748B]">
                  Letters, numbers, and underscores (3–24 chars).
                </p>
              </div>

              {mode === 'signup' && (
                <div>
                  <label
                    htmlFor="auth-displayname"
                    className="block text-sm font-medium text-[#283747] mb-1.5"
                  >
                    Display Name <span className="text-[#64748B] font-normal">(optional)</span>
                  </label>
                  <input
                    id="auth-displayname"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Alex Rivera"
                    maxLength={40}
                    className="w-full h-11 px-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20 transition-colors"
                  />
                </div>
              )}

              <div>
                <label
                  htmlFor="auth-password"
                  className="block text-sm font-medium text-[#283747] mb-1.5"
                >
                  Password
                </label>
                <div className="relative">
                  <Lock
                    className="w-4 h-4 text-[#7895B2] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                    strokeWidth={1.6}
                  />
                  <input
                    id="auth-password"
                    type="password"
                    autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="At least 4 characters"
                    required
                    className="w-full h-11 pl-10 pr-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20 transition-colors"
                  />
                </div>
              </div>

              {error && (
                <div
                  role="alert"
                  className="p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full h-11 px-4 bg-[#7895B2] hover:bg-[#6684A2] disabled:opacity-60 text-white text-sm font-medium rounded-xl flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                <span>{submitting ? 'Please wait...' : mode === 'signup' ? 'Create Account' : 'Sign In'}</span>
                <ArrowRight className="w-4 h-4" strokeWidth={1.6} />
              </button>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}
