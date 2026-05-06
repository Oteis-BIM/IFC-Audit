"use client";
import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { 
  LayoutDashboard, Box, CheckCircle2, 
  Search, BarChart3, Bell, UserCircle, AlertCircle, CheckCircle
} from 'lucide-react';

type Audit = {
  id: number;
  created_at: string;
  project_name: string;
  status: string;
  details: string | null;
};

export default function Dashboard() {
  const [showForm, setShowForm] = useState(false);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [projectName, setProjectName] = useState('');
  const [status, setStatus] = useState('OK');
  const [details, setDetails] = useState('');

  async function fetchAudits() {
    setLoading(true);
    const { data, error } = await supabase
      .from('audits')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) console.error(error);
    else setAudits(data || []);
    setLoading(false);
  }

  useEffect(() => { fetchAudits(); }, []);

  async function handleSave() {
    if (!projectName) return alert('Veuillez saisir un nom de maquette');
    const { error } = await supabase.from('audits').insert({
      project_name: projectName,
      status: status,
      details: details || null,
    });
    if (error) { alert('Erreur : ' + error.message); }
    else {
      setShowForm(false);
      setProjectName(''); setStatus('OK'); setDetails('');
      fetchAudits();
    }
  }

  const getStyle = (s: string) => {
    if (s === 'OK') return { color: 'text-emerald-500', bg: 'bg-emerald-50', label: 'RÉUSSI', icon: <CheckCircle className="text-emerald-500" /> };
    if (s === 'WARNING') return { color: 'text-orange-500', bg: 'bg-orange-50', label: 'AVERTISSEMENT', icon: <AlertCircle className="text-orange-500" /> };
    return { color: 'text-red-500', bg: 'bg-red-50', label: 'CRITIQUE', icon: <AlertCircle className="text-red-500" /> };
  };

  const nbCritiques = audits.filter(a => a.status === 'CRITICAL').length;
  const nbOk = audits.filter(a => a.status === 'OK').length;

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900">
      {/* SIDEBAR */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-6">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Contexte du projet</p>
          <h2 className="text-lg font-bold text-slate-800">Project Alpha</h2>
          <p className="text-xs text-slate-500 uppercase">QC Haute Précision</p>
        </div>
        <nav className="flex-1 px-4 space-y-1">
          <button className="w-full flex items-center px-4 py-3 text-sm font-medium bg-slate-100 text-blue-600 rounded-lg">
            <LayoutDashboard className="mr-3 h-5 w-5" /> Vue d'ensemble
          </button>
          {["Audit Géométrique", "Vérification des Métadonnées", "Gestionnaire de Collisions", "Validation"].map((item, i) => (
            <button key={i} className="w-full flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
              {i === 0 && <BarChart3 className="mr-3 h-5 w-5" />}
              {i === 1 && <Box className="mr-3 h-5 w-5" />}
              {i === 2 && <Search className="mr-3 h-5 w-5" />}
              {i === 3 && <CheckCircle2 className="mr-3 h-5 w-5" />}
              {item}
            </button>
          ))}
        </nav>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8">
          <div className="flex items-center space-x-2 text-slate-800 font-bold uppercase tracking-tight">
             <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center text-white text-[10px]">IFC</div>
             <span>IFC Quality Control</span>
          </div>
          <nav className="flex space-x-6 text-sm font-medium text-slate-500">
            <span className="text-blue-600 border-b-2 border-blue-600 py-5">Tableau de bord</span>
            {["Maquettes", "Rapports", "Conformité", "Paramètres"].map(t => <span key={t} className="py-5 cursor-pointer hover:text-slate-800">{t}</span>)}
          </nav>
          <div className="flex items-center space-x-4"><Bell className="h-5 w-5 text-slate-400" /><UserCircle className="h-6 w-6 text-slate-400" /></div>
        </header>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="flex justify-between items-end mb-8">
            <div>
              <h2 className="text-3xl font-bold text-slate-900">Statut des Maquettes</h2>
              <p className="text-slate-500">Indicateurs de performance globale du projet</p>
            </div>
            <button 
              onClick={() => setShowForm(true)}
              className="bg-[#f95700] hover:bg-orange-700 text-white px-6 py-2.5 rounded-lg font-bold text-sm flex items-center shadow-sm transition-all"
            >
              + Charger une nouvelle maquette
            </button>
          </div>          {/* STATS CARDS */}
          <div className="grid grid-cols-3 gap-6 mb-10">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total des maquettes</p>
              <p className="text-4xl font-black mt-2">{audits.length} <span className="text-sm font-medium text-slate-400 ml-1 italic">IFC Actifs</span></p>
            </div>
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Erreurs Critiques</p>
              <p className="text-4xl font-black mt-2 text-red-500">{nbCritiques} <span className="text-sm font-medium text-slate-400 ml-1 italic">fichiers</span></p>
            </div>
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Maquettes OK</p>
              <p className="text-4xl font-black mt-2 text-emerald-500">{nbOk} <span className="text-sm font-medium text-slate-400 ml-1 italic">validées</span></p>
            </div>
          </div>

          {/* MAQUETTES DEPUIS SUPABASE */}
          <h3 className="text-xl font-bold mb-6">Maquettes Fédérées</h3>
          {loading ? (
            <p className="text-slate-400 italic animate-pulse">Chargement depuis Supabase...</p>
          ) : audits.length === 0 ? (
            <p className="text-slate-400 italic">Aucune maquette. Cliquez sur &quot;+ Charger&quot; pour commencer.</p>
          ) : (
            <div className="grid grid-cols-4 gap-6">
              {audits.map((a) => {
                const style = getStyle(a.status);
                return (
                  <div key={a.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm">
                    <div className="flex justify-between items-start mb-4">
                      <div className={`p-2 rounded-full ${style.bg}`}>{style.icon}</div>
                      <span className={`text-[10px] font-bold px-2 py-1 rounded ${style.bg} ${style.color}`}>{style.label}</span>
                    </div>
                    <h4 className="font-bold text-slate-800">{a.project_name}</h4>
                    <p className="text-[10px] text-slate-400 mb-2 italic">
                      {new Date(a.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </p>
                    {a.details && <p className="text-xs text-slate-500 truncate">{a.details}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>

      {/* POPUP FORMULAIRE (S'affiche quand on clique sur le bouton orange) */}
      {showForm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
            <h3 className="text-xl font-bold mb-4 italic text-slate-800 underline decoration-orange-500 decoration-4">Nouvel Audit de Maquette</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Nom de la Maquette</label>
                <input type="text" value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="Ex: ARCHI_V2.ifc" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Score (%)</label>
                  <input type="number" placeholder="0-100" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                </div>                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Statut</label>
                  <select value={status} onChange={e => setStatus(e.target.value)} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm">
                    <option value="OK">✅ OK — Réussi</option>
                    <option value="WARNING">⚠️ WARNING — Avertissement</option>
                    <option value="CRITICAL">🔴 CRITICAL — Critique</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Détails (optionnel)</label>                <textarea value={details} onChange={e => setDetails(e.target.value)} placeholder="Notes ou observations..." rows={2} className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 outline-none resize-none" />
              </div>
              <div className="flex space-x-3 pt-4">
                <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-sm font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors">Annuler</button>
                <button onClick={handleSave} className="flex-1 py-2.5 bg-[#f95700] text-white text-sm font-bold rounded-lg hover:bg-orange-700 shadow-lg transition-colors">Enregistrer</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}