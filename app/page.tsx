"use client";
export const dynamic = 'force-dynamic';
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { 
  LayoutDashboard, Box, CheckCircle2, 
  Search, BarChart3, Bell, UserCircle, AlertCircle, CheckCircle,
  Upload, X, FileBox
} from 'lucide-react';

type Audit = {
  id: number;
  created_at: string;
  project_name: string;
  status: string;
  details: string | null;
};

type SelectedFile = {
  file: File;
  status: 'OK' | 'WARNING' | 'CRITICAL';
  uploading: boolean;
  done: boolean;
  error: string | null;
};

export default function Dashboard() {
  const [showForm, setShowForm] = useState(false);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  useEffect(() => {
    fetchAudits();

    // Supabase Realtime : mise à jour automatique du tableau de bord
    const channel = supabase
      .channel('audits-realtime')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audits' }, () => {
        fetchAudits();
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  function addFiles(files: FileList | File[]) {
    const ifc = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.ifc'));
    if (ifc.length === 0) return alert('Seuls les fichiers .ifc sont acceptés');
    setSelectedFiles(prev => [
      ...prev,
      ...ifc.map(f => ({ file: f, status: 'OK' as const, uploading: false, done: false, error: null }))
    ]);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  }

  function removeFile(index: number) {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index));
  }

  function updateFileStatus(index: number, status: 'OK' | 'WARNING' | 'CRITICAL') {
    setSelectedFiles(prev => prev.map((f, i) => i === index ? { ...f, status } : f));
  }

  async function handleUploadAll() {
    if (selectedFiles.length === 0) return alert('Aucun fichier sélectionné');
    setUploading(true);

    for (let i = 0; i < selectedFiles.length; i++) {
      const sf = selectedFiles[i];
      setSelectedFiles(prev => prev.map((f, idx) => idx === i ? { ...f, uploading: true } : f));

      const path = `${Date.now()}_${sf.file.name}`;
      const { error: storageError } = await supabase.storage
        .from('ifc-files')
        .upload(path, sf.file);

      if (storageError) {
        setSelectedFiles(prev => prev.map((f, idx) => idx === i ? { ...f, uploading: false, error: storageError.message } : f));
        continue;
      }

      const { error: dbError } = await supabase.from('audits').insert({
        project_name: sf.file.name,
        status: sf.status,
        details: `Fichier uploadé : ${path}`,
      });

      setSelectedFiles(prev => prev.map((f, idx) => idx === i ? {
        ...f, uploading: false,
        done: !dbError,
        error: dbError ? dbError.message : null
      } : f));
    }

    setUploading(false);
    await fetchAudits();
    setTimeout(() => { setShowForm(false); setSelectedFiles([]); }, 1500);
  }

  const getStyle = (s: string) => {
    if (s === 'OK') return { color: 'text-emerald-500', bg: 'bg-emerald-50', label: 'RÉUSSI', icon: <CheckCircle className="text-emerald-500" /> };
    if (s === 'WARNING') return { color: 'text-orange-500', bg: 'bg-orange-50', label: 'AVERTISSEMENT', icon: <AlertCircle className="text-orange-500" /> };
    return { color: 'text-red-500', bg: 'bg-red-50', label: 'CRITIQUE', icon: <AlertCircle className="text-red-500" /> };
  };
  async function handleDelete(id: number) {
    if (!confirm('Supprimer cette maquette ?')) return;
    await supabase.from('audits').delete().eq('id', id);
    fetchAudits();
  }

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
            </div>            <button 
              onClick={() => setShowForm(true)}
              className="bg-[#f95700] hover:bg-orange-700 text-white px-6 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 shadow-sm transition-all"
            >
              <Upload className="h-4 w-4" /> + Charger une nouvelle maquette
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
                return (                  <div key={a.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative group">
                    <div className="flex justify-between items-start mb-4">
                      <div className={`p-2 rounded-full ${style.bg}`}>{style.icon}</div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold px-2 py-1 rounded ${style.bg} ${style.color}`}>{style.label}</span>                        <button
                          onClick={() => handleDelete(a.id)}
                          className="text-slate-300 hover:text-red-500 transition-colors"
                          title="Supprimer"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </div>
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
      </main>      {/* MODALE UPLOAD */}
      {showForm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-8">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-bold text-slate-800 underline decoration-orange-500 decoration-4">
                Charger des Maquettes IFC
              </h3>
              <button onClick={() => { setShowForm(false); setSelectedFiles([]); }} className="text-slate-400 hover:text-slate-700">
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* ZONE DRAG & DROP */}
            <div
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all mb-4 ${
                isDragging ? 'border-orange-500 bg-orange-50' : 'border-slate-200 hover:border-orange-400 hover:bg-slate-50'
              }`}
            >
              <Upload className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm font-semibold text-slate-600">Glissez vos fichiers <span className="text-orange-500">.ifc</span> ici</p>
              <p className="text-xs text-slate-400 mt-1">ou cliquez pour parcourir — sélection multiple autorisée</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".ifc"
                multiple
                className="hidden"
                onChange={e => e.target.files && addFiles(e.target.files)}
              />
            </div>

            {/* LISTE DES FICHIERS */}
            {selectedFiles.length > 0 && (
              <div className="space-y-2 max-h-48 overflow-y-auto mb-4">
                {selectedFiles.map((sf, i) => (
                  <div key={i} className="flex items-center gap-3 bg-slate-50 rounded-lg px-3 py-2 border border-slate-200">
                    <FileBox className="h-4 w-4 text-blue-500 shrink-0" />
                    <span className="text-xs font-medium text-slate-700 flex-1 truncate">{sf.file.name}</span>
                    <span className="text-xs text-slate-400">{(sf.file.size / 1024 / 1024).toFixed(1)} MB</span>
                    <select
                      value={sf.status}
                      onChange={e => updateFileStatus(i, e.target.value as 'OK' | 'WARNING' | 'CRITICAL')}
                      className="text-xs border border-slate-200 rounded px-1 py-0.5 bg-white"
                      disabled={sf.uploading || sf.done}
                    >
                      <option value="OK">✅ OK</option>
                      <option value="WARNING">⚠️ WARNING</option>
                      <option value="CRITICAL">🔴 CRITICAL</option>
                    </select>
                    {sf.done && <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />}
                    {sf.error && <span className="text-xs text-red-500 shrink-0" title={sf.error}>Erreur</span>}
                    {sf.uploading && <span className="text-xs text-orange-500 animate-pulse shrink-0">Upload...</span>}
                    {!sf.uploading && !sf.done && (
                      <button onClick={() => removeFile(i)} className="text-slate-300 hover:text-red-400">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="flex space-x-3">
              <button
                onClick={() => { setShowForm(false); setSelectedFiles([]); }}
                className="flex-1 py-2.5 text-sm font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
                disabled={uploading}
              >
                Annuler
              </button>
              <button
                onClick={handleUploadAll}
                disabled={uploading || selectedFiles.length === 0}
                className="flex-1 py-2.5 bg-[#f95700] text-white text-sm font-bold rounded-lg hover:bg-orange-700 shadow-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                <Upload className="h-4 w-4" />
                {uploading ? 'Upload en cours...' : `Uploader${selectedFiles.length > 0 ? ` (${selectedFiles.length})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}