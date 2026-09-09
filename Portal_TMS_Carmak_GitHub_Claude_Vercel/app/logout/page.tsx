"use client";

import { useEffect } from "react";

export default function LogoutPage() {
  useEffect(() => {
    fetch("/api/auth/logout", { method: "POST" })
      .catch(() => {})
      .finally(() => {
        window.location.replace("/login");
      });
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#06110d",
        color: "#a8b9ae",
        fontSize: "14px",
      }}
    >
      Saindo…
    </main>
  );
}
