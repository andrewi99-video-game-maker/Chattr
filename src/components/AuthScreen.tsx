import { useEffect, useState, type FormEvent } from 'react';
import { signInWithPopup, signOut } from 'firebase/auth';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  Lock,
  MessageSquare,
  PhoneCall,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import {
  apiRequest,
  ApiError,
  getLastUsername,
  setLastUsername,
  setStoredToken,
} from '../lib/api.ts';
import { CHATTR_ASSETS } from '../lib/assets.ts';
import { auth, googleProvider } from '../lib/firebase.ts';
import {
  claimUsernameAndSaveProfileFirestore,
  getUserProfileFirestore,
  isUsernameAvailableFirestore,
  normalizeUsername,
} from '../lib/firestoreChattr.ts';
import type { PublicUser } from '../types.ts';
import { CloudflareTurnstile } from './CloudflareTurnstile.tsx';
import { SafeImage } from './SafeImage.tsx';

const USERNAME_REGEX = /^[a-z0-9_.-]{3,24}$/;

interface AuthScreenProps {
  sessionNotice?: string | null;
  onAuthenticated: (user: PublicUser, token: string, authMode: 'local' | 'firebase') => void;
}

interface PendingGoogleSetup {
  uid: string;
  email: string;
  idToken: string;
  suggestedDisplayName: string;
}

export function AuthScreen({ sessionNotice, onAuthenticated }: AuthScreenProps) {
  const savedHandle = getLastUsername();
  const [mode, setMode] = useState<'signup' | 'login'>(savedHandle ? 'login' : 'signup');
  const [username, setUsername] = useState(savedHandle);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorSource, setErrorSource] = useState<'google' | 'form'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [pendingGoogle, setPendingGoogle] = useState<PendingGoogleSetup | null>(null);

  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileReset, setTurnstileReset] = useState(0);

  const [availability, setAvailability] = useState<{
    checking: boolean;
    available?: boolean;
    reason?: string;
  }>({ checking: false });

  const normalizedUsername = normalizeUsername(username);

  useEffect(() => {
    let active = true;
    fetch('/api/security/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { turnstileEnabled?: boolean; siteKey?: string | null } | null) => {
        if (!active || !data) return;
        setTurnstileSiteKey(data.turnstileEnabled && data.siteKey ? data.siteKey : null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const shouldCheckAvailability = mode === 'signup' || Boolean(pendingGoogle);

  useEffect(() => {
    if (!shouldCheckAvailability) {
      setAvailability({ checking: false });
      return;
    }
    if (!normalizedUsername) {
      setAvailability({ checking: false });
      return;
    }
    if (!USERNAME_REGEX.test(normalizedUsername)) {
      setAvailability({
        checking: false,
        available: false,
        reason:
          normalizedUsername.length < 3
            ? 'At least 3 characters required.'
            : 'Use only letters, numbers, _, ., or - (no spaces).',
      });
      return;
    }

    let active = true;
    setAvailability({ checking: true });
    const timer = window.setTimeout(async () => {
      try {
        const localCheck = await apiRequest<{ valid: boolean; available: boolean; reason?: string }>(
          `/api/auth/check-username?username=${encodeURIComponent(normalizedUsername)}`
        );
        if (!active) return;
        if (!localCheck.available) {
          setAvailability({
            checking: false,
            available: false,
            reason: localCheck.reason || 'That username is already taken.',
          });
          return;
        }

        // If Firebase-authenticated (during Google onboarding), also verify Firestore registry
        if (pendingGoogle && auth.currentUser) {
          const fsCheck = await isUsernameAvailableFirestore(normalizedUsername, pendingGoogle.uid);
          if (!active) return;
          setAvailability({
            checking: false,
            available: fsCheck.available,
            reason: fsCheck.reason,
          });
          return;
        }

        setAvailability({
          checking: false,
          available: localCheck.available,
          reason: localCheck.reason,
        });
      } catch {
        if (active) setAvailability({ checking: false });
      }
    }, 260);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [shouldCheckAvailability, normalizedUsername, pendingGoogle]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setErrorSource('form');

    if (!USERNAME_REGEX.test(normalizedUsername)) {
      setError('Username must be 3–24 characters using letters, numbers, underscores, dots, or hyphens.');
      return;
    }
    if (mode === 'signup' && availability.available === false) {
      setError(availability.reason || 'That username is already taken.');
      return;
    }
    if (password.length < 4) {
      setError('Password must be at least 4 characters.');
      return;
    }
    if (turnstileSiteKey && !turnstileToken) {
      setError('Please complete the Cloudflare security check.');
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = mode === 'signup' ? '/api/auth/signup' : '/api/auth/login';
      const payload =
        mode === 'signup'
          ? {
              username: normalizedUsername,
              displayName: displayName.trim(),
              password,
              turnstileToken,
            }
          : { username: normalizedUsername, password, turnstileToken };

      const data = await apiRequest<{ token: string; user: PublicUser }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      setStoredToken(data.token);
      setLastUsername(data.user.username);
      onAuthenticated({ ...data.user, authProvider: 'local' }, data.token, 'local');
    } catch (err) {
      if (turnstileSiteKey) setTurnstileReset((v) => v + 1);
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Unable to reach server. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogleSignIn() {
    setError(null);
    setErrorSource('google');
    setGoogleLoading(true);
    try {
      const cred = await signInWithPopup(auth, googleProvider);
      const idToken = await cred.user.getIdToken();
      const existingProfile = await getUserProfileFirestore(cred.user.uid).catch(() => null);

      const bridgeRes = await apiRequest<{
        needsUsernameSetup: boolean;
        token?: string;
        user?: PublicUser;
        suggestedUsername?: string;
        suggestedDisplayName?: string;
      }>('/api/auth/firebase', {
        method: 'POST',
        body: JSON.stringify({
          idToken,
          ...(existingProfile
            ? {
                username: existingProfile.username,
                displayName: existingProfile.displayName,
                bio: existingProfile.bio,
                avatarColor: existingProfile.avatarColor,
              }
            : {}),
        }),
      });

      if (bridgeRes.needsUsernameSetup || !existingProfile) {
        const defaultName =
          existingProfile?.displayName ||
          bridgeRes.suggestedDisplayName ||
          cred.user.displayName ||
          '';
        const defaultHandle = existingProfile?.username || bridgeRes.suggestedUsername || '';
        setUsername(defaultHandle);
        setDisplayName(defaultName);
        setPendingGoogle({
          uid: cred.user.uid,
          email: cred.user.email || '',
          idToken,
          suggestedDisplayName: defaultName,
        });
        return;
      }

      if (bridgeRes.token && bridgeRes.user) {
        setStoredToken(bridgeRes.token);
        setLastUsername(bridgeRes.user.username);
        onAuthenticated({ ...bridgeRes.user, authProvider: 'google' }, bridgeRes.token, 'firebase');
      }
    } catch (err) {
      const fbCode =
        err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (fbCode === 'auth/unauthorized-domain') {
        setError(
          `Google Sign-In is not authorized for "${window.location.hostname}" yet. Add this domain in Firebase Console → Authentication → Settings → Authorized domains.`
        );
      } else if (fbCode === 'auth/operation-not-allowed') {
        setError(
          'Google Sign-In is disabled in Firebase Console. Enable Google under Authentication → Sign-in method.'
        );
      } else if (fbCode === 'auth/popup-blocked') {
        setError('Your browser blocked the Google sign-in popup. Please allow popups for this site and try again.');
      } else if (fbCode === 'auth/popup-closed-by-user' || fbCode === 'auth/cancelled-popup-request') {
        setError('Google sign-in popup was closed before finishing.');
      } else if (fbCode === 'auth/network-request-failed') {
        setError('Network error while connecting to Google Sign-In. Please check your connection and retry.');
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Google sign-in could not be completed.');
      }
    } finally {
      setGoogleLoading(false);
    }
  }

  async function handleCompleteGoogleSetup(e: FormEvent) {
    e.preventDefault();
    if (!pendingGoogle) return;
    setError(null);

    if (!USERNAME_REGEX.test(normalizedUsername)) {
      setError('Username must be 3–24 characters using letters, numbers, underscores, dots, or hyphens.');
      return;
    }
    if (availability.available === false) {
      setError(availability.reason || 'That username is already taken.');
      return;
    }

    setSubmitting(true);
    try {
      const freshToken = (await auth.currentUser?.getIdToken()) || pendingGoogle.idToken;
      const fsProfile = await claimUsernameAndSaveProfileFirestore({
        uid: pendingGoogle.uid,
        email: pendingGoogle.email,
        username: normalizedUsername,
        displayName: displayName.trim() || pendingGoogle.suggestedDisplayName || normalizedUsername,
      });

      const bridgeRes = await apiRequest<{
        needsUsernameSetup: boolean;
        token?: string;
        user?: PublicUser;
      }>('/api/auth/firebase', {
        method: 'POST',
        body: JSON.stringify({
          idToken: freshToken,
          username: fsProfile.username,
          displayName: fsProfile.displayName,
          bio: fsProfile.bio,
          avatarColor: fsProfile.avatarColor,
        }),
      });

      if (!bridgeRes.token || !bridgeRes.user) {
        throw new Error('Could not initialize Chattr session.');
      }

      setStoredToken(bridgeRes.token);
      setLastUsername(bridgeRes.user.username);
      onAuthenticated({ ...bridgeRes.user, authProvider: 'google' }, bridgeRes.token, 'firebase');
    } catch (err) {
      setErrorSource('form');
      if (err instanceof ApiError) {
        setError(err.message);
      } else if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message) as { error?: string };
          setError(parsed.error || err.message);
        } catch {
          setError(err.message);
        }
      } else {
        setError('Could not save your username. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FFFFFF] text-[#283747] flex flex-col">
      <header className="w-full max-w-6xl mx-auto px-6 py-5 flex items-center justify-between gap-8 border-b border-[#E6EBF0]">
        <div className="flex items-center gap-2.5 whitespace-nowrap shrink-0">
          <div className="w-9 h-9 rounded-xl overflow-hidden shrink-0">
            <SafeImage
              src={CHATTR_ASSETS.logo}
              alt="Chattr logo"
              className="w-full h-full object-cover"
            />
          </div>
          <span className="font-display text-xl font-semibold tracking-tight text-[#283747]">
            Chattr
          </span>
        </div>
        <div className="text-xs text-[#64748B] whitespace-nowrap shrink-0 flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-[#7895B2]" strokeWidth={1.7} />
          <span>Protected by Cloudflare</span>
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
              Sign up with a unique handle and password or continue with Google. Add friends, message in real time, and start voice or video calls instantly.
            </p>
          </div>

          <div className="rounded-2xl overflow-hidden border border-[#E6EBF0] bg-[#F4F6F8]">
            <div className="aspect-[16/9] overflow-hidden bg-[#F4F6F8]">
              <SafeImage
                src={CHATTR_ASSETS.authStudioScene}
                alt="Chattr clean modern desk workspace"
                className="w-full h-full object-cover"
              />
            </div>

            <div className="p-5 sm:p-6 bg-[#FFFFFF] border-t border-[#E6EBF0] grid grid-cols-1 sm:grid-cols-3 gap-5">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#283747]">
                  <UserPlus className="w-4 h-4 text-[#7895B2] shrink-0" strokeWidth={1.6} />
                  <span>Unique Handles</span>
                </div>
                <p className="text-xs text-[#5D6D7E] leading-relaxed">
                  Join with username + password or Google Sign-In.
                </p>
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-xs font-semibold text-[#283747]">
                  <MessageSquare className="w-4 h-4 text-[#7895B2] shrink-0" strokeWidth={1.6} />
                  <span>Live Messaging</span>
                </div>
                <p className="text-xs text-[#5D6D7E] leading-relaxed">
                  Rounded bubbles, replies, edits, reactions, and read status.
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
            {sessionNotice && (
              <div className="mb-4 px-3.5 py-2.5 rounded-xl bg-[#F4F6F8] border border-[#E6EBF0] text-xs text-[#5D6D7E] leading-relaxed">
                {sessionNotice}
              </div>
            )}

            {pendingGoogle ? (
              <form onSubmit={handleCompleteGoogleSetup} className="space-y-4">
                <div className="flex items-center justify-between gap-2 pb-2 border-b border-[#E6EBF0]">
                  <div>
                    <h2 className="font-display text-lg font-semibold text-[#283747]">
                      Choose your handle
                    </h2>
                    <p className="text-xs text-[#5D6D7E] mt-0.5 truncate">
                      Signed in as {pendingGoogle.email || 'Google user'}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPendingGoogle(null);
                      setError(null);
                      void signOut(auth).catch(() => {});
                    }}
                    className="text-xs font-medium text-[#5D6D7E] hover:text-[#283747] inline-flex items-center gap-1 cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" strokeWidth={1.6} />
                    <span>Back</span>
                  </button>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <label
                      htmlFor="google-username"
                      className="block text-sm font-medium text-[#283747]"
                    >
                      Username
                    </label>
                    {normalizedUsername.length > 0 && (
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
                    <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#7895B2] font-mono text-sm select-none">
                      @
                    </span>
                    <input
                      id="google-username"
                      type="text"
                      autoFocus
                      value={username}
                      onChange={(e) => {
                        setUsername(e.target.value);
                        if (error) setError(null);
                      }}
                      placeholder="alex_rivera"
                      maxLength={25}
                      required
                      className="w-full h-11 pl-8 pr-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm font-mono text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20 transition-colors"
                    />
                  </div>
                  <p className="mt-1 text-xs text-[#64748B]">
                    Your handle is unique on Chattr. Friends can find you with @{normalizedUsername || 'handle'}.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="google-displayname"
                    className="block text-sm font-medium text-[#283747] mb-1.5"
                  >
                    Display Name
                  </label>
                  <input
                    id="google-displayname"
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Alex Rivera"
                    maxLength={40}
                    required
                    className="w-full h-11 px-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20 transition-colors"
                  />
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
                  disabled={submitting || availability.checking || availability.available === false}
                  className="w-full h-11 px-4 bg-[#7895B2] hover:bg-[#6684A2] disabled:opacity-60 text-white text-sm font-medium rounded-xl flex items-center justify-center gap-2 transition-colors cursor-pointer"
                >
                  <span>{submitting ? 'Saving account...' : 'Finish & Enter Chattr'}</span>
                  <ArrowRight className="w-4 h-4" strokeWidth={1.6} />
                </button>
              </form>
            ) : (
              <>
                <div className="flex items-center gap-1 p-1 bg-[#F4F6F8] rounded-xl mb-5">
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

                <button
                  type="button"
                  disabled={googleLoading || submitting}
                  onClick={() => void handleGoogleSignIn()}
                  className="w-full h-11 px-4 bg-[#FFFFFF] hover:bg-[#F4F6F8] border border-[#E6EBF0] text-[#283747] text-sm font-medium rounded-xl flex items-center justify-center gap-2.5 transition-colors cursor-pointer disabled:opacity-60"
                >
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      fill="#4285F4"
                      d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                    />
                  </svg>
                  <span>{googleLoading ? 'Connecting to Google...' : 'Continue with Google'}</span>
                </button>

                {error && errorSource === 'google' && (
                  <div
                    role="alert"
                    className="mt-3 p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 leading-relaxed"
                  >
                    {error}
                  </div>
                )}

                <div className="relative my-5">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-[#E6EBF0]" />
                  </div>
                  <div className="relative flex justify-center text-xs">
                    <span className="px-3 bg-[#FFFFFF] text-[#94A3B8]">or with username</span>
                  </div>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <label htmlFor="auth-username" className="block text-sm font-medium text-[#283747]">
                        Username
                      </label>
                      {mode === 'signup' && normalizedUsername.length > 0 && (
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
                      <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#7895B2] font-mono text-sm select-none">
                        @
                      </span>
                      <input
                        id="auth-username"
                        type="text"
                        autoComplete="username"
                        value={username}
                        onChange={(e) => {
                          setUsername(e.target.value);
                          if (error) setError(null);
                        }}
                        placeholder="alex_rivera"
                        maxLength={25}
                        required
                        className="w-full h-11 pl-8 pr-3.5 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm font-mono text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20 transition-colors"
                      />
                    </div>
                    <p className="mt-1 text-xs text-[#64748B]">
                      3–24 characters: letters, numbers, _, ., or -.
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
                        type={showPassword ? 'text' : 'password'}
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="At least 4 characters"
                        required
                        className="w-full h-11 pl-10 pr-10 bg-[#F4F6F8] border border-transparent focus:bg-[#FFFFFF] focus:border-[#7895B2] rounded-xl text-sm text-[#283747] placeholder:text-[#94A3B8] focus:outline-none focus:ring-2 focus:ring-[#7895B2]/20 transition-colors"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-[#5D6D7E] hover:text-[#283747] cursor-pointer"
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? (
                          <EyeOff className="w-4 h-4" strokeWidth={1.6} />
                        ) : (
                          <Eye className="w-4 h-4" strokeWidth={1.6} />
                        )}
                      </button>
                    </div>
                  </div>

                  <CloudflareTurnstile
                    siteKey={turnstileSiteKey}
                    resetSignal={turnstileReset}
                    onToken={setTurnstileToken}
                  />

                  {error && errorSource === 'form' && (
                    <div
                      role="alert"
                      className="p-3 rounded-xl bg-red-50 border border-red-200 text-sm text-red-700"
                    >
                      {error}
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={
                      submitting ||
                      googleLoading ||
                      (mode === 'signup' && (availability.checking || availability.available === false))
                    }
                    className="w-full h-11 px-4 bg-[#7895B2] hover:bg-[#6684A2] disabled:opacity-60 text-white text-sm font-medium rounded-xl flex items-center justify-center gap-2 transition-colors cursor-pointer"
                  >
                    <span>
                      {submitting ? 'Please wait...' : mode === 'signup' ? 'Create Account' : 'Sign In'}
                    </span>
                    <ArrowRight className="w-4 h-4" strokeWidth={1.6} />
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
