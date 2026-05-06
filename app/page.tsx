import React, { useState } from 'react';
import { 
  LayoutDashboard, Box, FileText, CheckCircle2, 
  Search, BarChart3, Bell, UserCircle, AlertCircle, CheckCircle
} from 'lucide-react';

export default function Dashboard() {
  const [showForm, setShowForm] = useState(false);

  // Simulation des données des maquettes (On les connectera à Supabase juste après)
  const maquettes = [
    { name: "ARCHI.ifc", status: "REUSSI", score: 98, color: "text-emerald-500", bg: "bg-emerald-50", icon: <CheckCircle className="text-emerald-500" /> },
    { name: "STRUCTURE.ifc", status: "AVERTISSEMENT", score: 72, color: "text-orange-500", bg: "bg-orange-50", icon: <AlertCircle className="text-orange-500" /> },
    { name: "MEP_HVAC.ifc", status: "CRITIQUE", score: 45, color: "text-red-500", bg: "bg-red-50", icon: <AlertCircle className="text-red-500" /> },
    { name: "ELECTRICAL.ifc", status: "REUSSI", score: 92, color: "text-emerald-500", bg: "bg-emerald-50", icon: <CheckCircle className="text-emerald-500" /> },
  ];

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
          </div>

          {/* STATS CARDS */}
          <div className="grid grid-cols-3 gap-6 mb-10">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Total des maquettes</p>
              <p className="text-4xl font-black mt-2">24 <span className="text-sm font-medium text-slate-400 ml-1 italic">IFC Actifs</span></p>
            </div>
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Erreurs Critiques</p>
              <p className="text-4xl font-black mt-2 text-red-500">12 <span className="text-sm font-medium text-slate-400 ml-1 italic">Sur 4 fichiers</span></p>
            </div>
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Score Qualité</p>
              <p className="text-4xl font-black mt-2 text-emerald-500">88% <span className="text-sm font-medium text-slate-400 ml-1 italic">Moyenne</span></p>
            </div>
          </div>

          {/* MAQUETTES FEDEREES SECTION */}
          <h3 className="text-xl font-bold mb-6">Maquettes Fédérées</h3>
          <div className="grid grid-cols-4 gap-6">
            {maquettes.map((m, i) => (
              <div key={i} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative overflow-hidden">
                <div className="flex justify-between items-start mb-4">
                  <div className={`p-2 rounded-full ${m.bg}`}>{m.icon}</div>
                  <span className={`text-[10px] font-bold px-2 py-1 rounded ${m.bg} ${m.color}`}>{m.status}</span>
                </div>
                <h4 className="font-bold text-slate-800">{m.name}</h4>
                <p className="text-[10px] text-slate-400 mb-4 italic">Mise à jour il y a 2h</p>
                <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                  <div className={`h-full ${m.color.replace('text', 'bg')}`} style={{ width: `${m.score}%` }}></div>
                </div>
                <div className="flex justify-end mt-1">
                   <span className={`text-[10px] font-bold ${m.color}`}>{m.score}%</span>
                </div>
              </div>
            ))}
          </div>
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
                <input type="text" placeholder="Ex: ARCHI_V2.ifc" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-orange-500 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Score (%)</label>
                  <input type="number" placeholder="0-100" className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase mb-1">Statut</label>
                  <select className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm">
                    <option>REUSSI</option>
                    <option>AVERTISSEMENT</option>
                    <option>CRITIQUE</option>
                  </select>
                </div>
              </div>
              <div className="flex space-x-3 pt-4">
                <button onClick={() => setShowForm(false)} className="flex-1 py-2.5 text-sm font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors">Annuler</button>
                <button className="flex-1 py-2.5 bg-slate-900 text-white text-sm font-bold rounded-lg hover:bg-slate-800 shadow-lg">Enregistrer</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}