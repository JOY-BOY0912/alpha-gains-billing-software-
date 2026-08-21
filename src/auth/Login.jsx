import React, { useState } from "react";
import { IndianRupee, Loader2 } from "lucide-react";
import { useAuth } from "./AuthContext";

const inputClass =
  "w-full border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 placeholder:text-gray-400";

export default function Login() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError("");
    const { error: signInError } = await signIn(username, password);
    setSubmitting(false);
    if (signInError) setError(signInError);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-6">
          <div className="w-10 h-10 rounded-md bg-green-600 flex items-center justify-center mb-3">
            <IndianRupee size={18} className="text-white" />
          </div>
          <p className="text-lg font-semibold text-gray-900">FitFuel Supplements</p>
          <p className="text-sm text-gray-500 mt-0.5">Billing &amp; Inventory</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-6">
          <h1 className="text-base font-semibold text-gray-900 mb-4">Sign in</h1>
          <form onSubmit={handleSubmit}>
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Username</label>
              <input
                className={inputClass}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. store_owner"
                autoComplete="username"
                autoFocus
              />
            </div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 mb-1.5">Password</label>
              <input
                type="password"
                className={inputClass}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2 mb-4">{error}</p>
            )}

            <button
              type="submit"
              disabled={submitting || !username.trim() || !password}
              className="w-full inline-flex items-center justify-center gap-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2.5 rounded-md transition-colors"
            >
              {submitting && <Loader2 size={14} className="animate-spin" />}
              {submitting ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
