const TOKEN_KEY = 'chattr_auth_token';
const LEGACY_TOKEN_KEY = 'relay_auth_token';
const LAST_USERNAME_KEY = 'chattr_last_username';
const SELECTED_FRIEND_KEY = 'chattr_selected_friend';

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    } else {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

export function getLastUsername(): string {
  try {
    return localStorage.getItem(LAST_USERNAME_KEY) || '';
  } catch {
    return '';
  }
}

export function setLastUsername(username: string): void {
  try {
    if (username.trim()) {
      localStorage.setItem(LAST_USERNAME_KEY, username.trim());
    }
  } catch {
    // ignore
  }
}

export function getStoredSelectedFriend(): string | null {
  try {
    return localStorage.getItem(SELECTED_FRIEND_KEY);
  } catch {
    return null;
  }
}

export function setStoredSelectedFriend(friendId: string | null): void {
  try {
    if (friendId) {
      localStorage.setItem(SELECTED_FRIEND_KEY, friendId);
    } else {
      localStorage.removeItem(SELECTED_FRIEND_KEY);
    }
  } catch {
    // ignore
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(typeof data.error === 'string' ? data.error : 'Request failed', res.status);
  }
  return data as T;
}
