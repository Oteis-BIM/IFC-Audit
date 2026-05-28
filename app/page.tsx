"use client";
export const dynamic = 'force-dynamic';
import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import {  LayoutDashboard, Layers, Ruler, Database, CheckCircle2,
  Bell, UserCircle, AlertCircle, CheckCircle,
  Upload, X, FileBox, Eye, Loader2, TrendingUp, Download, FileSpreadsheet, Sparkles
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
  discipline: string;
  uploading: boolean;
  done: boolean;
  error: string | null;
  progress: number; // progression 0-100 par fichier
};

// ─── Helper : parse le champ details stocké en Supabase ───────────────────────
// Nouveau format : box:fileId:discipline:downloadUrl
// Ancien format  : box:fileId:downloadUrl  (rétrocompat)
function parseMaquetteDetails(details: string | null): { fileId: string; discipline: string; downloadUrl: string } {
  if (!details?.startsWith('box:')) return { fileId: '', discipline: '', downloadUrl: '' };
  const parts = details.split(':');
  const fileId = parts[1] ?? '';
  const third = parts[2] ?? '';
  // Si le 3e segment ressemble à une URL ou est vide → ancien format
  if (third === '' || third === 'https' || third === 'http') {
    return { fileId, discipline: '', downloadUrl: parts.slice(2).join(':') };
  }
  return { fileId, discipline: third, downloadUrl: parts.slice(3).join(':') };
}

// ─── Vue Rapports ─────────────────────────────────────────────────────────────

const RAPPORT_CATEGORIES: { section: string; category: string; items: { id: string; label: string; expected: string }[] }[] = [
  // ── SECTION : FICHIER IFC ────────────────────────────────────────────────────
  {
    section: "FICHIER IFC",
    category: "1 — FORMAT DE FICHIER",
    items: [
      { id: "1.1", label: "Nom du fichier", expected: "Conforme à la convention de nommage OTEIS (code projet_discipline_phase)" },
      { id: "1.2", label: "Format IFC 2°3", expected: "Export IFC 2x3 (IFC2X3)" },
      { id: "1.3", label: "Taille du fichier", expected: "< 500 Mo par fichier IFC" },
    ],
  },  {
    section: "FICHIER IFC",
    category: "2 — ATTRIBUTS PROJET (IfcProject)",
    items: [      { id: "2.1", label: "Code (Name)", expected: "Code du projet (ex: OTEIS_PRJ_001)" },
      { id: "2.2", label: "LongName", expected: "Nom long du projet renseigné" },
      { id: "2.3", label: "Description (Description)", expected: "Description explicite du contenu du fichier" },
      { id: "2.4", label: "Phase (Phase)", expected: "Phase du projet renseignée" },
    ],
  },
  {    section: "FICHIER IFC",
    category: "3 — ATTRIBUTS SITE (IfcSite)",
    items: [
      { id: "3.1", label: "Nom (Name)", expected: "Nom du site renseigné" },
      { id: "3.2", label: "Description (Description)", expected: "Description du site renseignée" },      { id: "3.3", label: "Coordonnées N/S (Global Y) (en mm)", expected: "Coordonnée Nord/Sud renseignée (RGF93 / Lambert 93)" },
      { id: "3.4", label: "Coordonnées E/O (Global X) (en mm)", expected: "Coordonnée Est/Ouest renseignée (RGF93 / Lambert 93)" },
      { id: "3.5", label: "Elevation (Élévation Z) (en mm)", expected: "Élévation NGF renseignée" },
    ],
  },
  {
    section: "FICHIER IFC",
    category: "4 — ATTRIBUTS BATIMENT (IfcBuilding)",
    items: [      { id: "4.1", label: "Nom (Name)", expected: "" },
      { id: "4.2", label: "Adresse", expected: "" },
    ],
  },  {
    section: "FICHIER IFC",
    category: "5 — ATTRIBUTS NIVEAUX (IfcBuildingStorey)",
    items: [],
  },
  {
    section: "FICHIER IFC",
    category: "6 — COHÉRENCE / CONFORMITÉ",
    items: [
      { id: "6.1", label: "Vérification visuelle de l'assemblage des modèles (Cohérence générale des maquettes assemblées)", expected: "Modèles correctement positionnés et superposés sans décalage" },
      { id: "6.2", label: "Contrôle visuel de la modélisation - Respect des règles de modélisation à maîtriser", expected: "Respect des règles de modélisation OTEIS (éléments non doublés, pas de géométrie parasite)" },
      { id: "6.3", label: "Rattachement / Modélisation des objets aux Bons niveaux", expected: "Chaque objet est rattaché au niveau auquel il appartient" },
      { id: "6.4", label: "Conformité maquette et Maquette architecture", expected: "Cohérence géométrique avec la maquette architecture de référence" },
      { id: "6.5", label: "Contrôle de la connexion des objets", expected: "Objets correctement connectés (murs, dalles, poteaux…)" },
      { id: "6.6", label: "Contrôle des conflits internes", expected: "0 conflit interne à la maquette (clash détection)" },
      { id: "6.7", label: "Contrôle des conflits externes", expected: "0 conflit critique inter-maquettes (clash détection fédérée)" },
      { id: "6.8", label: "Contrôle des sustènes", expected: "Systèmes de sustentation correctement modélisés et rattachés" },
    ],
  },
  // ── SECTION : FAMILLES ──────────────────────────────────────────────────────
  {
    section: "FAMILLES",
    category: "7 — IFCBUILDINGELEMENT PROXY",
    items: [
      { id: "7.1", label: "Utilisation / limite des IfcBuildingElementProxy (aucun exception acceptée)", expected: "0 objet IfcBuildingElementProxy dans le fichier" },
    ],
  },
  {
    section: "FAMILLES",
    category: "8 — PIÈCES",
    items: [
      { id: "8.1", label: "Classification IFC", expected: "Pièces classifiées en IfcSpace avec type correct" },
      { id: "8.2", label: "Données non courantes", expected: "Pas de données redondantes ou incohérentes sur les pièces" },
      { id: "8.3", label: "Nommage des pièces", expected: "Nommage conforme (code fonction + numéro selon convention)" },
      { id: "8.4", label: "Intersection de pièces", expected: "0 intersection / chevauchement entre pièces" },
      { id: "8.5", label: "Pset_IFC", expected: "Pset_SpaceCommon renseigné (IsExternal, GrossFloorArea…)" },
      { id: "8.6", label: "Propriétés", expected: "Propriétés métier renseignées (surface, usage, programme)" },
    ],
  },
  {
    section: "FAMILLES",
    category: "9 — FAMILLES OBJET 1 (Ex : MUR3)",
    items: [
      { id: "9.1", label: "Dénomination IFC", expected: "Type IFC correct (IfcWall, IfcColumn, IfcBeam…)" },
      { id: "9.2", label: "Niveau de détail", expected: "LOD conforme à la phase (LOD 200 minimum en PRO)" },
      { id: "9.3", label: "Combinaison sur l'instance", expected: "Pas de combinaison de familles non prévue par la convention" },
      { id: "9.4", label: "Dimensions", expected: "Dimensions paramétriques correctement renseignées" },
      { id: "9.5", label: "Nom des objets", expected: "Nommage conforme à la convention OTEIS" },
      { id: "9.6", label: "Matériaux", expected: "Matériaux renseignés et conformes à la charte matériaux" },
      { id: "9.7", label: "Pset_app", expected: "Pset applicatif métier renseigné" },
      { id: "9.8", label: "Prop élec", expected: "Propriétés électriques renseignées (si applicable)" },
      { id: "9.9", label: "Prop méca", expected: "Propriétés mécaniques renseignées (si applicable)" },
    ],
  },
];

type CellStatus = 'ok' | 'warning' | 'error' | 'na' | 'unclear' | '';

function RapportCell({ status, onChange }: { status: CellStatus; onChange: (s: CellStatus) => void }) {
  const cycle: CellStatus[] = ['', 'ok', 'warning', 'error', 'na', 'unclear'];
  const next = () => onChange(cycle[(cycle.indexOf(status) + 1) % cycle.length]);
  const map: Record<CellStatus, { bg: string; label: string }> = {
    ok:      { bg: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200', label: '✓' },
    warning: { bg: 'bg-orange-100 text-orange-600 hover:bg-orange-200',   label: '⚠' },
    error:   { bg: 'bg-red-100 text-red-600 hover:bg-red-200',             label: '✗' },
    na:      { bg: 'bg-slate-100 text-slate-400 hover:bg-slate-200',       label: 'N/A' },
    unclear: { bg: 'bg-violet-50 text-violet-400 hover:bg-violet-100',     label: '?' },
    '':      { bg: 'bg-white text-slate-300 hover:bg-slate-50',            label: '—' },
  };
  const { bg, label } = map[status];
  return (
    <button
      onClick={next}
      title="Cliquer pour changer le statut"
      className={`w-full h-8 rounded text-xs font-bold transition-colors ${bg}`}
    >
      {label}
    </button>
  );
}

// ─────────────────────────────────────────────
// LLM VIEW — Interface de prompt libre vers GPT
// ─────────────────────────────────────────────
function buildMaquettesContext(audits: Audit[]): string {
  if (audits.length === 0) return 'Aucune maquette chargée dans l\'application.';
  const lines = audits.map(a => {
    const { discipline, downloadUrl } = parseMaquetteDetails(a.details);
    const fileName = downloadUrl ? downloadUrl.split('/').pop()?.split('?')[0] ?? a.project_name : a.project_name;
    return `- "${a.project_name}" | Discipline : ${discipline || 'non précisée'} | Fichier : ${fileName} | Statut : ${a.status} | Chargé le : ${new Date(a.created_at).toLocaleDateString('fr-FR')}`;
  });
  return `Maquettes IFC chargées dans l\'application (${audits.length}) :\n${lines.join('\n')}`;
}

function LlmView({ audits }: { audits: Audit[] }) {
  const maquettesContext = buildMaquettesContext(audits);
  const baseSystemPrompt = `Tu es un expert BIM et auditeur de maquettes IFC intégré à l'application ifc-audit.
Tu peux UNIQUEMENT répondre à des questions concernant les maquettes IFC chargées dans cette application.
Si la question ne concerne pas ces maquettes ou le domaine BIM/IFC, réponds : "Je ne peux répondre qu'aux questions relatives aux maquettes chargées dans cette application."
Réponds en français de manière précise et structurée.

${maquettesContext}`;
  const [prompt, setPrompt] = useState('');
  const [systemPrompt, setSystemPrompt] = useState(baseSystemPrompt);
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [model, setModel] = useState('gpt-4o-mini');
  const [tokensUsed, setTokensUsed] = useState<number | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const responseRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSystemPrompt(baseSystemPrompt);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audits]);

  async function handleSend() {
    if (!prompt.trim()) return;
    setLoading(true);
    setError('');
    setResponse('');
    setTokensUsed(null);
    try {
      const res = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: prompt.trim(),
          systemPrompt: systemPrompt.trim(),
          model,
          maquettes: audits.map(a => {
            const { fileId, discipline } = parseMaquetteDetails(a.details);
            return { fileId, fileName: a.project_name, discipline };
          }).filter(m => m.fileId),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      setResponse(data.content ?? '');
      setTokensUsed(data.tokensUsed ?? null);
      setTimeout(() => responseRef.current?.scrollIntoView({ behavior: 'smooth' }), 100);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSend();
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}      <div>
        <h2 className="text-3xl font-bold text-slate-900">LLM</h2>
        <p className="text-slate-500 text-sm mt-1">Interrogez l'IA sur les {audits.length > 0 ? `${audits.length} maquette${audits.length > 1 ? 's' : ''} chargée${audits.length > 1 ? 's' : ''}` : 'maquettes chargées'}</p>
      </div>

      {/* Bandeau maquettes chargées */}
      {audits.length === 0 ? (
        <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-5 py-3 text-sm text-amber-700">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Aucune maquette chargée — chargez d'abord une maquette IFC pour interroger l'IA.</span>
        </div>
      ) : (
        <div className="bg-blue-50 border border-blue-200 rounded-xl px-5 py-3 space-y-1">
          <p className="text-xs font-bold text-blue-600 uppercase tracking-widest mb-1">Contexte — {audits.length} maquette{audits.length > 1 ? 's' : ''} disponible{audits.length > 1 ? 's' : ''}</p>
          {audits.map(a => {
            const { discipline } = parseMaquetteDetails(a.details);
            return (
              <p key={a.id} className="text-xs text-blue-700 font-mono">
                • {a.project_name}{discipline ? ` — ${discipline}` : ''} <span className="text-blue-400">({a.status})</span>
              </p>
            );
          })}
        </div>
      )}

      {/* Paramètres modèle */}
      <div className="flex items-center gap-4 bg-white border border-slate-200 rounded-xl px-5 py-3 shadow-sm">
        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Modèle</span>
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
        >
          <option value="gpt-4o-mini">gpt-4o-mini</option>
          <option value="gpt-4o">gpt-4o</option>
          <option value="gpt-4-turbo">gpt-4-turbo</option>
          <option value="gpt-3.5-turbo">gpt-3.5-turbo</option>
        </select>
        <button
          onClick={() => setShowSystem(s => !s)}
          className={`ml-auto flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${showSystem ? 'bg-purple-50 border-purple-300 text-purple-600' : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-slate-300'}`}
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Prompt système
        </button>
        {tokensUsed !== null && (
          <span className="text-[11px] text-slate-400 font-mono">{tokensUsed} tokens</span>
        )}
      </div>

      {/* Prompt système (optionnel) */}
      {showSystem && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 space-y-2">
          <label className="text-xs font-bold text-purple-600 uppercase tracking-widest">Prompt système</label>
          <textarea
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            rows={3}
            className="w-full text-sm text-slate-700 bg-white border border-purple-200 rounded-lg px-4 py-3 resize-y focus:outline-none focus:ring-2 focus:ring-purple-400 font-mono"
            placeholder="Instructions données à l'IA en contexte système…"
          />
        </div>
      )}

      {/* Zone de prompt */}
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-100 bg-slate-50">
          <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
          </svg>
          <span className="text-xs font-bold text-slate-500 uppercase tracking-widest">Votre prompt</span>
          <span className="ml-auto text-[10px] text-slate-400">Ctrl+Entrée pour envoyer</span>
        </div>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={8}
          className="w-full text-sm text-slate-800 px-5 py-4 resize-y focus:outline-none font-mono leading-relaxed"
          placeholder="Posez une question sur les maquettes chargées…&#10;&#10;Ex : Quels sont les niveaux de la maquette Structure ?&#10;Ex : La maquette Électricité contient-elle des BAES ?"
          disabled={loading}
        />
        <div className="flex items-center justify-between px-5 py-3 border-t border-slate-100 bg-slate-50">
          <button
            onClick={() => { setPrompt(''); setResponse(''); setError(''); setTokensUsed(null); }}
            className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
            disabled={loading}
          >
            Effacer
          </button>
          <button
            onClick={handleSend}
            disabled={loading || !prompt.trim()}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white text-sm font-bold px-6 py-2.5 rounded-lg transition-colors"
          >
            {loading ? (
              <>
                <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                Génération…
              </>
            ) : (
              <>
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
                </svg>
                Envoyer
              </>
            )}
          </button>
        </div>
      </div>

      {/* Erreur */}
      {error && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl px-5 py-4 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Réponse IA */}
      {response && (
        <div ref={responseRef} className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-100 bg-gradient-to-r from-blue-50 to-slate-50">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1 1 .03 2.798-1.317 2.507l-2.694-.674m-8.692-1.12L5.9 18.714c-1.347.29-2.316-1.508-1.317-2.508L5 15.3" />
            </svg>
            <span className="text-xs font-bold text-blue-600 uppercase tracking-widest">Réponse — {model}</span>
            <button
              onClick={() => navigator.clipboard.writeText(response)}
              className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-slate-600 border border-slate-200 rounded-lg px-2.5 py-1 transition-colors"
              title="Copier la réponse"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copier
            </button>
          </div>
          <div className="px-5 py-5 text-sm text-slate-800 leading-relaxed whitespace-pre-wrap font-mono">
            {response}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// PARAMÈTRES VIEW — Mappage catégories IFC + vérification propriétés
// ─────────────────────────────────────────────

// Types IFC standards reconnus et leur catégorie par défaut
const IFC_TYPE_DEFAULTS: Record<string, string> = {
  IfcWallStandardCase: 'Murs Porteurs',
  IfcWall: 'Murs',
  IfcBeam: 'Poutres Structurelles',
  IfcColumn: 'Poteaux',
  IfcSlab: 'Dalles',
  IfcRoof: 'Toiture',
  IfcDoor: 'Portes',
  IfcWindow: 'Fenêtres',
  IfcStair: 'Escaliers',
  IfcRailing: 'Garde-corps',
  IfcCovering: 'Revêtements',
  IfcFurnishingElement: 'Mobilier',
  IfcFlowSegment: 'Réseaux',
  IfcFlowTerminal: 'Équipements Terminaux',
  IfcDistributionFlowElement: 'Distribution Fluides',
  IfcElectricDistributionBoard: 'Tableau Électrique',
  IfcLightFixture: 'Luminaires',
  IfcOutlet: 'Prises/Interrupteurs',
  IfcPile: 'Pieux',
  IfcFooting: 'Fondations',
};

// Propriétés attendues par catégorie (personnalisables)
const DEFAULT_CATEGORY_PROPS: Record<string, string[]> = {
  'Murs Porteurs':        ['Résistance Feu', 'Coefficient U', 'Matériau', 'Épaisseur', 'Acoustique'],
  'Murs':                 ['Résistance Feu', 'Coefficient U', 'Matériau', 'Épaisseur'],
  'Poutres Structurelles':['Matériau', 'Section', 'Résistance', 'Traitement'],
  'Poteaux':              ['Matériau', 'Section', 'Résistance'],
  'Dalles':               ['Résistance Feu', 'Matériau', 'Épaisseur', 'Charge Admissible'],
  'Toiture':              ['Résistance Feu', 'Coefficient U', 'Matériau', 'Pente'],
  'Portes':               ['Résistance Feu', 'Matériau', 'Largeur', 'Hauteur'],
  'Fenêtres':             ['Coefficient U', 'Facteur Solaire', 'Largeur', 'Hauteur'],
  'Luminaires':           ['Puissance', 'Flux Lumineux', 'Indice Protection', 'Marque'],
  'Prises/Interrupteurs': ['Tension', 'Intensité', 'Indice Protection'],
  'Tableau Électrique':   ['Puissance Totale', 'Indice Protection', 'Marque'],
};

type MappingRule = 'Auto-detect' | 'Manual Mapping' | 'Excluded';
type MappingRow = { ifcType: string; category: string; rule: MappingRule; aiStatus: 'Verified' | 'Incohérence Nommage' | 'Warning' | '' };

function ParametresView({ audits, loading }: { audits: Audit[]; loading: boolean }) {
  const [selectedAuditId, setSelectedAuditId] = useState<number | null>(null);
  const selectedAudit = audits.find(a => a.id === selectedAuditId) ?? audits[0] ?? null;

  // Mapping IFC type → catégorie (éditable)
  const [mappingRows, setMappingRows] = useState<MappingRow[]>(() =>
    Object.entries(IFC_TYPE_DEFAULTS).map(([ifcType, category]) => ({
      ifcType,
      category,
      rule: 'Auto-detect' as MappingRule,
      aiStatus: 'Verified' as const,
    }))
  );

  // Propriétés attendues par catégorie (éditable)
  const [categoryProps, setCategoryProps] = useState<Record<string, string[]>>(DEFAULT_CATEGORY_PROPS);

  // Filtre "manquants seulement" par catégorie
  const [filterMissing, setFilterMissing] = useState<Record<string, boolean>>({});

  // Edition inline
  const [editingRow, setEditingRow] = useState<number | null>(null);

  const categories = Array.from(new Set(mappingRows.map(r => r.category))).filter(Boolean);

  useEffect(() => {
    if (!selectedAuditId && audits.length > 0) setSelectedAuditId(audits[0].id);
  }, [audits, selectedAuditId]);

  if (loading) return <p className="text-slate-400 italic animate-pulse">Chargement…</p>;
  if (audits.length === 0) return <p className="text-slate-400 italic">Aucune maquette chargée.</p>;

  // Simuler des données de présence (rempli / manquant) pour la démo
  // En production : ces données viendraient d'un parser IFC
  function mockCellStatus(ifcType: string, prop: string): 'Remplie' | 'Manquante' {
    const hash = (ifcType + prop).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    return hash % 5 === 0 ? 'Manquante' : 'Remplie';
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-3xl font-bold text-slate-900">Paramètres</h2>
          <p className="text-slate-500 text-sm mt-1">Mappage des types IFC et vérification des propriétés par catégorie</p>
        </div>
        <div className="flex items-center gap-3">
          {/* Sélecteur maquette */}
          <select
            value={selectedAuditId ?? ''}
            onChange={e => setSelectedAuditId(Number(e.target.value))}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            {audits.map(a => {
              const { discipline } = parseMaquetteDetails(a.details);
              return <option key={a.id} value={a.id}>{discipline ? `${discipline} — ` : ''}{a.project_name}</option>;
            })}
          </select>
          <button className="flex items-center gap-2 bg-slate-800 hover:bg-slate-900 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Charger le fichier de mappage (Excel)
          </button>
        </div>
      </div>

      {/* Titre maquette sélectionnée */}
      {selectedAudit && (
        <div className="flex items-center gap-3 bg-white border border-slate-200 rounded-xl px-5 py-3 shadow-sm">
          <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <div>
            <div className="font-bold text-slate-800">{selectedAudit.project_name}</div>
            <div className="text-[11px] text-slate-400">
              Dernière modification : {new Date(selectedAudit.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' })} — {new Date(selectedAudit.created_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
          <span className="ml-auto text-xs font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-3 py-1 rounded-full">✓ Chargé</span>
        </div>
      )}

      {/* Section 1 — Mappage des Catégories */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-slate-100">
          <svg className="w-5 h-5 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 10h16M4 14h16M4 18h16" />
          </svg>
          <h3 className="text-base font-bold text-slate-800">Mappage des Catégories</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th className="text-left px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Type d&apos;objet IFC</th>
                <th className="text-left px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Catégorie client</th>
                <th className="text-left px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Règle appliquée</th>
                <th className="text-left px-6 py-3 text-[10px] font-bold text-slate-400 uppercase tracking-widest">Validation/Commentaires IA</th>
                <th className="px-4 py-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {mappingRows.map((row, idx) => (
                <tr key={row.ifcType} className={`border-b border-slate-100 ${idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'} hover:bg-blue-50/30 transition-colors`}>
                  <td className="px-6 py-3">
                    <span className="text-blue-600 font-mono text-sm font-semibold">{row.ifcType}</span>
                  </td>
                  <td className="px-6 py-3">
                    {editingRow === idx ? (
                      <input
                        autoFocus
                        className="border border-blue-400 rounded-lg px-2 py-1 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-400 w-44"
                        value={row.category}
                        onChange={e => setMappingRows(prev => prev.map((r, i) => i === idx ? { ...r, category: e.target.value } : r))}
                        onBlur={() => setEditingRow(null)}
                        onKeyDown={e => e.key === 'Enter' && setEditingRow(null)}
                      />
                    ) : (
                      <span
                        className="inline-block bg-blue-100 text-blue-800 text-xs font-semibold px-3 py-1 rounded-full cursor-pointer hover:bg-blue-200 transition-colors"
                        onClick={() => setEditingRow(idx)}
                      >
                        {row.category || <span className="text-slate-400 italic">— cliquer pour définir</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-3">
                    <select
                      value={row.rule}
                      onChange={e => setMappingRows(prev => prev.map((r, i) => i === idx ? { ...r, rule: e.target.value as MappingRule } : r))}
                      className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    >
                      <option>Auto-detect</option>
                      <option>Manual Mapping</option>
                      <option>Excluded</option>
                    </select>
                  </td>
                  <td className="px-6 py-3">
                    {row.aiStatus === 'Verified' && (
                      <span className="flex items-center gap-1.5 text-emerald-600 text-xs font-semibold">
                        <CheckCircle className="h-3.5 w-3.5" /> Verified
                      </span>
                    )}
                    {row.aiStatus === 'Incohérence Nommage' && (
                      <span className="flex items-center gap-1.5 text-orange-500 text-xs font-semibold">
                        <AlertCircle className="h-3.5 w-3.5" /> Incohérence Nommage
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => setMappingRows(prev => prev.filter((_, i) => i !== idx))}
                      className="text-slate-300 hover:text-red-400 transition-colors"
                      title="Supprimer"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Section 2 — Vérification des Propriétés par Catégorie */}
      <div>
        <h3 className="text-xl font-bold text-slate-800 mb-4">Vérification des Propriétés par Catégorie</h3>
        <div className="space-y-4">
          {categories.map(cat => {
            const props = categoryProps[cat] ?? [];
            const ifcTypes = mappingRows.filter(r => r.category === cat && r.rule !== 'Excluded').map(r => r.ifcType);
            if (ifcTypes.length === 0) return null;
            // Simuler 2–4 objets par catégorie
            const mockObjects = ifcTypes.slice(0, 3).map((t, i) => ({ id: `${t}_${382 + i}X4${i + 1}_A`, ifcType: t }));
            const missingOnly = filterMissing[cat] ?? false;
            const displayed = missingOnly
              ? mockObjects.filter(obj => props.some(p => mockCellStatus(obj.ifcType, p) === 'Manquante'))
              : mockObjects;
            const totalCount = ifcTypes.length * 28; // simulé

            return (
              <div key={cat} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                {/* Catégorie header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
                  <div className="flex items-center gap-3">
                    <div className="w-1 h-6 bg-orange-500 rounded-full" />
                    <span className="font-bold text-slate-800">{cat}</span>
                    <span className="text-xs text-slate-400">{totalCount} objets détectés</span>
                  </div>
                  <button
                    onClick={() => setFilterMissing(prev => ({ ...prev, [cat]: !prev[cat] }))}
                    className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors ${missingOnly ? 'bg-orange-50 border-orange-300 text-orange-600' : 'bg-slate-50 border-slate-200 text-slate-500 hover:border-slate-300'}`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2a1 1 0 01-.293.707L13 13.414V19a1 1 0 01-.553.894l-4 2A1 1 0 017 21v-7.586L3.293 6.707A1 1 0 013 6V4z" />
                    </svg>
                    Filtrer les manquants
                  </button>
                </div>
                {/* Tableau propriétés */}
                {props.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-100">
                          <th className="text-left px-5 py-2.5 font-bold text-slate-400 uppercase tracking-widest text-[10px] min-w-[160px]">Object ID</th>
                          {props.map(p => (
                            <th key={p} className="text-left px-4 py-2.5 font-bold text-slate-400 uppercase tracking-widest text-[10px] min-w-[120px]">{p}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayed.map((obj, oi) => (
                          <tr key={obj.id} className={`border-b border-slate-100 ${oi % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                            <td className="px-5 py-2.5 font-mono text-slate-600 font-semibold">{obj.id}</td>
                            {props.map(p => {
                              const status = mockCellStatus(obj.ifcType, p);
                              return (
                                <td key={p} className="px-4 py-2.5">
                                  {status === 'Remplie' ? (
                                    <span className="flex items-center gap-1.5 text-emerald-600 font-semibold">
                                      <CheckCircle className="h-3.5 w-3.5" /> Remplie
                                    </span>
                                  ) : (
                                    <span className="flex items-center gap-1.5 text-red-500 font-semibold">
                                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                                        <circle cx="12" cy="12" r="10" /><path strokeLinecap="round" strokeLinejoin="round" d="M15 9l-6 6M9 9l6 6" />
                                      </svg>
                                      Manquante
                                    </span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                        {displayed.length === 0 && (
                          <tr><td colSpan={1 + props.length} className="text-center py-6 text-slate-400 italic text-xs">Aucun objet avec des propriétés manquantes.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                {/* Gestion des propriétés attendues */}
                <div className="px-5 py-3 bg-slate-50 border-t border-slate-100 flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wide mr-1">Propriétés attendues :</span>
                  {props.map(p => (
                    <span key={p} className="inline-flex items-center gap-1 bg-white border border-slate-200 text-slate-600 text-[11px] font-medium px-2 py-0.5 rounded-full">
                      {p}
                      <button
                        onClick={() => setCategoryProps(prev => ({ ...prev, [cat]: (prev[cat] ?? []).filter(x => x !== p) }))}
                        className="text-slate-300 hover:text-red-400 ml-0.5"
                      >×</button>
                    </span>
                  ))}
                  <button
                    onClick={() => {
                      const name = prompt(`Nouvelle propriété pour "${cat}" :`);
                      if (name?.trim()) setCategoryProps(prev => ({ ...prev, [cat]: [...(prev[cat] ?? []), name.trim()] }));
                    }}
                    className="text-[11px] text-blue-500 hover:text-blue-700 font-semibold border border-dashed border-blue-300 px-2 py-0.5 rounded-full hover:bg-blue-50 transition-colors"
                  >
                    + Ajouter
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function RapportsView({ audits, loading }: { audits: Audit[]; loading: boolean }) {
  const maquettes = audits.slice(0, 6);
  const totalItems = RAPPORT_CATEGORIES.reduce((s, c) => s + c.items.length, 0);

  const [cells, setCells] = useState<Record<string, CellStatus>>({});
  const setCell = (itemId: string, maqId: number, val: CellStatus) =>
    setCells(prev => ({ ...prev, [`${itemId}-${maqId}`]: val }));

  const scoreFor = (maqId: number) => {
    let ok = 0, total = 0;
    RAPPORT_CATEGORIES.forEach(cat => cat.items.forEach(item => {
      const v = cells[`${item.id}-${maqId}`];
      if (v) { total++; if (v === 'ok') ok++; }
    }));
    return total === 0 ? null : Math.round((ok / total) * 100);
  };

  const scoreColor = (s: number | null) =>
    s === null ? 'text-slate-400' : s >= 80 ? 'text-emerald-400' : s >= 60 ? 'text-orange-400' : 'text-red-400';

  const sections = RAPPORT_CATEGORIES.reduce<{ section: string; cats: typeof RAPPORT_CATEGORIES }[]>((acc, cat) => {
    const existing = acc.find(s => s.section === cat.section);
    if (existing) existing.cats.push(cat);
    else acc.push({ section: cat.section, cats: [cat] });
    return acc;
  }, []);

  const colCount = 4 + maquettes.length;

  return (
    <div>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h2 className="text-3xl font-bold text-slate-900">Rapport de Contrôle</h2>
          <p className="text-slate-500 mt-1 text-sm max-w-xl">
            Grille d&apos;audit OTEIS — Audit Maquette Numérique. Cliquez sur une cellule pour renseigner le statut.
          </p>
        </div>
        <div className="flex gap-3 shrink-0 items-start">
          <div className="flex items-center gap-3 text-xs text-slate-500 bg-slate-50 rounded-xl px-4 py-2 border border-slate-200 flex-wrap">
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-emerald-100 text-emerald-700 rounded flex items-center justify-center font-bold text-[10px]">✓</span> Conforme</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-orange-100 text-orange-600 rounded flex items-center justify-center font-bold text-[10px]">⚠</span> Écart</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-red-100 text-red-600 rounded flex items-center justify-center font-bold text-[10px]">✗</span> Non conforme</span>            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-slate-100 text-slate-400 rounded flex items-center justify-center font-bold text-[9px]">N/A</span> Non applicable</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-violet-50 text-violet-400 rounded flex items-center justify-center font-bold text-[10px]">?</span> À vérifier manuellement</span>
          </div>
          <button className="border border-slate-300 text-slate-700 px-4 py-2 rounded-lg font-semibold text-sm hover:bg-slate-50 transition-colors flex items-center gap-2 shrink-0">
            <Download className="h-4 w-4" /> Exporter CSV
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-slate-400 italic animate-pulse">Chargement...</p>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-slate-900 text-white">
                  <th className="text-left px-3 py-3 font-bold w-16 border-r border-slate-700 whitespace-nowrap">N°</th>
                  <th className="text-left px-4 py-3 font-bold min-w-[280px] border-r border-slate-700">Objet / Item de contrôle</th>
                  <th className="text-left px-4 py-3 font-bold min-w-[240px] border-r border-slate-700 text-blue-300">Attendu</th>                  {maquettes.length === 0
                    ? <th className="text-center px-4 py-3 font-bold text-slate-400 italic">← Chargez des maquettes</th>
                    : maquettes.map(m => {
                        const { discipline } = parseMaquetteDetails(m.details);
                        return (
                          <th key={m.id} className="text-center px-2 py-3 font-bold min-w-[110px] border-r border-slate-700 last:border-r-0">
                            {discipline && (
                              <div className="text-[10px] font-bold text-blue-300 uppercase tracking-wide mb-0.5 truncate max-w-[100px] mx-auto">{discipline}</div>
                            )}
                            <div className="truncate max-w-[100px] mx-auto text-[11px] font-medium text-white/80" title={m.project_name}>
                              {m.project_name.replace(/\.ifc$/i, '')}
                            </div>
                          </th>
                        );
                      })
                  }
                </tr>
                {maquettes.length > 0 && (
                  <tr className="bg-slate-800 border-b-2 border-slate-600">
                    <td colSpan={3} className="px-4 py-2 border-r border-slate-700">
                      <span className="text-[10px] font-bold uppercase tracking-wide text-slate-400">Score de conformité</span>
                    </td>
                    {maquettes.map(m => {
                      const s = scoreFor(m.id);
                      return (
                        <td key={m.id} className="text-center px-2 py-2 border-r border-slate-700 last:border-r-0">
                          <span className={`text-xl font-black ${scoreColor(s)}`}>{s === null ? '—' : `${s}%`}</span>
                        </td>
                      );
                    })}
                  </tr>
                )}
              </thead>
              <tbody>
                {sections.map(({ section, cats }) => (
                  <React.Fragment key={section}>
                    <tr className="bg-slate-900">
                      <td colSpan={colCount} className="px-4 py-2">
                        <span className="text-[11px] font-black text-white uppercase tracking-widest">{section}</span>
                      </td>
                    </tr>
                    {cats.map(cat => (
                      <React.Fragment key={cat.category}>
                        <tr className="bg-blue-600">
                          <td colSpan={colCount} className="px-4 py-1.5">
                            <span className="text-[10px] font-bold text-white uppercase tracking-wide">{cat.category}</span>
                          </td>
                        </tr>
                        {cat.items.map((item, ii) => (
                          <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/60'} hover:bg-blue-50/40 transition-colors`}>
                            <td className="px-3 py-2 text-[10px] text-slate-400 font-mono border-r border-slate-100 align-middle whitespace-nowrap">{item.id}</td>
                            <td className="px-4 py-2 text-slate-700 font-medium border-r border-slate-100 align-middle leading-snug">{item.label}</td>
                            <td className="px-4 py-2 text-slate-500 italic border-r border-slate-100 align-middle leading-snug text-[11px]">{item.expected}</td>
                            {maquettes.map(m => (
                              <td key={m.id} className="px-1.5 py-1.5 border-r border-slate-100 last:border-r-0 align-middle">
                                <RapportCell
                                  status={cells[`${item.id}-${m.id}`] ?? ''}
                                  onChange={v => setCell(item.id, m.id, v)}
                                />
                              </td>
                            ))}
                            {maquettes.length === 0 && (
                              <td className="px-4 py-2 text-slate-300 italic text-center">—</td>
                            )}
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </React.Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-slate-100 border-t-2 border-slate-300">
                  <td className="px-3 py-2 border-r border-slate-200" />
                  <td className="px-4 py-2 text-xs font-bold text-slate-600 border-r border-slate-200">{totalItems} items de contrôle</td>
                  <td className="px-4 py-2 border-r border-slate-200" />
                  {maquettes.map(m => (
                    <td key={m.id} className="text-center px-2 py-2 border-r border-slate-200 last:border-r-0">
                      <span className="text-[10px] text-slate-500">
                        {Object.entries(cells).filter(([k, v]) => k.endsWith(`-${m.id}`) && v).length} / {totalItems} renseignés
                      </span>
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Vue Maquettes ────────────────────────────────────────────────────────────
type MaquetteCardData = {
  name: string;
  file: string;
  updatedAgo: string;
  status: 'EN COURS' | 'EN ATTENTE' | 'VALIDÉ' | 'CRITIQUE';
  totalErrors: number;
  clashCritiques: number;
  scoreQualite: number;
  collisions: { label: string; pct: number; count: string };
  conventions: { label: string; pct: number; count: string };
  completude: { label: string; pct: number; count: string };
  controles: { label: string; status: 'ok' | 'error' | 'warning'; detail: string }[];
};

function StatusBadge({ status }: { status: MaquetteCardData['status'] }) {
  const map = {
    'EN COURS':  'bg-blue-100 text-blue-700',
    'EN ATTENTE':'bg-slate-100 text-slate-500',
    'VALIDÉ':    'bg-emerald-100 text-emerald-700',
    'CRITIQUE':  'bg-red-100 text-red-600',
  };
  return <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${map[status]}`}>{status}</span>;
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="w-full bg-slate-100 rounded-full h-2">
      <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ControleIcon({ status }: { status: 'ok' | 'error' | 'warning' }) {
  if (status === 'ok') return <CheckCircle className="h-4 w-4 text-emerald-500" />;
  if (status === 'error') return <X className="h-4 w-4 text-red-500 bg-red-100 rounded-full p-0.5" />;
  return <AlertCircle className="h-4 w-4 text-orange-400" />;
}

function MaquetteCard({ card, onView, onDelete }: { card: MaquetteCardData & { id: number; details: string | null }; onView: () => void; onDelete: () => void }) {
  const scoreColor = card.scoreQualite >= 80 ? 'text-emerald-600' : card.scoreQualite >= 60 ? 'text-orange-500' : 'text-red-500';
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      {/* Header carte */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-slate-100 rounded-lg flex items-center justify-center shrink-0">
            <FileBox className="h-5 w-5 text-blue-500" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-sm font-bold text-slate-800">{card.name}</h4>
              <StatusBadge status={card.status} />
            </div>
            <p className="text-[10px] text-slate-400">{card.file} • Mis à jour {card.updatedAgo}</p>
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button onClick={onView} className="text-blue-400 hover:text-blue-600 transition-colors" title="Visualiser 3D"><Eye className="h-4 w-4" /></button>
          <button onClick={onDelete} className="text-red-300 hover:text-red-500 transition-colors" title="Supprimer"><X className="h-4 w-4" /></button>
        </div>
      </div>

      {/* Métriques */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'TOTAL ERREURS', value: card.totalErrors, color: 'text-slate-800' },
          { label: 'CLASHS CRITIQUES', value: card.clashCritiques, color: 'text-orange-500' },
          { label: 'SCORE QUALITÉ', value: `${card.scoreQualite}%`, color: scoreColor },
        ].map(m => (
          <div key={m.label} className="bg-slate-50 rounded-xl p-3 text-center">
            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wide leading-tight mb-1">{m.label}</p>
            <p className={`text-2xl font-black ${m.color}`}>{m.value}</p>
          </div>
        ))}
      </div>

      {/* Barres de progression */}
      <div className="space-y-2.5">
        {[
          { ...card.collisions, color: 'bg-orange-400' },
          { ...card.conventions, color: 'bg-emerald-500' },
          { ...card.completude, color: 'bg-blue-800' },
        ].map(b => (
          <div key={b.label}>
            <div className="flex justify-between text-[10px] text-slate-500 mb-1">
              <span>{b.label}</span>
              <span>{b.pct}% ({b.count})</span>
            </div>
            <ProgressBar pct={b.pct} color={b.color} />
          </div>
        ))}
      </div>

      {/* Contrôles spécifiques */}
      <div>
        <div className="grid grid-cols-3 text-[9px] font-bold text-slate-400 uppercase tracking-wide pb-1 border-b border-slate-100 mb-2">
          <span>CONTRÔLE SPÉCIFIQUE</span><span className="text-center">STATUS</span><span className="text-right">DÉTAILS</span>
        </div>
        <div className="space-y-1.5">
          {card.controles.map(c => (
            <div key={c.label} className="grid grid-cols-3 items-center text-xs">
              <span className="text-blue-600 font-medium">{c.label}</span>
              <span className="flex justify-center"><ControleIcon status={c.status} /></span>
              <span className={`text-right font-medium ${c.status === 'ok' ? 'text-emerald-600' : c.status === 'error' ? 'text-red-500' : 'text-orange-500'}`}>{c.detail}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MaquettesView({ audits, loading, onNewAnalysis, onView, onDelete, chapitresOnly = false }: {
  audits: Audit[];
  loading: boolean;
  onNewAnalysis: () => void;
  onView: (details: string | null, name: string) => void;
  onDelete: (id: number) => void;
  chapitresOnly?: boolean;
}){  const maquettes = audits.slice(0, 6);
  const [cells, setCells] = useState<Record<string, CellStatus>>({});
  const setCell = (itemId: string, maqId: number, val: CellStatus) =>
    setCells(prev => ({ ...prev, [`${itemId}-${maqId}`]: val }));
  const [aiComments, setAiComments] = useState<Record<string, string>>({});const [namingPattern, setNamingPattern] = useState('');
  const [patternSaving, setPatternSaving] = useState(false);
  const [patternSaved, setPatternSaved] = useState(false);
  const [customExpected, setCustomExpected] = useState<Record<string, string>>({});
  const [customSaving, setCustomSaving] = useState<Record<string, boolean>>({});
  const [customSaved, setCustomSaved] = useState<Record<string, boolean>>({});  const [aiLoading, setAiLoading] = useState<Record<number, boolean>>({});
  const [aiError, setAiError] = useState<Record<number, string>>({});
  const [aiDone, setAiDone] = useState<Record<number, boolean>>({});
  const [aiProgress, setAiProgress] = useState<Record<number, number>>({});
  const aiProgressRef = useRef<Record<number, ReturnType<typeof setInterval>>>({});  // Niveaux attendus pour la carte 5 : [{ name, elevation }]
  const [expectedLevels, setExpectedLevels] = useState<{ name: string; elevation: string }[]>([
    { name: '', elevation: '' },
  ]);  const [levelsSaving, setLevelsSaving] = useState(false);
  const [levelsSaved, setLevelsSaved] = useState(false);  // Sauvegarde par carte (clé = numéro de carte ex: "1", "2", "3", "4")
  const [cardSaving, setCardSaving] = useState<Record<string, boolean>>({});
  const [cardSaved, setCardSaved] = useState<Record<string, boolean>>({});
  // Niveaux trouvés par l'IA pour chaque maquette : maqId -> storeys[]
  const [ifcStoreys, setIfcStoreys] = useState<Record<number, { name: string; elevation: number | null }[]>>({});// Charger le pattern sauvegardé au montage (Supabase avec fallback localStorage)
  useEffect(() => {
    supabase.from('audit_config').select('value').eq('key', 'naming_pattern').maybeSingle()
      .then(({ data, error }) => {
        if (data?.value) {
          setNamingPattern(data.value);
        } else if (error) {
          const local = localStorage.getItem('naming_pattern');
          if (local) setNamingPattern(local);
        }
      });    // Charger les attendus personnalisés
    const ids = ['2.1', '2.2', '2.3', '2.4', '3.1', '3.2', '3.3', '3.4', '3.5', '4.1', '4.2'];
    ids.forEach(id => {
      const key = `expected_${id}`;
      supabase.from('audit_config').select('value').eq('key', key).maybeSingle()
        .then(({ data, error }) => {
          const val = data?.value ?? (error ? localStorage.getItem(key) : null);
          if (val) setCustomExpected(prev => ({ ...prev, [id]: val }));
        });
    });

    // Charger les niveaux attendus de la Carte 5
    supabase.from('audit_config').select('value').eq('key', 'expected_levels').maybeSingle()
      .then(({ data, error }) => {        const raw = data?.value ?? (error ? localStorage.getItem('expected_levels') : null);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0) setExpectedLevels(parsed);
          } catch { /* ignore */ }
        }
      });  }, []);

  async function saveNamingPattern() {
    if (!namingPattern.trim()) return;
    setPatternSaving(true);
    setPatternSaved(false);
    // Toujours sauvegarder en localStorage (fallback instantané)
    localStorage.setItem('naming_pattern', namingPattern.trim());
    const { error } = await supabase.from('audit_config').upsert(
      { key: 'naming_pattern', value: namingPattern.trim() },
      { onConflict: 'key' }
    );
    setPatternSaving(false);
    if (!error) {
      setPatternSaved(true);
      setTimeout(() => setPatternSaved(false), 2500);
    } else {
      // Supabase KO mais localStorage OK → succès partiel
      console.warn('Supabase audit_config indisponible, sauvegardé en localStorage uniquement :', error.message);
      setPatternSaved(true);
      setTimeout(() => setPatternSaved(false), 2500);
    }
  }  async function saveExpectedLevels() {
    setLevelsSaving(true);
    setLevelsSaved(false);
    const value = JSON.stringify(expectedLevels);
    localStorage.setItem('expected_levels', value);
    const { error } = await supabase.from('audit_config').upsert(
      { key: 'expected_levels', value },
      { onConflict: 'key' }
    );
    setLevelsSaving(false);
    if (error) console.warn('Supabase indisponible, sauvegardé en localStorage :', error.message);
    setLevelsSaved(true);
    setTimeout(() => setLevelsSaved(false), 2500);
  }
  async function saveCustomExpected(itemId: string) {
    const value = customExpected[itemId]?.trim();
    if (!value) return;
    const key = `expected_${itemId}`;
    setCustomSaving(prev => ({ ...prev, [itemId]: true }));
    setCustomSaved(prev => ({ ...prev, [itemId]: false }));
    localStorage.setItem(key, value);
    await supabase.from('audit_config').upsert({ key, value }, { onConflict: 'key' });
    setCustomSaving(prev => ({ ...prev, [itemId]: false }));
    setCustomSaved(prev => ({ ...prev, [itemId]: true }));
    setTimeout(() => setCustomSaved(prev => ({ ...prev, [itemId]: false })), 2500);
  }

  // Sauvegarde tous les attendus d'une carte en une seule action
  async function saveCardExpected(cardNum: string, itemIds: string[]) {
    setCardSaving(prev => ({ ...prev, [cardNum]: true }));
    setCardSaved(prev => ({ ...prev, [cardNum]: false }));
    // Cas spécial carte 1 : pattern de nommage
    if (cardNum === '1' && namingPattern.trim()) {
      localStorage.setItem('naming_pattern', namingPattern.trim());
      await supabase.from('audit_config').upsert(
        { key: 'naming_pattern', value: namingPattern.trim() },
        { onConflict: 'key' }
      );
    }
    await Promise.all(itemIds.map(async id => {
      const value = customExpected[id]?.trim();
      if (!value) return;
      const key = `expected_${id}`;
      localStorage.setItem(key, value);
      await supabase.from('audit_config').upsert({ key, value }, { onConflict: 'key' });
    }));
    setCardSaving(prev => ({ ...prev, [cardNum]: false }));
    setCardSaved(prev => ({ ...prev, [cardNum]: true }));
    setTimeout(() => setCardSaved(prev => ({ ...prev, [cardNum]: false })), 2500);
  }

  async function runAiAudit(audit: Audit) {
    if (!audit.details?.startsWith('box:')) return;
    const { fileId, discipline } = parseMaquetteDetails(audit.details);
    if (!fileId) return;    setAiLoading(prev => ({ ...prev, [audit.id]: true }));
    setAiError(prev => ({ ...prev, [audit.id]: '' }));
    setAiDone(prev => ({ ...prev, [audit.id]: false }));
    setAiProgress(prev => ({ ...prev, [audit.id]: 0 }));

    // Simulation de progression 0 → 90% pendant l'analyse
    const id = audit.id;
    aiProgressRef.current[id] = setInterval(() => {
      setAiProgress(prev => {
        const current = prev[id] ?? 0;
        if (current >= 90) return prev;
        // Progression rapide au début, puis ralentit
        const increment = current < 40 ? 4 : current < 70 ? 2 : 0.8;
        return { ...prev, [id]: Math.min(90, current + increment) };
      });
    }, 300);

    try {
      // Construire la liste des critères avec les valeurs attendues (customExpected pour 2.1-2.4)
      const criteria = RAPPORT_CATEGORIES.flatMap(cat =>
        cat.items.map(item => ({
          id: item.id,
          label: item.label,
          expected: customExpected[item.id]?.trim() || item.expected,
        }))
      );
      const res = await fetch('/api/ai-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, fileName: audit.project_name, discipline, criteria }),
      });
      const data = await res.json();      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);      // Injecter les résultats dans les cellules
      const results: Record<string, { status: string; comment: string }> = data.results ?? {};
      setCells(prev => {
        const next = { ...prev };
        for (const [itemId, val] of Object.entries(results)) {
          const st = val.status as CellStatus;
          if (['ok', 'warning', 'error', 'na', 'unclear'].includes(st)) {
            next[`${itemId}-${audit.id}`] = st;
          }
        }
        return next;
      });      // Stocker les commentaires IA pour chaque critère
      setAiComments(prev => {
        const next = { ...prev };
        for (const [itemId, val] of Object.entries(results)) {
          if (val.comment) next[`${itemId}-${audit.id}`] = val.comment;
        }
        return next;
      });
      // Stocker les niveaux IFC extraits par le parser
      if (data.facts?.storeys?.length) {
        setIfcStoreys(prev => ({ ...prev, [audit.id]: data.facts.storeys }));
      }setAiDone(prev => ({ ...prev, [audit.id]: true }));
      clearInterval(aiProgressRef.current[audit.id]);
      setAiProgress(prev => ({ ...prev, [audit.id]: 100 }));
    } catch (err: unknown) {
      setAiError(prev => ({ ...prev, [audit.id]: err instanceof Error ? err.message : String(err) }));
      clearInterval(aiProgressRef.current[audit.id]);
      setAiProgress(prev => ({ ...prev, [audit.id]: 0 }));
    } finally {
      setAiLoading(prev => ({ ...prev, [audit.id]: false }));
    }
  }

  // Vérifie si le nom de fichier respecte le pattern saisi (* = wildcard)
  function checkNaming(filename: string, pattern: string): CellStatus {
    if (!pattern.trim()) return '';
    const escaped = pattern.trim()
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    const regex = new RegExp(`^${escaped}(\\.ifc)?$`, 'i');
    return regex.test(filename.trim()) ? 'ok' : 'error';
  }

  const scoreForCat = (catItems: typeof RAPPORT_CATEGORIES[0]['items'], maqId: number) => {
    let ok = 0, total = 0;
    catItems.forEach(item => {
      const v = cells[`${item.id}-${maqId}`];
      if (v) { total++; if (v === 'ok') ok++; }
    });
    return total === 0 ? null : Math.round((ok / total) * 100);
  };
  const statusMap: Record<CellStatus, { bg: string; label: string }> = {
    ok:      { bg: 'bg-emerald-100 text-emerald-700', label: '✓' },
    warning: { bg: 'bg-orange-100 text-orange-600',   label: '⚠' },
    error:   { bg: 'bg-red-100 text-red-600',          label: '✗' },
    na:      { bg: 'bg-slate-100 text-slate-400',      label: 'N/A' },
    unclear: { bg: 'bg-violet-50 text-violet-400',     label: '?' },
    '':      { bg: 'bg-white text-slate-300',          label: '—' },
  };

  const sections = RAPPORT_CATEGORIES.reduce<{ section: string; cats: typeof RAPPORT_CATEGORIES }[]>((acc, cat) => {
    const existing = acc.find(s => s.section === cat.section);
    if (existing) existing.cats.push(cat);
    else acc.push({ section: cat.section, cats: [cat] });
    return acc;
  }, []);

  // Génère des données fictives cohérentes à partir des vraies maquettes Supabase
  const cards = audits.map((a, i): MaquetteCardData & { id: number; details: string | null } => {
    const scores = [92, 64, 88, 76, 95, 55];
    const errors = [12, 42, 8, 23, 3, 67];
    const clashs = [4, 18, 2, 9, 1, 24];
    const statuses: MaquetteCardData['status'][] = ['EN COURS', 'EN ATTENTE', 'VALIDÉ', 'CRITIQUE', 'VALIDÉ', 'CRITIQUE'];
    const ago = ['2h', '5h', '1j', '3h', '2j', '30min'];
    const score = scores[i % scores.length];
    const err = errors[i % errors.length];
    const clash = clashs[i % clashs.length];
    const colPct = Math.round(60 + (i * 7) % 35);
    const convPct = Math.round(80 + (i * 5) % 18);
    const compPct = Math.round(45 + (i * 11) % 40);
    return {
      id: a.id, details: a.details,
      name: a.project_name.replace(/\.ifc$/i, '').replace(/_/g, ' '),
      file: a.project_name,
      updatedAgo: `il y a ${ago[i % ago.length]}`,
      status: a.status === 'CRITICAL' ? 'CRITIQUE' : a.status === 'WARNING' ? 'EN COURS' : statuses[i % statuses.length],
      totalErrors: err, clashCritiques: clash, scoreQualite: score,
      collisions: { label: 'Collisions géométriques', pct: colPct, count: `${Math.round(colPct * 3.5)}/${Math.round(colPct * 4)}` },
      conventions: { label: 'Conventions de nommage', pct: convPct, count: `${Math.round(convPct * 14)}/${Math.round(convPct * 14.2)}` },
      completude: { label: 'Complétude des métadonnées', pct: compPct, count: `${Math.round(compPct * 46)}/${Math.round(compPct * 46.7)}` },
      controles: [
        { label: 'Poutres vs Planchers', status: i % 3 === 1 ? 'ok' : i % 3 === 2 ? 'warning' : 'ok', detail: i % 3 === 2 ? 'Vérifier 12 elts' : 'Conforme' },
        { label: 'Classification IFC4', status: i % 4 === 0 ? 'ok' : 'error', detail: i % 4 === 0 ? 'Conforme' : `${3 + i} manquants` },
        { label: 'Paramètres Résistance Feu', status: i % 2 === 0 ? 'warning' : 'ok', detail: i % 2 === 0 ? 'Écarts > 2%' : 'Conforme' },
      ],
    };
  });
  return (
    <div>
      {!chapitresOnly && (
        <div className="flex items-start justify-between mb-8">
          <div>
            <h2 className="text-3xl font-bold text-slate-900">Contrôles par Maquette</h2>
            <p className="text-slate-500 mt-1 max-w-lg text-sm">
              Vue détaillée par maquette et grille de contrôle qualité par chapitre.
            </p>
          </div>
          <div className="flex gap-3 shrink-0">
            <button className="border border-slate-300 text-slate-700 px-5 py-2.5 rounded-lg font-semibold text-sm hover:bg-slate-50 transition-colors flex items-center gap-2">
              <TrendingUp className="h-4 w-4" /> Exporter Rapport PDF
            </button>
            <button onClick={onNewAnalysis} className="bg-slate-900 hover:bg-slate-700 text-white px-5 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 transition-colors">
              <Upload className="h-4 w-4" /> Nouvelle Analyse
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-slate-400 italic animate-pulse">Chargement...</p>
      ) : cards.length === 0 ? (
        <div className="text-center py-20">
          <FileBox className="h-12 w-12 text-slate-300 mx-auto mb-3" />
          <p className="text-slate-500 font-medium">Aucune maquette disponible</p>
          <p className="text-slate-400 text-sm mt-1">Cliquez sur &quot;Nouvelle Analyse&quot; pour charger un fichier IFC.</p>
        </div>      ) : (
        <>
          {/* Cartes par maquette — uniquement hors mode chapitresOnly */}
          {!chapitresOnly && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-12">
              {cards.map(card => (
                <MaquetteCard
                  key={card.id}
                  card={card}
                  onView={() => onView(card.details, card.file)}
                  onDelete={() => onDelete(card.id)}
                />
              ))}
            </div>
          )}          {/* Cartes par chapitre de contrôle */}
          <div className="flex items-center gap-3 mb-6">
            <div className="h-1 w-6 rounded bg-slate-900" />
            <h3 className="text-xl font-black text-slate-900">Grille de contrôle qualité par chapitre</h3>
          </div>

          {/* Boutons Analyse IA par maquette */}
          {maquettes.length > 0 && (
            <div className="flex flex-wrap gap-3 mb-6 p-4 bg-gradient-to-r from-violet-50 to-blue-50 border border-violet-200 rounded-2xl">
              <div className="w-full flex items-center gap-2 mb-1">
                <Sparkles className="h-4 w-4 text-violet-500" />
                <span className="text-sm font-bold text-violet-700">Analyse IA automatique</span>
                <span className="text-xs text-violet-400">— GPT-4o-mini analyse le contenu IFC et pré-remplit les contrôles</span>
              </div>
              {maquettes.map(m => {
                const { discipline } = parseMaquetteDetails(m.details);
                const label = discipline || m.project_name.replace(/\.ifc$/i, '').slice(0, 16);                const isLoading = aiLoading[m.id];
                const isDone = aiDone[m.id];
                const error = aiError[m.id];
                const progress = aiProgress[m.id] ?? 0;
                return (
                  <div key={m.id} className="flex flex-col gap-1">
                    <button
                      onClick={() => runAiAudit(m)}
                      disabled={isLoading}
                      className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all border ${
                        isDone
                          ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                          : isLoading
                          ? 'bg-violet-100 text-violet-400 border-violet-200 cursor-wait'
                          : 'bg-white text-violet-700 border-violet-300 hover:bg-violet-100 hover:border-violet-400 shadow-sm'
                      }`}
                    >
                      {isLoading
                        ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyse en cours…</>
                        : isDone
                        ? <><CheckCircle className="h-3.5 w-3.5" /> {label} — Analysé</>
                        : <><Sparkles className="h-3.5 w-3.5" /> Analyser {label}</>
                      }
                    </button>
                    {/* Barre de progression */}
                    {(isLoading || (isDone && progress === 100)) && (
                      <div className="w-full h-1.5 bg-violet-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all duration-300 ${isDone ? 'bg-emerald-400' : 'bg-violet-400'}`}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    )}
                    {isLoading && (
                      <p className="text-[9px] text-violet-400 text-center leading-tight">{Math.round(progress)}%</p>
                    )}
                    {error && <p className="text-[10px] text-red-500 max-w-[200px] leading-tight">{error}</p>}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-3 text-xs text-slate-500 bg-slate-50 rounded-xl px-4 py-2 border border-slate-200 mb-6 w-fit flex-wrap">
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-emerald-100 text-emerald-700 rounded flex items-center justify-center font-bold text-[10px]">✓</span> Conforme</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-orange-100 text-orange-600 rounded flex items-center justify-center font-bold text-[10px]">⚠</span> Écart</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-red-100 text-red-600 rounded flex items-center justify-center font-bold text-[10px]">✗</span> Non conforme</span>            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-slate-100 text-slate-400 rounded flex items-center justify-center font-bold text-[9px]">N/A</span> Non applicable</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-violet-50 text-violet-400 rounded flex items-center justify-center font-bold text-[10px]">?</span> À vérifier manuellement</span>
          </div>          <div className="space-y-5">
            {RAPPORT_CATEGORIES.map(cat => {
              // ── Carte 5 : tableau niveaux spécial ──────────────────────────
              if (cat.category.startsWith('5 —')) {
                // Collect all unique IFC level names across all maquettes for the select options
                const allIfcLevelNames = Array.from(
                  new Set(
                    maquettes.flatMap(m => (ifcStoreys[m.id] ?? []).map(s => s.name))
                  )
                );
                const hasAnyStoreys = maquettes.some(m => (ifcStoreys[m.id]?.length ?? 0) > 0);

                return (                  <div key={cat.category} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">                    <div className="bg-blue-600 px-5 py-3 flex items-center justify-between">
                      <div>
                        <span className="text-[10px] font-semibold text-blue-200 uppercase tracking-widest">{cat.section}</span>
                        <div className="text-sm font-bold text-white">{cat.category}</div>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs border-collapse">
                        <thead>
                          <tr className="bg-slate-50 border-b-2 border-slate-200">
                            <th className="text-left px-3 py-2.5 font-bold text-slate-400 w-8">#</th>
                            <th className="text-left px-3 py-2.5 font-bold text-slate-700 uppercase tracking-wide text-[10px] min-w-[170px]">
                              NOM NIVEAU IFC
                            </th>                            <th className="text-right px-3 py-2.5 font-bold text-slate-700 uppercase tracking-wide text-[10px] min-w-[160px]">
                              <div className="flex items-center justify-end gap-2">
                                <span>ALT. NIVEAU</span>
                                <button
                                  onClick={saveExpectedLevels}
                                  disabled={levelsSaving}
                                  className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all border ${
                                    levelsSaved
                                      ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                                      : levelsSaving
                                      ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-wait'
                                      : 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
                                  }`}
                                  title="Sauvegarder les niveaux attendus sur Supabase"
                                >
                                  {levelsSaved ? '✓' : levelsSaving ? '…' : '💾'}
                                </button>
                              </div>
                            </th>
                            {maquettes.map(m => {
                              const { discipline } = parseMaquetteDetails(m.details);
                              return (
                                <th key={m.id} className="text-center px-3 py-2.5 font-bold text-slate-600 min-w-[90px]">
                                  {discipline && <div className="text-[9px] font-bold text-blue-500 uppercase tracking-wide">{discipline}</div>}
                                  <span className="text-[10px] font-medium text-slate-500 block truncate max-w-[80px] mx-auto" title={m.project_name}>
                                    {m.project_name.replace(/\.ifc$/i, '').slice(0, 14)}
                                  </span>
                                </th>
                              );
                            })}
                            {maquettes.length === 0 && (
                              <th className="text-center px-3 py-2.5 text-slate-300 italic font-normal text-[10px]">← Chargez des maquettes</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>                          {expectedLevels.map((lvl, i) => {
                            // autoElev : altitude NGF en mm, issue du parser IFC
                            const autoElev: number | null = (() => {
                              if (!lvl.name) return null;
                              for (const m of maquettes) {
                                const found = (ifcStoreys[m.id] ?? []).find(
                                  s => s.name.toLowerCase() === lvl.name.toLowerCase()
                                );
                                if (found && found.elevation !== null) return found.elevation;
                              }
                              return null;
                            })();
                            // displayElev : valeur affichée en mm (saisie manuelle ou auto)
                            const displayElevMm: number | null = lvl.elevation
                              ? parseFloat(lvl.elevation)
                              : autoElev;

                            return (
                              <tr key={i} className={`border-t border-slate-100 ${i % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                                <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-middle">{i + 1}</td>

                                {/* NOM NIVEAU IFC */}
                                <td className="px-3 py-2 align-middle">
                                  {hasAnyStoreys ? (
                                    <select
                                      value={lvl.name}
                                      onChange={e => setExpectedLevels(prev => prev.map((l, j) =>
                                        j === i ? { ...l, name: e.target.value, elevation: '' } : l
                                      ))}
                                      className={`w-full text-xs border rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white cursor-pointer ${
                                        lvl.name ? 'border-blue-200 text-slate-800 font-semibold' : 'border-slate-200 text-slate-400'
                                      }`}
                                    >
                                      <option value="">— Absent / choisir —</option>
                                      {allIfcLevelNames.map(name => (
                                        <option key={name} value={name}>{name}</option>
                                      ))}
                                    </select>
                                  ) : (
                                    <input
                                      type="text"
                                      value={lvl.name}
                                      onChange={e => setExpectedLevels(prev => prev.map((l, j) =>
                                        j === i ? { ...l, name: e.target.value } : l
                                      ))}
                                      placeholder="ex: RDC, R+1…"
                                      className="w-full text-xs border border-blue-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-slate-300 bg-blue-50"
                                    />
                                  )}
                                </td>                                {/* ALT. NIVEAU — saisie et affichage en mm NGF */}
                                <td className="px-3 py-2 align-middle">
                                  {hasAnyStoreys && !lvl.elevation && autoElev !== null ? (
                                    <span className="block text-right text-xs font-mono text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-2.5 py-1.5 select-none">
                                      {autoElev}
                                    </span>
                                  ) : (
                                    <input
                                      type="text"
                                      value={lvl.elevation}
                                      onChange={e => setExpectedLevels(prev => prev.map((l, j) =>
                                        j === i ? { ...l, elevation: e.target.value } : l
                                      ))}
                                      placeholder={hasAnyStoreys ? (autoElev !== null ? String(autoElev) : '—') : 'ex: 47300'}
                                      className="w-full text-right text-xs border border-blue-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-slate-300 bg-blue-50 font-mono"
                                    />
                                  )}
                                </td>                                {/* Statut par maquette */}
                                {maquettes.map(m => {
                                  const storeys = ifcStoreys[m.id] ?? [];
                                  const found = storeys.find(s =>
                                    lvl.name && s.name.toLowerCase() === lvl.name.toLowerCase()
                                  ) ?? null;

                                  // Comparaison en mm — tolérance ±50 mm
                                  const ifcElev = found?.elevation ?? null;
                                  const nameOk = !!lvl.name && !!found;
                                  const elevOk = displayElevMm === null || (ifcElev !== null && Math.abs(ifcElev - displayElevMm) <= 50);// Use aiLoading/aiDone per maquette to distinguish pending vs missing:
                                  // - No storeys + aiLoading  => pending (IA running)
                                  // - No storeys + aiDone     => missing (IA finished but no levels) or na if no expected name
                                  // - No storeys otherwise    => pending (IA not started yet)
                                  let overall: 'ok' | 'warning' | 'error' | 'missing' | 'pending' | 'na';
                                  const storeysCount = (storeys?.length) ?? 0;
                                  if (storeysCount === 0) {
                                    if (aiLoading[m.id]) {
                                      overall = 'pending';
                                    } else if (aiDone[m.id]) {
                                      overall = !lvl.name ? 'na' : 'missing';
                                    } else {
                                      overall = 'pending';
                                    }
                                  } else {
                                    if (!lvl.name) overall = 'na';
                                    else if (!found) overall = 'missing';
                                    else if (nameOk && elevOk) overall = 'ok';
                                    else if (nameOk) overall = 'warning';
                                    else overall = 'error';
                                  }

                                  type StatusKey = 'ok' | 'warning' | 'error' | 'missing' | 'pending' | 'na';
                                  const statusStyle: Record<StatusKey, string> = {
                                    ok:      'bg-emerald-100 text-emerald-700 border border-emerald-200',
                                    warning: 'bg-orange-100 text-orange-600 border border-orange-200',
                                    error:   'bg-red-100 text-red-600 border border-red-200',
                                    missing: 'bg-red-50 text-red-400 border border-red-100',
                                    pending: 'bg-slate-100 text-slate-300',
                                    na:      'bg-slate-50 text-slate-300',
                                  };
                                  const statusLabel: Record<StatusKey, string> = {
                                    ok: '✓', warning: '⚠', error: '✗', missing: '✗', pending: '…', na: '—',
                                  };                                  const statusTitle: Record<StatusKey, string> = {
                                    ok: 'Nom et altimétrie NGF conformes',
                                    warning: `Nom trouvé mais altimétrie non conforme${ifcElev !== null ? ` (IFC: ${ifcElev} mm)` : ''}`,
                                    error: 'Non conforme',
                                    missing: 'Niveau absent dans ce fichier IFC',
                                    pending: 'Lancer l\'analyse IA pour extraire les niveaux',
                                    na: '—',
                                  };

                                  return (
                                    <td key={m.id} className="px-3 py-2 text-center align-middle">
                                      <span
                                        title={statusTitle[overall as StatusKey]}
                                        className={`inline-flex items-center justify-center w-8 h-8 rounded-lg text-[12px] font-bold cursor-default ${statusStyle[overall as StatusKey]}`}
                                      >
                                        {statusLabel[overall as StatusKey]}
                                      </span>
                                      {found && overall !== 'ok' && ifcElev !== null && (
                                        <div className="text-[9px] text-slate-400 font-mono mt-0.5">{ifcElev}</div>
                                      )}
                                    </td>
                                  );
                                })}
                                {maquettes.length === 0 && (
                                  <td className="px-3 py-2 text-slate-300 italic text-center">—</td>
                                )}
                              </tr>
                            );
                          })}                        </tbody>
                        {/* Niveaux IFC présents dans les maquettes mais absents des attendus */}
                        {hasAnyStoreys && (() => {
                          const definedNames = new Set(
                            expectedLevels.map(l => l.name.trim().toLowerCase()).filter(Boolean)
                          );
                          // Pour chaque maquette, collecter les niveaux non définis
                          const extraByMaquette = maquettes.map(m => ({
                            m,
                            extras: (ifcStoreys[m.id] ?? []).filter(
                              s => s.name && !definedNames.has(s.name.trim().toLowerCase())
                            ),
                          })).filter(({ extras }) => extras.length > 0);

                          if (extraByMaquette.length === 0) return null;
                          return (
                            <tfoot>
                              <tr className="border-t-2 border-orange-200 bg-orange-50/60">
                                <td colSpan={3 + maquettes.length} className="px-3 py-2">
                                  <p className="text-[10px] font-bold text-orange-600 uppercase tracking-wide mb-1.5">
                                    ⚠ Niveaux IFC présents dans la maquette mais non définis dans les attendus
                                  </p>
                                  <div className="flex flex-wrap gap-4">
                                    {extraByMaquette.map(({ m, extras }) => {
                                      const { discipline } = parseMaquetteDetails(m.details);
                                      return (
                                        <div key={m.id} className="text-[10px]">
                                          <span className="font-semibold text-orange-700">
                                            {discipline || m.project_name.replace(/\.ifc$/i, '').slice(0, 14)}
                                          </span>
                                          <span className="text-orange-500 ml-1">
                                            {extras.map(s => `${s.name}${s.elevation !== null ? ` (${s.elevation} mm)` : ''}`).join(' · ')}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </td>
                              </tr>
                            </tfoot>
                          );
                        })()}
                        <tfoot>
                          <tr className="border-t border-slate-200 bg-slate-50">
                            <td colSpan={3 + maquettes.length} className="px-3 py-2">                              <div className="flex items-center gap-4">
                                <button
                                  onClick={() => setExpectedLevels(prev => [...prev, { name: '', elevation: '' }])}
                                  className="text-xs text-blue-600 hover:text-blue-800 font-semibold transition-colors"
                                >
                                  + Ajouter un niveau
                                </button>
                                {expectedLevels.length > 1 && (
                                  <button
                                    onClick={() => setExpectedLevels(prev => prev.slice(0, -1))}
                                    className="text-xs text-red-400 hover:text-red-600 font-semibold transition-colors"
                                  >
                                    − Supprimer le dernier
                                  </button>
                                )}
                                {hasAnyStoreys && (
                                  <span className="ml-auto text-[10px] text-slate-400">
                                    Alt. en mm NGF · tolérance ±50 mm
                                  </span>
                                )}
                              </div>
                            </td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>

                    {/* Niveaux IFC extraits — section synthèse */}
                    {hasAnyStoreys && (
                      <div className="px-5 py-3 border-t border-slate-100 bg-slate-50/60">
                        <p className="text-[10px] font-bold text-slate-500 mb-2 uppercase tracking-wide">
                          Niveaux IFC extraits
                        </p>
                        <div className="flex flex-wrap gap-6">
                          {maquettes.map(m => {
                            const storeys = ifcStoreys[m.id];
                            if (!storeys?.length) return null;
                            const { discipline } = parseMaquetteDetails(m.details);
                            return (
                              <div key={m.id} className="text-[10px]">
                                <p className="font-semibold text-blue-600 mb-1.5">
                                  {discipline || m.project_name.replace(/\.ifc$/i, '').slice(0, 14)}
                                </p>
                                <div className="flex flex-col gap-0.5">
                                  {storeys.map((s, si) => (
                                    <div key={si} className="flex items-center gap-2 font-mono text-slate-600 bg-white border border-slate-200 rounded px-2 py-1">
                                      <span className="font-semibold text-slate-700 min-w-[60px]">{s.name || '(sans nom)'}</span>
                                      <span className="text-slate-400">·</span>
                                      <span className="text-blue-700">{s.elevation !== null ? `${s.elevation} mm` : '—'}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              return (
                    <div key={cat.category} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                      <div className="bg-blue-600 px-5 py-3 flex items-center justify-between">
                        <div>                          <span className="text-[10px] font-semibold text-blue-200 uppercase tracking-widest">{cat.section}</span>
                          <div className="text-sm font-bold text-white">{cat.category}</div>
                        </div>                        <div className="flex items-center gap-3">
                          {maquettes.map(m => {
                            const s = scoreForCat(cat.items, m.id);
                            const { discipline } = parseMaquetteDetails(m.details);
                            const color = s === null ? 'text-white/50' : s >= 80 ? 'text-emerald-300' : s >= 60 ? 'text-orange-300' : 'text-red-300';
                            const label = discipline || m.project_name.replace(/\.ifc$/i, '').slice(0, 8);
                            return (
                              <span key={m.id} className={`text-xs font-black ${color}`} title={m.project_name.replace(/\.ifc$/i, '')}>
                                {label} : {s === null ? '—' : `${s}%`}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs border-collapse">
                          <thead>                            <tr className="bg-slate-50 border-b border-slate-200">
                              <th className="text-left px-3 py-2 font-bold text-slate-400 w-12">N°</th>
                              <th className="text-left px-3 py-2 font-bold text-slate-600 min-w-[200px]">Item de contrôle</th>
                              <th className="text-left px-3 py-2 font-bold text-blue-600 min-w-[200px]">
                                {(() => {
                                  const catNum = cat.category.match(/^(\d+)/)?.[1] ?? '';
                                  const editableIds: Record<string, string[]> = {
                                    '1': ['1.1'],
                                    '2': ['2.1','2.2','2.3','2.4'],
                                    '3': ['3.1','3.2','3.3','3.4','3.5'],
                                    '4': ['4.1','4.2'],
                                  };
                                  const ids = editableIds[catNum];
                                  if (!ids) return <span>Attendu</span>;
                                  const isSaving = cardSaving[catNum];
                                  const isSaved = cardSaved[catNum];
                                  return (
                                    <div className="flex items-center gap-2">
                                      <span>Attendu</span>
                                      <button
                                        onClick={() => saveCardExpected(catNum, ids)}
                                        disabled={isSaving}
                                        className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-all border ${
                                          isSaved
                                            ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                                            : isSaving
                                            ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-wait'
                                            : 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
                                        }`}
                                        title="Sauvegarder tous les attendus de cette carte"
                                      >
                                        {isSaved ? '✓' : isSaving ? '…' : '💾'}
                                      </button>
                                    </div>
                                  );
                                })()}
                              </th>
                              {maquettes.length === 0
                                ? <th className="text-center px-3 py-2 text-slate-300 italic font-normal">← Chargez des maquettes</th>
                                : maquettes.map(m => {
                                    const { discipline } = parseMaquetteDetails(m.details);
                                    return (
                                      <th key={m.id} className="text-center px-2 py-2 font-bold text-slate-600 min-w-[90px]">
                                        {discipline && (
                                          <div className="text-[9px] font-bold text-blue-500 uppercase tracking-wide truncate max-w-[82px] mx-auto">{discipline}</div>
                                        )}
                                        <span className="truncate block max-w-[82px] mx-auto text-[10px] font-medium text-slate-500" title={m.project_name}>
                                          {m.project_name.replace(/\.ifc$/i, '').slice(0, 12)}
                                        </span>
                                      </th>
                                    );
                                  })
                              }
                            </tr>                          </thead>
                          <tbody>
                            {cat.items.map((item, ii) => {
                              // ── 1.1 : pattern de nommage éditable ──
                              if (item.id === '1.1') {
                                return (
                                  <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                                    <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-top whitespace-nowrap">{item.id}</td>
                                    <td className="px-3 py-2 text-slate-700 font-medium align-top leading-snug">{item.label}</td>
                                    <td className="px-3 py-3 align-top">
                                      <div className="text-[10px] text-slate-400 italic mb-1.5 leading-snug">{item.expected}</div>
                                      <input
                                        type="text"
                                        value={namingPattern}
                                        onChange={e => { setNamingPattern(e.target.value); setPatternSaved(false); }}
                                        placeholder="ex: PRJ_*_ARC_* ou OTEIS_*"
                                        className="w-full text-xs border border-blue-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-slate-300 bg-blue-50 font-mono"
                                      />
                                      <p className="text-[9px] text-slate-400 mt-1">Utilisez <code className="bg-slate-100 px-1 rounded">*</code> comme joker. Ex&nbsp;: <code className="bg-slate-100 px-1 rounded">PRJ_*_ARC_EXE</code></p>
                                    </td>
                                    {maquettes.map(m => {
                                      const status = checkNaming(m.project_name, namingPattern);
                                      const statusStyles: Record<CellStatus, { bg: string; label: string }> = {
                                        ok:      { bg: 'bg-emerald-100 text-emerald-700', label: '✓' },
                                        error:   { bg: 'bg-red-100 text-red-600',         label: '✗' },
                                        warning: { bg: 'bg-orange-100 text-orange-600',   label: '⚠' },
                                        na:      { bg: 'bg-slate-100 text-slate-400',      label: 'N/A' },
                                        unclear: { bg: 'bg-violet-50 text-violet-400',    label: '?' },
                                        '':      { bg: 'bg-slate-50 text-slate-300',       label: '—' },
                                      };
                                      const { bg, label } = statusStyles[status];
                                      const comment = aiComments[`${item.id}-${m.id}`];
                                      return (
                                        <td key={m.id} className="px-1.5 py-2 align-top">
                                          <div className={`w-full h-7 rounded text-[11px] font-bold flex items-center justify-center ${bg}`}>
                                            {label}
                                          </div>
                                          {comment && (
                                            <p className="text-[9px] text-violet-600 mt-1 leading-tight px-0.5 italic">{comment}</p>
                                          )}
                                          {!comment && status === 'error' && namingPattern && (
                                            <p className="text-[8px] text-red-400 mt-1 text-center leading-tight break-all px-1">Non conforme</p>
                                          )}
                                          {!comment && status === 'ok' && (
                                            <p className="text-[8px] text-emerald-500 mt-1 text-center leading-tight">Conforme</p>
                                          )}
                                        </td>
                                      );
                                    })}
                                    {maquettes.length === 0 && (
                                      <td className="px-3 py-2 text-slate-300 italic text-center">—</td>
                                    )}
                                  </tr>
                                );
                              }
                              // ── 1.2 : format IFC — auto OK ──
                              if (item.id === '1.2') {
                                return (
                                  <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                                    <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-middle whitespace-nowrap">{item.id}</td>
                                    <td className="px-3 py-2 text-slate-700 font-medium align-middle leading-snug">{item.label}</td>
                                    <td className="px-3 py-2 text-slate-400 italic align-middle leading-snug">{item.expected}</td>
                                    {maquettes.map(m => (
                                      <td key={m.id} className="px-1.5 py-1.5 align-top">
                                        <div className="w-full h-7 rounded text-[11px] font-bold flex items-center justify-center bg-emerald-100 text-emerald-700" title="Seuls les fichiers .ifc sont acceptés">
                                          ✓
                                        </div>
                                        {aiComments[`${item.id}-${m.id}`] && (
                                          <p className="text-[9px] text-violet-600 mt-1 leading-tight px-0.5 italic">{aiComments[`${item.id}-${m.id}`]}</p>
                                        )}
                                      </td>
                                    ))}
                                    {maquettes.length === 0 && (
                                      <td className="px-3 py-2 text-slate-300 italic text-center">—</td>
                                    )}
                                  </tr>
                                );
                              }
                              // ── 1.3 : taille du fichier — cliquable manuellement ──
                              if (item.id === '1.3') {
                                return (
                                  <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                                    <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-middle whitespace-nowrap">{item.id}</td>
                                    <td className="px-3 py-2 text-slate-700 font-medium align-middle leading-snug">{item.label}</td>
                                    <td className="px-3 py-2 align-middle leading-snug">
                                      <span className="text-slate-400 italic">{item.expected}</span>
                                      <p className="text-[9px] text-orange-400 mt-0.5">⚠ Vérification manuelle requise</p>
                                    </td>
                                    {maquettes.map(m => {
                                      const st = cells[`${item.id}-${m.id}`] ?? '';
                                      const cycle: CellStatus[] = ['', 'ok', 'warning', 'error', 'na', 'unclear'];
                                      const next = () => setCell(item.id, m.id, cycle[(cycle.indexOf(st) + 1) % cycle.length]);
                                      const { bg, label } = statusMap[st];
                                      const comment = aiComments[`${item.id}-${m.id}`];
                                      return (
                                        <td key={m.id} className="px-1.5 py-1.5 align-top">
                                          <button onClick={next} title="Cliquer pour renseigner manuellement"
                                            className={`w-full h-7 rounded text-[11px] font-bold transition-colors ${bg} hover:opacity-80`}>
                                            {label}
                                          </button>
                                          {comment && (
                                            <p className="text-[9px] text-violet-600 mt-1 leading-tight px-0.5 italic">{comment}</p>
                                          )}
                                        </td>
                                      );
                                    })}
                                    {maquettes.length === 0 && (
                                      <td className="px-3 py-2 text-slate-300 italic text-center">—</td>
                                    )}
                                  </tr>
                                );
                              }
                              // ── 2.x / 3.x / 4.x : champ attendu éditable (sauvegarde via bouton carte) ──
                              if (['2.1','2.2','2.3','2.4','3.1','3.2','3.3','3.4','3.5','4.1','4.2'].includes(item.id)) {
                                const val = customExpected[item.id] ?? '';
                                return (
                                  <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                                    <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-top whitespace-nowrap">{item.id}</td>
                                    <td className="px-3 py-2 text-slate-700 font-medium align-top leading-snug">{item.label}</td>
                                    <td className="px-3 py-3 align-top">
                                      <div className="text-[10px] text-slate-400 italic mb-1.5 leading-snug">{item.expected}</div>
                                      <input
                                        type="text"
                                        value={val}
                                        onChange={e => setCustomExpected(prev => ({ ...prev, [item.id]: e.target.value }))}
                                        placeholder="Renseigner l'attendu…"
                                        className="w-full text-xs border border-blue-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-slate-300 bg-blue-50"
                                      />
                                    </td>
                                    {maquettes.map(m => {
                                      const hasExpected = !!(customExpected[item.id]?.trim());
                                      if (!hasExpected) {
                                        return (
                                          <td key={m.id} className="px-1.5 py-1.5 align-top">
                                            <div className="w-full h-7 rounded text-[10px] font-semibold flex items-center justify-center bg-slate-100 text-slate-400 italic" title="Aucune exigence renseignée">
                                              S/O
                                            </div>
                                          </td>
                                        );
                                      }
                                      const st = cells[`${item.id}-${m.id}`] ?? '';
                                      const cycle: CellStatus[] = ['', 'ok', 'warning', 'error', 'na', 'unclear'];
                                      const next = () => setCell(item.id, m.id, cycle[(cycle.indexOf(st) + 1) % cycle.length]);
                                      const { bg, label } = statusMap[st];
                                      const comment = aiComments[`${item.id}-${m.id}`];
                                      return (
                                        <td key={m.id} className="px-1.5 py-1.5 align-top">
                                          <button onClick={next} title="Cliquer pour changer le statut"
                                            className={`w-full h-7 rounded text-[11px] font-bold transition-colors ${bg} hover:opacity-80`}>
                                            {label}
                                          </button>
                                          {comment && (
                                            <p className="text-[9px] text-violet-600 mt-1 leading-tight px-0.5 italic">{comment}</p>
                                          )}
                                        </td>
                                      );
                                    })}
                                    {maquettes.length === 0 && (
                                      <td className="px-3 py-2 text-slate-300 italic text-center">—</td>
                                    )}
                                  </tr>
                                );
                              }
                              // ── Cas général : cellule cliquable ──
                              return (
                                <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-blue-50/30 transition-colors`}>
                                  <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-middle whitespace-nowrap">{item.id}</td>
                                  <td className="px-3 py-2 text-slate-700 font-medium align-middle leading-snug">{item.label}</td>
                                  <td className="px-3 py-2 text-slate-400 italic align-top leading-snug">{item.expected}</td>
                                  {maquettes.map(m => {
                                    const st = cells[`${item.id}-${m.id}`] ?? '';
                                    const cycle: CellStatus[] = ['', 'ok', 'warning', 'error', 'na', 'unclear'];
                                    const next = () => setCell(item.id, m.id, cycle[(cycle.indexOf(st) + 1) % cycle.length]);
                                    const { bg, label } = statusMap[st];
                                    const comment = aiComments[`${item.id}-${m.id}`];
                                    return (
                                      <td key={m.id} className="px-1.5 py-1.5 align-top">
                                        <button onClick={next} title="Cliquer pour changer le statut"
                                          className={`w-full h-7 rounded text-[11px] font-bold transition-colors ${bg} hover:opacity-80`}>
                                          {label}
                                        </button>
                                        {comment && (
                                          <p className="text-[9px] text-violet-600 mt-1 leading-tight px-0.5 italic">{comment}</p>
                                        )}
                                      </td>
                                    );
                                  })}
                                  {maquettes.length === 0 && (
                                    <td className="px-3 py-2 text-slate-300 italic text-center">—</td>
                                  )}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Dashboard principal ──────────────────────────────────────────────────────
export default function Dashboard() {
  const [activeTab, setActiveTab] = useState<string>('Tableau de bord');
  const [showForm, setShowForm] = useState(false);
  const [audits, setAudits] = useState<Audit[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFiles, setSelectedFiles] = useState<SelectedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [viewerFiles, setViewerFiles] = useState<FileEntry[]>([]);
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
      ...ifc.map(f => ({ file: f, status: 'OK' as const, discipline: '', uploading: false, done: false, error: null, progress: 0 }))
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

  function updateFileDiscipline(index: number, discipline: string) {
    setSelectedFiles(prev => prev.map((f, i) => i === index ? { ...f, discipline } : f));
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

    // Vérification discipline obligatoire
    const missing = selectedFiles.filter(f => !f.discipline.trim());
    if (missing.length > 0) {
      return alert(`⚠️ Discipline obligatoire !\n\nVeuillez renseigner la discipline pour :\n${missing.map(f => `• ${f.file.name}`).join('\n')}`);
    }

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
        const downloadUrl = slData.downloadUrl || '';        // Insérer en base Supabase
        const { error: dbError } = await supabase.from('audits').insert({
          project_name: sf.file.name,
          status: sf.status,
          details: `box:${boxFileId}:${sf.discipline}:${downloadUrl}`,
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
      const { fileId } = parseMaquetteDetails(details);
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
    try {      // Supprimer le fichier sur Box si disponible
      if (deleteTarget.details?.startsWith('box:')) {
        const { fileId: boxFileId } = parseMaquetteDetails(deleteTarget.details);
        if (boxFileId) {
          const boxRes = await fetch('/api/box/delete', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId: boxFileId }),
          });          if (!boxRes.ok) {
            const err = await boxRes.json().catch(() => ({}));
            const errMsg: string = err.error ?? String(boxRes.status);
            // Si erreur d'auth Box, bloquer la suppression et demander reconnexion
            if (boxRes.status === 401 || errMsg.toLowerCase().includes('token')) {
              throw new Error(`SESSION_BOX_EXPIRÉE`);
            } else {
              throw new Error(`Erreur Box : ${errMsg}`);
            }
          }
        }
      }
      // Supprimer de Supabase
      const { error } = await supabase.from('audits').delete().eq('id', deleteTarget.id);
      if (error) throw new Error(`Erreur Supabase : ${error.message}`);
      // Retirer du viewer si ouvert
      if (deleteTarget.details?.startsWith('box:')) {
        const { fileId: boxFileId } = parseMaquetteDetails(deleteTarget.details);
        setViewerFiles(prev => prev.filter(f => f.fileId !== boxFileId));
      }
      setDeleteTarget(null);
      fetchAudits();    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur inconnue';
      if (msg === 'SESSION_BOX_EXPIRÉE') {
        alert('⚠️ Session Box expirée.\n\nVeuillez vous reconnecter à Box (bouton dans le header) avant de supprimer cette maquette.\n\nAucune donnée n\'a été supprimée.');
      } else {
        alert(msg);
      }
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
          </button>          <button className="w-full flex items-center px-4 py-3 text-sm font-medium bg-slate-100 text-blue-600 rounded-lg">
            <Ruler className="mr-3 h-5 w-5" /> Audit Géométrique
          </button>
          <button className="w-full flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <Database className="mr-3 h-5 w-5" /> Vérification Métadonnées
          </button>
          <button className="w-full flex items-center px-4 py-3 text-sm font-medium text-slate-600 hover:bg-slate-50 rounded-lg">
            <CheckCircle2 className="mr-3 h-5 w-5" /> Validation
          </button>
        </nav>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-8">
          <div className="flex items-center space-x-2 text-slate-800 font-bold uppercase tracking-tight">
             <div className="w-6 h-6 bg-blue-600 rounded flex items-center justify-center text-white text-[10px]">IFC</div>
             <span>IFC Quality Control</span>
          </div>          <nav className="flex space-x-6 text-sm font-medium text-slate-500">
            {['Tableau de bord', 'Maquettes', 'Rapports', 'Conformité', 'Paramètres', 'LLM'].map(t => (
              <span
                key={t}
                onClick={() => setActiveTab(t)}
                className={`py-5 cursor-pointer border-b-2 transition-colors ${
                  activeTab === t
                    ? 'text-blue-600 border-blue-600'
                    : 'border-transparent hover:text-slate-800'
                }`}
              >{t}</span>
            ))}
          </nav>
          <div className="flex items-center space-x-3">
            {/* Bouton statut connexion Box */}
            {boxReady ? (
              <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0"></span>
                <span className="text-xs font-medium text-emerald-700">Box connecté</span>
              </div>
            ) : (
              <button
                onClick={handleConnectBox}
                className="flex items-center gap-2 bg-orange-50 border border-orange-300 hover:bg-orange-100 text-orange-700 rounded-lg px-3 py-1.5 text-xs font-bold transition-colors"
                title="Session Box expirée — cliquez pour vous reconnecter"
              >
                <span className="w-2 h-2 rounded-full bg-orange-400 shrink-0"></span>
                Se connecter à Box
              </button>
            )}
            <Bell className="h-5 w-5 text-slate-400" />
            <UserCircle className="h-6 w-6 text-slate-400" />
          </div>
        </header>        <div className="flex-1 overflow-y-auto p-8">          {activeTab === 'Maquettes' ? (
            <>
              <div className="flex justify-between items-end mb-8">
                <div>
                  <h2 className="text-3xl font-bold text-slate-900">Maquettes Fédérées</h2>
                  <p className="text-slate-500">Liste des fichiers IFC chargés dans le projet</p>
                </div>
                <button
                  onClick={() => setShowForm(true)}
                  className="bg-[#f95700] hover:bg-orange-700 text-white px-6 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 shadow-sm transition-all"
                >
                  <Upload className="h-4 w-4" /> + Charger une nouvelle maquette
                </button>
              </div>
              {loading ? (
                <p className="text-slate-400 italic animate-pulse">Chargement depuis Supabase...</p>
              ) : audits.length === 0 ? (
                <p className="text-slate-400 italic">Aucune maquette. Cliquez sur &quot;+ Charger&quot; pour commencer.</p>
              ) : (                <div className="grid grid-cols-4 gap-6 mb-12">
                  {audits.map((a) => {
                    const style = getStyle(a.status);
                    const { discipline } = parseMaquetteDetails(a.details);
                    return (
                      <div key={a.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative group">
                        <div className="flex justify-between items-start mb-4">
                          <div className={`p-2 rounded-full ${style.bg}`}>{style.icon}</div>
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-bold px-2 py-1 rounded ${style.bg} ${style.color}`}>{style.label}</span>
                            <button onClick={() => handleView(a.details, a.project_name)} className="text-blue-400 hover:text-blue-600 transition-colors" title="Visualiser"><Eye className="h-4 w-4" /></button>
                            <button onClick={() => handleDelete(a.id)} className="text-red-400 hover:text-red-600 transition-colors" title="Supprimer"><X className="h-4 w-4" /></button>
                          </div>
                        </div>
                        {discipline && (
                          <p className="text-[10px] font-bold text-blue-500 uppercase tracking-wide mb-0.5">{discipline}</p>
                        )}
                        <h4 className="font-bold text-slate-800">{a.project_name}</h4>
                        <p className="text-[10px] text-slate-400 mb-2 italic">
                          {new Date(a.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </p>
                      </div>
                    );
                  })}                </div>              )}
              {/* Grille de contrôle qualité par chapitre */}
              <MaquettesView
                audits={audits}
                loading={loading}
                onNewAnalysis={() => setShowForm(true)}
                onView={handleView}
                onDelete={handleDelete}
                chapitresOnly
              />
            </>          ) : activeTab === 'Rapports' ? (
            <RapportsView audits={audits} loading={loading} />          ) : activeTab === 'Paramètres' ? (
            <ParametresView audits={audits} loading={loading} />          ) : activeTab === 'LLM' ? (
            <LlmView audits={audits} />
          ) : (
            <>
          <div className="flex justify-between items-end mb-8">
            <div>
              <h2 className="text-3xl font-bold text-slate-900">Tableau de bord</h2>
              <p className="text-slate-500">Indicateurs de performance globale du projet</p>
            </div>
            <button
              onClick={() => setShowForm(true)}
              className="bg-[#f95700] hover:bg-orange-700 text-white px-6 py-2.5 rounded-lg font-bold text-sm flex items-center gap-2 shadow-sm transition-all"
            >
              <Upload className="h-4 w-4" /> + Charger une nouvelle maquette
            </button>
          </div>
          {/* STATS CARDS */}
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
          </div>          {/* CARTES SIMPLES — MAQUETTES FÉDÉRÉES */}
          <h3 className="text-xl font-bold mb-6 mt-2">Maquettes Fédérées</h3>
          {loading ? (
            <p className="text-slate-400 italic animate-pulse">Chargement depuis Supabase...</p>
          ) : audits.length === 0 ? (
            <p className="text-slate-400 italic mb-10">Aucune maquette. Cliquez sur &quot;+ Charger&quot; pour commencer.</p>
          ) : (            <div className="grid grid-cols-4 gap-6 mb-10">
              {audits.map((a) => {
                const style = getStyle(a.status);
                const { discipline } = parseMaquetteDetails(a.details);
                return (
                  <div key={a.id} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm relative group">
                    <div className="flex justify-between items-start mb-4">
                      <div className={`p-2 rounded-full ${style.bg}`}>{style.icon}</div>
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] font-bold px-2 py-1 rounded ${style.bg} ${style.color}`}>{style.label}</span>
                        <button onClick={() => handleView(a.details, a.project_name)} className="text-blue-400 hover:text-blue-600 transition-colors" title="Visualiser"><Eye className="h-4 w-4" /></button>
                        <button onClick={() => handleDelete(a.id)} className="text-red-400 hover:text-red-600 transition-colors" title="Supprimer"><X className="h-4 w-4" /></button>
                      </div>
                    </div>
                    {discipline && (
                      <p className="text-[10px] font-bold text-blue-500 uppercase tracking-wide mb-0.5">{discipline}</p>
                    )}
                    <h4 className="font-bold text-slate-800">{a.project_name}</h4>
                    <p className="text-[10px] text-slate-400 mb-2 italic">
                      {new Date(a.created_at).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </p>
                  </div>
                );
              })}
            </div>
          )}            </>
          )}
        </div>
      </main>{/* MODALE UPLOAD */}
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
                {selectedFiles.map((sf, i) => (                  <div key={i} className="flex flex-col bg-slate-50 rounded-lg px-3 py-2 border border-slate-200 gap-1.5">
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
                    </div>                    {/* Champ discipline */}
                    {!sf.done && (
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wide shrink-0 w-20">
                          Discipline <span className="text-red-500">*</span>
                        </label>
                        <input
                          type="text"
                          value={sf.discipline}
                          onChange={e => updateFileDiscipline(i, e.target.value)}
                          placeholder="ex: Architecture, Structure, MEP…"
                          disabled={sf.uploading}
                          className={`flex-1 text-xs border rounded px-2 py-1 bg-white placeholder-slate-300 focus:outline-none focus:border-blue-400 disabled:opacity-50 ${
                            !sf.discipline.trim() ? 'border-red-300 bg-red-50' : 'border-slate-200'
                          }`}
                        />
                        {!sf.discipline.trim() && (
                          <span className="text-[9px] text-red-500 font-semibold shrink-0">Requis</span>
                        )}
                      </div>
                    )}
                    {sf.done && sf.discipline && (
                      <p className="text-[10px] text-blue-500 font-semibold uppercase tracking-wide">Discipline : {sf.discipline}</p>
                    )}
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
          onRemoveFile={(fileId) => setViewerFiles(prev => prev.filter(f => f.fileId !== fileId))}          availableFiles={audits
            .filter(a => a.details?.startsWith('box:'))
            .map(a => ({ fileId: parseMaquetteDetails(a.details).fileId, fileName: a.project_name }))
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
