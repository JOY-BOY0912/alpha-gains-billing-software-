import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import Login from "./auth/Login";
import App from "./App";

function Root() {
  const { session, loading } = useAuth();

  if (loading) {
    // Same neutral background as the rest of the app, just no flash of the
    // login form while we check for an existing session on refresh.
    return <div className="min-h-screen bg-gray-50" />;
  }

  return session ? <App /> : <Login />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </React.StrictMode>
);
