"use client";
import React, { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Page() {
  const [loading, setLoading] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleInsert() {
    setLoading(true);
    setInfo(null);
    setError(null);

    try {
      const { data, error: supabaseError } = await supabase
        .from("audits")
        .insert([{ project_name: "Test IFC", status: "OK" }]);

      if (supabaseError) {
        setError(supabaseError.message);
      } else {
        setInfo("Ligne insérée avec succès.");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ padding: 24 }}>
      <h1>Ajouter un audit de test</h1>
      <button onClick={handleInsert} disabled={loading}>
        {loading ? "Insertion..." : "Insérer une ligne de test"}
      </button>

      {info && <p style={{ color: "green" }}>{info}</p>}
      {error && <p style={{ color: "red" }}>Erreur : {error}</p>}
    </main>
  );
}