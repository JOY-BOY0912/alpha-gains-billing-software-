# FitFuel Supplements — Billing & Inventory

## Setup

```bash
npm install
cp .env.example .env
# edit .env with your Supabase project URL + publishable/anon key
npm run dev
```

## What's connected so far

Only authentication. Billing, products, stock, sales, and customer data are
still local mock data in `src/App.jsx` (V2), untouched by this change.

- `src/lib/supabaseClient.js` — the Supabase client, reading
  `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` from `.env`.
- `src/auth/AuthContext.jsx` — hydrates the session on load, keeps it in
  sync via `onAuthStateChange`, and exposes `signIn(username, password)` /
  `signOut()`.
- `src/auth/Login.jsx` — the username + password screen, styled to match
  the existing app.
- `src/main.jsx` — shows `Login` when there's no session, otherwise renders
  the existing app unchanged. A brief blank frame (not the login form)
  shows while the existing session is being restored on refresh.
- Logout lives in the existing sidebar profile menu, next to the role
  switcher.

## How sign-in works

1. User enters a **username** and password.
2. The app calls the Postgres RPC `get_login_email(username)` to resolve
   the real email tied to that username.
3. It signs in with `supabase.auth.signInWithPassword({ email, password })`.
4. On success, `onAuthStateChange` picks up the session and the app renders.

**One thing worth double checking on the Supabase side**, since I didn't
touch your database and can't verify this from here:

- **`get_login_email` needs to be callable by a signed-out visitor** (the
  `anon` role), since this RPC runs *before* login. If it reads from
  `auth.users` or a profiles table protected by RLS, it typically needs
  `SECURITY DEFINER` and an explicit
  `grant execute on function get_login_email(text) to anon;` — otherwise
  the lookup will silently fail and every login will show "Invalid
  username or password."

Both failure modes (unknown username, wrong password) intentionally show
the same generic error message, so the login form doesn't reveal which
usernames exist.

## Session persistence

Handled by supabase-js itself (`persistSession: true`, the default) — it
stores the session in `localStorage` and refreshes it automatically, so a
page refresh keeps the user logged in without any extra code here.
