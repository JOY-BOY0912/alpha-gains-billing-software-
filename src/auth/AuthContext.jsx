import React, { createContext, useContext, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Hydrate from whatever supabase-js already has in localStorage, then
    // keep in sync with future sign-in/out/refresh events.
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => listener.subscription.unsubscribe();
  }, []);

  // Step 1: look up the account's real email from its username via the
  // get_login_email RPC. Step 2: sign in with that email + the password.
  //
  // NOTE: this assumes the Postgres function is defined as
  //   get_login_email(p_username text) returns text
  // and is granted EXECUTE to the `anon` role (it has to be callable by a
  // signed-out visitor).
  async function signIn(username, password) {
    const { data: email, error: rpcError } = await supabase.rpc("get_login_email", {
      p_username: username.trim(),
    });

    // A function returning a single scalar comes back as `data` directly;
    // a function returning SETOF/TABLE comes back as an array of rows.
    // Handle both without assuming which one your RPC uses.
    const resolvedEmail = Array.isArray(email) ? email[0]?.email ?? email[0] : email;

    if (rpcError || !resolvedEmail) {
      // Deliberately generic — don't reveal whether the username exists.
      return { error: "Invalid username or password." };
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email: resolvedEmail,
      password,
    });

    if (error) {
      return { error: "Invalid username or password." };
    }

    setSession(data.session);
    return { error: null };
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSession(null);
  }

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    signIn,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
