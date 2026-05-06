import React from 'react';
import { 
  LayoutDashboard, 
  Box, 
  FileText, 
  CheckCircle2, 
  Settings, 
  Search, 
  AlertTriangle, 
  BarChart3,
  Bell,
  UserCircle
} from 'lucide-react';

export default function Dashboard() {
  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900">
      {/* SIDEBAR GAUCHE - Inspirée de image_75f954.png */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-6">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Contexte du projet</p>
          <h2 className="text-lg font-bold text-slate-800">Project Alpha</h2>
          <p className="text-xs text-slate-500">QC Haute Précision</p>
        </div>

        <nav className="flex-1 px-4 space-y-1">
          <a href="#" className="flex items-center px-4 py-3 text-sm font-medium bg-slate-100 text-blue-600 rounded-lg">
            <LayoutDashboard className="mr-3 h-5 w-5" /> Vue d'ensemble
          </a>
          <a href="#" className="flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <BarChart3 className="mr-3 h-5 w-5" /> Audit Géométrique
          </a>
          <a href="#" className="flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <Box className="mr-3 h-5 w-5" /> Vérification des Métadonnées
          </a>
          <a href="#" className="flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <Search className="mr-3 h-5 w-5" /> Gestionnaire de Collisions
          </a>
          <a href="#" className="flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <CheckCircle2 className="mr-3 h-5 w-5" /> Validation
          </a>
        </nav>

        <div className="p-4 border-t border-slate-100">
          <div className="flex items-center p-2 space-x-3">
            <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-white text-xs font-bold">JD</div>
            <div>
              <p className="text-xs font-bold">Jean Dupont</p>
              <p className="text-[10px] text-slate-500">Responsable BIM</p>
            </div>
          </div>
        </div>
      </aside>

      {/* CONTENU PRINCIPAL */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* TOP NAVBAR - Inspirée de image_75f916.png */}
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8">
          <div className="flex items-center space-x-2">
            <div className="w-6 h-6 bg-blue-600 rounded"></div>
            <h1 className="font-bold tracking-tight text-slate-800">IFC QUALITY CONTROL</h1>
          </div>
          
          <nav className="hidden md:flex space-x-8 text-sm font-medium text-slate-500">
            <a href="#" className="text-blue-600 border-b-2 border-blue-600 pb-5 pt-5">Tableau de bord</a>
            <a href="#" className="hover:text-slate-800 pb-5 pt-5">Maquettes</a>
            <a href="#" className="hover:text-slate-800 pb-5 pt-5">Rapports</a>
            <a href="#" className="hover:text-slate-800 pb-5 pt-5">Conformité</a>
            <a href="#" className="hover:text-slate-800 pb-5 pt-5">Paramètres</a>
          </nav>

          <div className="flex items-center space-x-4">
            <Bell className="h-5 w-5 text-slate-400 cursor-pointer" />
            <UserCircle className="h-6 h-6 text-slate-400 cursor-pointer" />
          </div>
        </header>

        {/* ZONE DE TRAVAIL (SCROLLABLE) */}
        <div className="flex-1 overflow-y-auto p-8">
          <div className="flex justify-between items-end mb-8">
            <div>
              <h2 className="text-3xl font-bold text-slate-900">Statut des Maquettes</h2>
              <p className="text-slate-500">Indicateurs de performance globale du projet</p>
            </div>
            <button className="bg-orange-600 hover:bg-orange-700 text-white px-6 py-2.5 rounded-lg font-bold text-sm flex items-center transition-colors shadow-sm">
              <span className="mr-2 text-lg">+</span> Charger une nouvelle maquette
            </button>
          </div>

          {/* GRID DES STATISTIQUES - Inspirée de image_75f954.png */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-xs font-semibold text-slate-400 uppercase">Total des maquettes</p>
              <p className="text-4xl font-bold mt-2">24 <span className="text-sm font-normal text-slate-500">IFC Actifs</span></p>
            </div>
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-xs font-semibold text-slate-400 uppercase text-red-500">Erreurs Critiques</p>
              <p className="text-4xl font-bold mt-2 text-red-600">12 <span className="text-sm font-normal text-slate-500">Sur 4 fichiers</span></p>
            </div>
            <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
              <p className="text-xs font-semibold text-slate-400 uppercase">Score Qualité</p>
              <p className="text-4xl font-bold mt-2 text-emerald-500">88% <span className="text-sm font-normal text-slate-500">Moyenne</span></p>
            </div>
          </div>

          <div className="bg-white p-12 rounded-xl border-2 border-dashed border-slate-200 text-center">
            <p className="text-slate-400">Le reste du contenu (Maquettes Fédérées et Règles) sera ajouté ici...</p>
          </div>
        </div>
      </main>
    </div>
  );
}