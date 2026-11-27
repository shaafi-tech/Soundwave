// ============================================================================
// SoundWave — Email + Password auth (js/auth.js)
// ----------------------------------------------------------------------------
// Real accounts powered by Appwrite Account (email/password sessions).
//  • Sign up: the person picks their own email + password inside the app.
//    No verification email is requested or required.
//  • Log in:  email + password. The session is stored by the Appwrite SDK, so
//    the user stays logged in after a reload.
//  • Guest:   no session. Listening never needs an account.
// The signed-in user is cached in localStorage so the UI knows who you are
// instantly (and while offline); Appwrite re-confirms it in the background.
// ============================================================================
import { getAppwrite } from './appwrite-client.js?v=pro35';

const USER_CACHE_KEY = 'soundwave_session_v2';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD = 8; // Appwrite requires 8–256 characters
const MAX_PASSWORD = 256;

// ------------------------------------------------------------- local user cache
function readCachedUser() {
  try {
    const user = JSON.parse(localStorage.getItem(USER_CACHE_KEY) || 'null');
    return user && typeof user.id === 'string' && typeof user.email === 'string' ? user : null;
  } catch {
    return null;
  }
}

function writeCachedUser(user) {
  try {
    if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_CACHE_KEY);
  } catch {
    /* the session itself is still kept by the Appwrite SDK */
  }
}

let currentUser = readCachedUser();

function setUser(user) {
  currentUser = user;
  writeCachedUser(user);
}

const toUser = (acc) => ({ id: acc.$id, email: acc.email, username: acc.email, name: acc.name || '' });

export const getLocalUser = () => currentUser;

// ------------------------------------------------------------------ validation
export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function validateEmail(email) {
  if (!email) throw friendly('Please enter your email address.');
  if (!EMAIL_RE.test(email)) throw friendly('Enter a valid email address, like name@example.com.');
}

export function validatePassword(password) {
  const p = String(password || '');
  if (!p) throw friendly('Please enter your password.');
  if (p.length < MIN_PASSWORD) throw friendly(`Password must be at least ${MIN_PASSWORD} characters.`);
  if (p.length > MAX_PASSWORD) throw friendly(`Password must be ${MAX_PASSWORD} characters or fewer.`);
}

// ---------------------------------------------------------------------- errors
function friendly(message) {
  const err = new Error(message);
  err.friendly = true; // cloud.js friendlyError() shows these messages as they are
  return err;
}

function explain(err, mode) {
  if (err?.friendly) return err;

  const code = Number(err?.code) || 0;
  const type = String(err?.type || '');
  const msg = String(err?.message || err || '');

  if (/failed to fetch|networkerror|network request failed|load failed|did not load/i.test(msg)) {
    return friendly('Network problem. Check your internet connection and try again.');
  }
  if (code === 409 || type === 'user_already_exists') {
    return friendly('An account with this email already exists. Try logging in instead.');
  }
  if (type === 'user_invalid_credentials' || (code === 401 && mode === 'login')) {
    return friendly('Wrong email or password.');
  }
  if (type === 'user_blocked') return friendly('This account has been disabled.');
  if (code === 429) return friendly('Too many attempts. Wait a minute and try again.');
  if (code === 400 && /password/i.test(msg)) {
    return friendly(`Choose a stronger password (${MIN_PASSWORD}+ characters, not too common).`);
  }
  if (code === 400 && /email/i.test(msg)) return friendly('Enter a valid email address.');
  if (code === 403 || type === 'general_access_forbidden') {
    return friendly('Appwrite blocked this request. Add this app as a Web platform in the Appwrite Console.');
  }
  return friendly(msg || 'Something went wrong. Please try again.');
}

// --------------------------------------------------------------------- session
async function clearOldSession(account) {
  try {
    await account.deleteSession('current'); // only matters if a stale session exists
  } catch {
    /* guest: nothing to clear */
  }
}

async function startSession(account, email, password) {
  await account.createEmailPasswordSession(email, password);
  const user = toUser(await account.get());
  setUser(user);
  return user;
}

// Called once on app start: confirms the saved session with Appwrite.
export async function restoreSession() {
  try {
    const { account } = await getAppwrite();
    setUser(toUser(await account.get()));
  } catch (err) {
    // 401 = the session ended (or never existed): back to guest.
    // Anything else (offline, SDK blocked) keeps the cached user so offline use still works.
    if (Number(err?.code) === 401) setUser(null);
  }
  return currentUser;
}

export async function signUp(email, password) {
  email = normalizeEmail(email);
  validateEmail(email);
  validatePassword(password);

  try {
    const { sdk, account } = await getAppwrite();
    await clearOldSession(account);
    await account.create(sdk.ID.unique(), email, password); // no verification email is sent
    const user = await startSession(account, email, password);
    return { user, needsConfirmation: false };
  } catch (err) {
    throw explain(err, 'signup');
  }
}

export async function signIn(email, password) {
  email = normalizeEmail(email);
  validateEmail(email);
  validatePassword(password);

  try {
    const { account } = await getAppwrite();
    await clearOldSession(account);
    return await startSession(account, email, password);
  } catch (err) {
    throw explain(err, 'login');
  }
}

export async function signOut() {
  try {
    const { account } = await getAppwrite();
    await account.deleteSession('current');
  } catch {
    /* offline or already expired — still log out on this device */
  }
  setUser(null);
}
