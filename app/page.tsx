"use client";
export const dynamic = 'force-dynamic';
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import {   LayoutDashboard, Layers, Compass, Database, Settings2,
  Bell, UserCircle, AlertCircle, CheckCircle,
  Upload, X, FileBox, Eye, Loader2
} from 'lucide-react';
import NextDynamic from 'next/dynamic';
import type { FileEntry } from './components/IfcViewer';

const IfcViewer = NextDynamic(() => import('./components/IfcViewer'), { ssr: false });

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
  progress: number; // progression 0-100 par fichier
};

export default function Dashboard() {  const [showForm, setShowForm] = useState(false);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);  const [isDragging, setIsDragging] = useState(false);  const [uploading, setUploading] = useState(false);  const [viewerFiles, setViewerFiles] = useState<FileEntry[]>([]);
  const [boxReady, setBoxReady] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Audit | null>(null);
  const [deleting, setDeleting] = useState(false);
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
  }  useEffect(() => {
    fetchAudits();
    // Vérifier si déjà connecté à Box
    fetch('/api/box/token').then(r => {
      if (r.ok) setBoxReady(true);
    });
    // Au retour depuis Box OAuth, rouvrir la modale automatiquement
    if (localStorage.getItem('box_auth_return') === '1') {
      localStorage.removeItem('box_auth_return');
      setBoxReady(true);
      setShowForm(true);
    }

    // Supabase Realtime: mise à jour automatique du tableau de bord
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
    if (ifc.length === 0) return alert('Seuls les fichiers .ifc sont acceptés');    setSelectedFiles(prev => [
      ...prev,
      ...ifc.map(f => ({ file: f, status: 'OK' as const, uploading: false, done: false, error: null, progress: 0 }))
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

  async function uploadToBoxDirect(
    file: File,
    accessToken: string,
    folderId: string,
    onProgress?: (pct: number) => void
  ): Promise<string> {
    const CHUNK_SIZE = 8 * 1024 * 1024;
    const fileSize = file.size;    if (fileSize <= 50 * 1024 * 1024) {
      // Simple upload — simulation progression pendant le fetch
      onProgress?.(10);
      const boxForm = new FormData();
      boxForm.append('attributes', JSON.stringify({ name: file.name, parent: { id: folderId } }));
      boxForm.append('file', file);

      // Progression simulée toutes les 300ms pendant l'upload
      let pct = 10;
      const ticker = setInterval(() => {
        pct = Math.min(90, pct + 8);
        onProgress?.(pct);
      }, 300);

      try {
        const res = await fetch('https://upload.box.com/api/2.0/files/content', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}` },
          body: boxForm,
        });
        clearInterval(ticker);
        const data = await res.json();
        const id = data.entries?.[0]?.id;
        if (!id) throw new Error(`Upload simple Box échoué : ${JSON.stringify(data)}`);
        onProgress?.(100);
        return id;
      } catch (e) {
        clearInterval(ticker);
        throw e;
      }
    }// Chunked upload — lecture chunk par chunk sans charger tout le fichier en RAM
    const sessionRes = await fetch('https://upload.box.com/api/2.0/files/upload_sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder_id: folderId, file_size: fileSize, file_name: file.name }),
    });    const session = await sessionRes.json();
    if (!session.id) throw new Error(`Session Box échouée : ${JSON.stringify(session)}`);
    const uploadUrl = session.session_endpoints?.upload_part;
    const commitUrl = session.session_endpoints?.commit;
    // Box impose la taille de chunk via part_size (varie selon la taille du fichier)
    const partSize: number = session.part_size ?? CHUNK_SIZE;
    const parts: { part_id: string; offset: number; size: number }[] = [];
    const totalChunks = Math.ceil(fileSize / partSize);// Hash SHA-1 incrémental du fichier complet (évite de tout garder en RAM)
    // js-sha1 est un module CJS → module.exports = fn, donc default = fn
    const sha1Mod = await import('js-sha1');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sha1Fn = (sha1Mod as any).sha1 ?? (sha1Mod as any).default ?? sha1Mod;
    const fullHasher = sha1Fn.create();    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      const chunkOffset = chunkIndex * partSize;
      const end = Math.min(chunkOffset + partSize, fileSize);
      const blob = file.slice(chunkOffset, end);
      const chunk = await blob.arrayBuffer();

      // Hash du chunk individuel pour l'en-tête Digest
      const chunkHashBuffer = await crypto.subtle.digest('SHA-1', chunk);
      const sha1Base64 = btoa(String.fromCharCode(...new Uint8Array(chunkHashBuffer)));

      // Mise à jour du hash incrémental global
      fullHasher.update(chunk);

      const partRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          'Content-Range': `bytes ${chunkOffset}-${end - 1}/${fileSize}`,
          'Digest': `sha=${sha1Base64}`,
        },
        body: chunk,
      });

      if (!partRes.ok) {
        const errText = await partRes.text();
        throw new Error(`Erreur chunk ${chunkIndex + 1}/${totalChunks} : ${errText}`);
      }
      const partData = await partRes.json();
      if (!partData.part) throw new Error(`Part manquante chunk ${chunkIndex + 1} : ${JSON.stringify(partData)}`);
      parts.push(partData.part);
      // Progression : les chunks représentent 90% du travail
      onProgress?.(Math.round(((chunkIndex + 1) / totalChunks) * 90));
    }

    onProgress?.(92);
    // Finalisation du hash SHA-1 complet (sans aucune copie mémoire du fichier entier)
    const fullSha1Hex = fullHasher.hex();
    const fullSha1Base64 = btoa(fullSha1Hex.match(/.{2}/g)!.map((b: string) => String.fromCharCode(parseInt(b, 16))).join(''));

    // Commit
    const commitRes = await fetch(commitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Digest': `sha=${fullSha1Base64}`,
      },
      body: JSON.stringify({ parts: parts.map(p => ({ part_id: p.part_id, offset: p.offset, size: p.size })) }),
    });

    // Box renvoie 202 si le traitement est encore en cours → polling
    if (commitRes.status === 202) {
      const sessionStatusUrl = `https://upload.box.com/api/2.0/files/upload_sessions/${session.id}`;
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(r => setTimeout(r, 3000));
        const statusRes = await fetch(sessionStatusUrl, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (statusRes.status === 200) {
          // La session existe toujours, pas encore finie
          continue;
        }
        if (statusRes.status === 404) {
          // Session supprimée = commit terminé, on cherche le fichier par nom
          break;
        }
      }
      // Rechercher le fichier créé dans le dossier Box
      const searchRes = await fetch(
        `https://api.box.com/2.0/folders/${folderId}/items?fields=id,name&limit=10`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const searchData = await searchRes.json();
      const found = searchData.entries?.find((e: { name: string; id: string }) => e.name === file.name);
      if (!found?.id) throw new Error(`Fichier introuvable après commit Box (202).`);
      onProgress?.(100);
      return found.id;
    }

    if (!commitRes.ok) {
      const errText = await commitRes.text();
      throw new Error(`Commit Box échoué (${commitRes.status}) : ${errText}`);
    }

    const commitData = await commitRes.json();
    const id = commitData.entries?.[0]?.id ?? commitData?.id;
    if (!id) throw new Error(`ID introuvable après commit : ${JSON.stringify(commitData)}`);
    onProgress?.(100);
    return id;
  }  // Ouvre Box OAuth dans une popup et attend que le token soit disponible (polling)
  function openBoxAuthPopup(): Promise<void> {
    return new Promise((resolve, reject) => {
      const popup = window.open('/api/box/auth?popup=1', 'box_auth', 'width=600,height=700,left=300,top=100');
      if (!popup) { reject(new Error('Popup bloquée. Autorisez les popups pour ce site.')); return; }

      let elapsed = 0;
      const interval = setInterval(async () => {
        elapsed += 2000;
        try {
          const res = await fetch('/api/box/token');
          if (res.ok) {
            const data = await res.json();
            if (data.accessToken) {
              clearInterval(interval);
              setBoxReady(true);
              popup.close();
              resolve();
              return;
            }
          }
        } catch { /* ignore */ }
        if (elapsed >= 5 * 60 * 1000) {
          clearInterval(interval);
          popup.close();
          reject(new Error('Timeout connexion Box (5 min).'));
        }
      }, 2000);
    });
  }
  // Connexion Box : redirige toute la page vers Box, revient automatiquement
  function handleConnectBox() {
    localStorage.setItem('box_auth_return', '1');
    window.location.href = '/api/box/auth';
  }  async function handleUploadAll() {
    if (selectedFiles.length === 0) return alert('Aucun fichier sélectionné');
    if (uploading) return;

    // Vérification initiale de la connexion Box
    const tokenCheck = await fetch('/api/box/token');
    if (!tokenCheck.ok) {
      return alert('Veuillez d\'abord vous connecter à Box en cliquant sur le bouton "Connecter à Box".');
    }
    const { folderId } = await tokenCheck.json();    setUploading(true);
    let allDone = true;

    for (let i = 0; i < selectedFiles.length; i++) {
      const sf = selectedFiles[i];
      setSelectedFiles(prev => prev.map((f, idx) => idx === i ? { ...f, uploading: true, error: null, progress: 0 } : f));

      try {
        // Récupérer un token frais pour chaque fichier (évite les tokens expirés entre uploads)
        const freshTokenRes = await fetch('/api/box/token');
        if (!freshTokenRes.ok) throw new Error('Session Box expirée. Reconnectez-vous.');
        const { accessToken: freshToken } = await freshTokenRes.json();
        if (!freshToken) throw new Error('Token Box manquant.');

        // Upload direct navigateur → Box
        const boxFileId = await uploadToBoxDirect(sf.file, freshToken, folderId, (pct) => {
          setSelectedFiles(prev => prev.map((f, idx) => idx === i ? { ...f, progress: pct } : f));
        });

        // Créer le lien de partage
        const slRes = await fetch('/api/box/shared-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId: boxFileId }),
        });
        const slData = await slRes.json();
        const downloadUrl = slData.downloadUrl || '';

        // Insérer en base Supabase
        const { error: dbError } = await supabase.from('audits').insert({
          project_name: sf.file.name,
          status: sf.status,
          details: `box:${boxFileId}:${downloadUrl}`,
        });

        if (dbError) throw new Error(`Erreur Supabase : ${dbError.message}`);

        setSelectedFiles(prev => prev.map((f, idx) => idx === i ? { ...f, uploading: false, done: true } : f));

      } catch (err: unknown) {
        allDone = false;
        const message = err instanceof Error ? err.message : 'Erreur inconnue';
        setSelectedFiles(prev => prev.map((f, idx) => idx === i ? { ...f, uploading: false, done: false, error: message } : f));
      }
    }

    setUploading(false);
    await fetchAudits();

    // Fermer automatiquement seulement si tout s'est bien passé
    if (allDone) {
      setTimeout(() => { setShowForm(false); setSelectedFiles([]); }, 1500);
    }
    // Sinon la modale reste ouverte pour montrer les erreurs
  }

  const getStyle = (s: string) => {
    if (s === 'OK') return { color: 'text-emerald-500', bg: 'bg-emerald-50', label: 'RÉUSSI', icon: <CheckCircle className="text-emerald-500" /> };
    if (s === 'WARNING') return { color: 'text-orange-500', bg: 'bg-orange-50', label: 'AVERTISSEMENT', icon: <AlertCircle className="text-orange-500" /> };
    return { color: 'text-red-500', bg: 'bg-red-50', label: 'CRITIQUE', icon: <AlertCircle className="text-red-500" /> };
  };  async function handleView(details: string | null, fileName: string) {
    if (!details) return alert('Aucun fichier associé à cette maquette.');
    if (details.startsWith('box:')) {
      const parts = details.split(':');
      const fileId = parts[1];
      if (!fileId) return alert('ID fichier Box manquant.');
      // Ajouter à la visionneuse (sans doublon)
      setViewerFiles(prev =>
        prev.some(f => f.fileId === fileId) ? prev : [...prev, { fileId, fileName }]
      );
    } else {
      alert('Format de fichier non supporté par la visionneuse.');
    }
  }
  async function handleDelete(id: number) {
    const audit = audits.find(a => a.id === id);
    if (!audit) return;
    setDeleteTarget(audit);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // Supprimer le fichier sur Box si disponible
      if (deleteTarget.details?.startsWith('box:')) {
        const boxFileId = deleteTarget.details.split(':')[1];
        if (boxFileId) {
          const boxRes = await fetch('/api/box/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId: boxFileId }),
          });
          if (!boxRes.ok) {
            const err = await boxRes.json();
            throw new Error(`Erreur Box : ${err.error ?? boxRes.status}`);
          }
        }
      }
      // Supprimer de Supabase
      const { error } = await supabase.from('audits').delete().eq('id', deleteTarget.id);
      if (error) throw new Error(`Erreur Supabase : ${error.message}`);
      // Retirer du viewer si ouvert
      if (deleteTarget.details?.startsWith('box:')) {
        const boxFileId = deleteTarget.details.split(':')[1];
        setViewerFiles(prev => prev.filter(f => f.fileId !== boxFileId));
      }
      setDeleteTarget(null);
      fetchAudits();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setDeleting(false);
    }
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
        </div>        <nav className="flex-1 px-4 space-y-1">
          <button className="w-full flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <LayoutDashboard className="mr-3 h-5 w-5" /> Vue d'ensemble
          </button>
          <button className="w-full flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <Layers className="mr-3 h-5 w-5" /> Contrôle Structure Maquette
          </button>
          <button className="w-full flex items-center px-4 py-3 text-sm font-medium bg-slate-100 text-blue-600 rounded-lg">
            <Compass className="mr-3 h-5 w-5" /> Audit Géométrique
          </button>
          <button className="w-full flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <Database className="mr-3 h-5 w-5" /> Vérification Métadonnées
          </button>
          <button className="w-full flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <Settings2 className="mr-3 h-5 w-5" /> Validation
          </button>
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
                      <div className="flex items-center gap-2">                        <span className={`text-[10px] font-bold px-2 py-1 rounded ${style.bg} ${style.color}`}>{style.label}</span>                        <button
                          onClick={() => handleView(a.details, a.project_name)}
                          className="text-blue-400 hover:text-blue-600 transition-colors"
                          title="Visualiser"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(a.id)}
                          className="text-red-400 hover:text-red-600 transition-colors"
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
              </button>            </div>

            {/* STATUT CONNEXION BOX */}
            {boxReady ? (
              <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 mb-4">
                <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />
                <span className="text-xs text-emerald-700 font-medium">Connecté à Box</span>
              </div>
            ) : (
              <div className="flex items-center justify-between bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 mb-4">
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-orange-500 shrink-0" />
                  <span className="text-xs text-orange-700 font-medium">Connexion Box requise avant l&apos;upload</span>
                </div>
                <button
                  onClick={handleConnectBox}
                  className="text-xs font-bold bg-orange-500 hover:bg-orange-600 text-white px-3 py-1.5 rounded-lg transition-colors"
                >
                  Connecter à Box
                </button>
              </div>
            )}

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
            </div>            {/* LISTE DES FICHIERS */}
            {selectedFiles.length > 0 && (
              <div className="space-y-2 max-h-56 overflow-y-auto mb-4">
                {selectedFiles.map((sf, i) => (
                  <div key={i} className="flex flex-col bg-slate-50 rounded-lg px-3 py-2 border border-slate-200 gap-1">
                    <div className="flex items-center gap-3">
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
                      {sf.error && <span className="text-xs text-red-500 shrink-0 max-w-[80px] truncate" title={sf.error}>⚠ Erreur</span>}
                      {!sf.uploading && !sf.done && !sf.error && (
                        <button onClick={() => removeFile(i)} className="text-slate-300 hover:text-red-400">
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                    {/* Barre de progression individuelle */}
                    {sf.uploading && (
                      <div className="w-full">
                        <div className="w-full bg-slate-200 rounded-full h-1.5">
                          <div
                            className="bg-orange-500 h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${sf.progress}%` }}
                          />
                        </div>
                        <p className="text-[10px] text-slate-400 mt-0.5">
                          {sf.progress < 85 ? `Envoi vers Box... ${sf.progress}%` : sf.progress < 95 ? 'Calcul SHA-1...' : 'Finalisation...'}
                        </p>
                      </div>
                    )}
                    {sf.error && (
                      <p className="text-[10px] text-red-400 font-mono break-all">{sf.error}</p>
                    )}
                  </div>
                ))}
              </div>
            )}<div className="flex space-x-3">
              <button
                onClick={() => { setShowForm(false); setSelectedFiles([]); }}
                className="flex-1 py-2.5 text-sm font-bold text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
                disabled={uploading}
              >
                Annuler
              </button>              <button
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
      )}      {/* VISIONNEUSE IFC */}      {viewerFiles.length > 0 && (
        <IfcViewer
          files={viewerFiles}
          onClose={() => setViewerFiles([])}
          onRemoveFile={(fileId) => setViewerFiles(prev => prev.filter(f => f.fileId !== fileId))}
          availableFiles={audits
            .filter(a => a.details?.startsWith('box:'))
            .map(a => ({ fileId: a.details!.split(':')[1], fileName: a.project_name }))
          }
          onAddFile={(fileId, fileName) =>
            setViewerFiles(prev => prev.some(f => f.fileId === fileId) ? prev : [...prev, { fileId, fileName }])
          }        />
      )}

      {/* MODALE CONFIRMATION SUPPRESSION */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-8">
            <div className="flex items-center gap-4 mb-5">
              <div className="w-12 h-12 bg-red-100 rounded-full flex items-center justify-center shrink-0">
                <AlertCircle className="h-6 w-6 text-red-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-slate-800">Confirmer la suppression</h3>
                <p className="text-sm text-slate-500 mt-0.5">Cette action est irréversible</p>
              </div>
            </div>
            <div className="bg-slate-50 rounded-xl border border-slate-200 px-4 py-3 mb-6">
              <p className="text-xs text-slate-500 mb-1">Maquette à supprimer :</p>
              <p className="text-sm font-semibold text-slate-800 break-words">{deleteTarget.project_name}</p>
              {deleteTarget.details?.startsWith('box:') && (
                <p className="text-xs text-orange-600 mt-1.5 flex items-center gap-1">
                  <AlertCircle className="h-3 w-3 shrink-0" />
                  Le fichier sera également supprimé sur Box
                </p>
              )}
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="flex-1 py-2.5 text-sm font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleting}
                className="flex-1 py-2.5 text-sm font-bold text-white bg-red-500 hover:bg-red-600 rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {deleting ? <><Loader2 className="h-4 w-4 animate-spin" /> Suppression...</> : 'Supprimer définitivement'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}