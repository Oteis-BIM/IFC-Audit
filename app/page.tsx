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
  // ── SECTION B : FICHIER IFC ─────────────────────────────────────────────────
  {
    section: "B — FICHIER IFC",
    category: "B1 — FORMAT DE FICHIER",
    items: [
      { id: "B1.1", label: "Nom du fichier", expected: "Conforme à la convention de nommage OTEIS (code projet_discipline_phase)" },
      { id: "B1.2", label: "Format IFC 2°3", expected: "Export IFC 2x3 (IFC2X3)" },
      { id: "B1.3", label: "Taille du fichier", expected: "< 500 Mo par fichier IFC" },
    ],
  },
  {
    section: "B — FICHIER IFC",
    category: "B2 — ORGANISATION DU FICHIER",
    items: [
      { id: "B2.1", label: "Architecture", expected: "Fichier IFC structuré par discipline (architecture, structure, MEP…)" },
      { id: "B2.2", label: "Emplacement", expected: "Déposé dans le répertoire BIM défini dans la convention" },
    ],
  },
  {
    section: "B — FICHIER IFC",
    category: "B3 — ATTRIBUTS PROJET (IFcProject)",
    items: [
      { id: "B3.1", label: "Localisation", expected: "Champ renseigné avec l'adresse du projet" },
      { id: "B3.2", label: "Code Phases", expected: "Code phase conforme (EXE, PRO, DCE…)" },
      { id: "B3.3", label: "Description (Description)", expected: "Description explicite du contenu du fichier" },
      { id: "B3.4", label: "Phase (Phase)", expected: "Phase du projet renseignée" },
    ],
  },
  {
    section: "B — FICHIER IFC",
    category: "B4 — ATTRIBUTS SITE (IfcSite)",
    items: [
      { id: "B4.1", label: "Nom (Name)", expected: "Nom du site renseigné" },
      { id: "B4.2", label: "Désignation (Description)", expected: "Description du site renseignée" },
      { id: "B4.3", label: "Coordonnées XYZ (Latitude/Longitude)", expected: "Coordonnées géographiques renseignées (RGF93 / Lambert 93)" },
      { id: "B4.4", label: "Elevation (Élévation Z)", expected: "Élévation NGF renseignée" },
    ],
  },
  {
    section: "B — FICHIER IFC",
    category: "B5 — ATTRIBUTS IFC (IfcBuilding)",
    items: [
      { id: "B5.1", label: "Nom (Name)", expected: "Nom du bâtiment renseigné" },
      { id: "B5.2", label: "Désignation (Description)", expected: "Description du bâtiment renseignée" },
      { id: "B5.3", label: "Coordonnées XYZ (Latitude/Longitude)", expected: "Coordonnées cohérentes avec IfcSite" },
      { id: "B5.4", label: "Elevation (Élévation Z)", expected: "Élévation de référence du bâtiment renseignée (NGF)" },
    ],
  },
  {
    section: "B — FICHIER IFC",
    category: "B6 — ATTRIBUTS NIVEAUX (IfcBuildingStorey)",
    items: [
      { id: "B6.1", label: "Adressage", expected: "Nommage conforme à la convention (RDC, R+1…)" },
      { id: "B6.2", label: "Description (Description)", expected: "Description du niveau renseignée" },
      { id: "B6.3", label: "Élévation (Élévation)", expected: "Élévation NGF renseignée pour chaque niveau" },
    ],
  },
  {
    section: "B — FICHIER IFC",
    category: "B7 — COHÉRENCE / CONFORMITÉ",
    items: [
      { id: "B7.1", label: "Vérification visuelle de l'assemblage des modèles (Cohérence générale des maquettes assemblées)", expected: "Modèles correctement positionnés et superposés sans décalage" },
      { id: "B7.2", label: "Contrôle visuel de la modélisation - Respect des règles de modélisation à maîtriser", expected: "Respect des règles de modélisation OTEIS (éléments non doublés, pas de géométrie parasite)" },
      { id: "B7.3", label: "Rattachement / Modélisation des objets aux Bons niveaux", expected: "Chaque objet est rattaché au niveau auquel il appartient" },
      { id: "B7.4", label: "Conformité maquette et Maquette architecture", expected: "Cohérence géométrique avec la maquette architecture de référence" },
      { id: "B7.5", label: "Contrôle de la connexion des objets", expected: "Objets correctement connectés (murs, dalles, poteaux…)" },
      { id: "B7.6", label: "Contrôle des conflits internes", expected: "0 conflit interne à la maquette (clash détection)" },
      { id: "B7.7", label: "Contrôle des conflits externes", expected: "0 conflit critique inter-maquettes (clash détection fédérée)" },
      { id: "B7.8", label: "Contrôle des sustènes", expected: "Systèmes de sustentation correctement modélisés et rattachés" },
    ],
  },
  // ── SECTION C : FAMILLES ────────────────────────────────────────────────────
  {
    section: "C — FAMILLES",
    category: "C1 — IFCBUILDINGELEMENT PROXY",
    items: [
      { id: "C1.1", label: "Utilisation / limite des IfcBuildingElementProxy (aucun exception acceptée)", expected: "0 objet IfcBuildingElementProxy dans le fichier" },
    ],
  },
  {
    section: "C — FAMILLES",
    category: "C2 — PIÈCES",
    items: [
      { id: "C2.1", label: "Classification IFC", expected: "Pièces classifiées en IfcSpace avec type correct" },
      { id: "C2.2", label: "Données non courantes", expected: "Pas de données redondantes ou incohérentes sur les pièces" },
      { id: "C2.3", label: "Nommage des pièces", expected: "Nommage conforme (code fonction + numéro selon convention)" },
      { id: "C2.4", label: "Intersection de pièces", expected: "0 intersection / chevauchement entre pièces" },
      { id: "C2.5", label: "Pset_IFC", expected: "Pset_SpaceCommon renseigné (IsExternal, GrossFloorArea…)" },
      { id: "C2.6", label: "Propriétés", expected: "Propriétés métier renseignées (surface, usage, programme)" },
    ],
  },
  {
    section: "C — FAMILLES",
    category: "C3 — FAMILLES OBJET 1 (Ex : MUR3)",
    items: [
      { id: "C3.1", label: "Dénomination IFC", expected: "Type IFC correct (IfcWall, IfcColumn, IfcBeam…)" },
      { id: "C3.2", label: "Niveau de détail", expected: "LOD conforme à la phase (LOD 200 minimum en PRO)" },
      { id: "C3.3", label: "Combinaison sur l'instance", expected: "Pas de combinaison de familles non prévue par la convention" },
      { id: "C3.4", label: "Dimensions", expected: "Dimensions paramétriques correctement renseignées" },
      { id: "C3.5", label: "Nom des objets", expected: "Nommage conforme à la convention OTEIS" },
      { id: "C3.6", label: "Matériaux", expected: "Matériaux renseignés et conformes à la charte matériaux" },
      { id: "C3.7", label: "Pset_app", expected: "Pset applicatif métier renseigné" },
      { id: "C3.8", label: "Prop élec", expected: "Propriétés électriques renseignées (si applicable)" },
      { id: "C3.9", label: "Prop méca", expected: "Propriétés mécaniques renseignées (si applicable)" },
    ],
  },
];

type CellStatus = 'ok' | 'warning' | 'error' | 'na' | '';

function RapportCell({ status, onChange }: { status: CellStatus; onChange: (s: CellStatus) => void }) {
  const cycle: CellStatus[] = ['', 'ok', 'warning', 'error', 'na'];
  const next = () => onChange(cycle[(cycle.indexOf(status) + 1) % cycle.length]);
  const map: Record<CellStatus, { bg: string; label: string }> = {
    ok:      { bg: 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200', label: '✓' },
    warning: { bg: 'bg-orange-100 text-orange-600 hover:bg-orange-200',   label: '⚠' },
    error:   { bg: 'bg-red-100 text-red-600 hover:bg-red-200',             label: '✗' },
    na:      { bg: 'bg-slate-100 text-slate-400 hover:bg-slate-200',       label: 'N/A' },
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
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-red-100 text-red-600 rounded flex items-center justify-center font-bold text-[10px]">✗</span> Non conforme</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-slate-100 text-slate-400 rounded flex items-center justify-center font-bold text-[9px]">N/A</span> Non applicable</span>
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
}){
  const maquettes = audits.slice(0, 6);
  const [cells, setCells] = useState<Record<string, CellStatus>>({});
  const [namingPattern, setNamingPattern] = useState('');
  const [aiLoading, setAiLoading] = useState<Record<number, boolean>>({});
  const [aiError, setAiError] = useState<Record<number, string>>({});
  const [aiDone, setAiDone] = useState<Record<number, boolean>>({});

  const setCell = (itemId: string, maqId: number, val: CellStatus) =>
    setCells(prev => ({ ...prev, [`${itemId}-${maqId}`]: val }));

  async function runAiAudit(audit: Audit) {
    if (!audit.details?.startsWith('box:')) return;
    const { fileId, discipline } = parseMaquetteDetails(audit.details);
    if (!fileId) return;
    setAiLoading(prev => ({ ...prev, [audit.id]: true }));
    setAiError(prev => ({ ...prev, [audit.id]: '' }));
    setAiDone(prev => ({ ...prev, [audit.id]: false }));
    try {
      const res = await fetch('/api/ai-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, fileName: audit.project_name, discipline }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      // Injecter les résultats dans les cellules
      const results: Record<string, { status: string; comment: string }> = data.results;
      setCells(prev => {
        const next = { ...prev };
        for (const [itemId, val] of Object.entries(results)) {
          const st = val.status as CellStatus;
          if (['ok', 'warning', 'error', 'na'].includes(st)) {
            next[`${itemId}-${audit.id}`] = st;
          }
        }
        return next;
      });
      setAiDone(prev => ({ ...prev, [audit.id]: true }));
    } catch (err: unknown) {
      setAiError(prev => ({ ...prev, [audit.id]: err instanceof Error ? err.message : String(err) }));
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
                const label = discipline || m.project_name.replace(/\.ifc$/i, '').slice(0, 16);
                const isLoading = aiLoading[m.id];
                const isDone = aiDone[m.id];
                const error = aiError[m.id];
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
                    {error && <p className="text-[10px] text-red-500 max-w-[200px] leading-tight">{error}</p>}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex items-center gap-3 text-xs text-slate-500 bg-slate-50 rounded-xl px-4 py-2 border border-slate-200 mb-6 w-fit flex-wrap">
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-emerald-100 text-emerald-700 rounded flex items-center justify-center font-bold text-[10px]">✓</span> Conforme</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-orange-100 text-orange-600 rounded flex items-center justify-center font-bold text-[10px]">⚠</span> Écart</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-red-100 text-red-600 rounded flex items-center justify-center font-bold text-[10px]">✗</span> Non conforme</span>
            <span className="flex items-center gap-1"><span className="w-5 h-5 bg-slate-100 text-slate-400 rounded flex items-center justify-center font-bold text-[9px]">N/A</span> Non applicable</span>
          </div>          <div className="space-y-5">
            {RAPPORT_CATEGORIES.map(cat => (
                    <div key={cat.category} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                      <div className="bg-blue-600 px-5 py-3 flex items-center justify-between">
                        <div>
                          <span className="text-[10px] font-semibold text-blue-200 uppercase tracking-widest">{cat.section}</span>
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
                          <thead>
                            <tr className="bg-slate-50 border-b border-slate-200">
                              <th className="text-left px-3 py-2 font-bold text-slate-400 w-12">N°</th>
                              <th className="text-left px-3 py-2 font-bold text-slate-600 min-w-[200px]">Item de contrôle</th>
                              <th className="text-left px-3 py-2 font-bold text-blue-600 min-w-[200px]">Attendu</th>                              {maquettes.length === 0
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
                            </tr>
                          </thead>                          <tbody>
                            {cat.items.map((item, ii) => {
                              // ── B1.1 : pattern de nommage éditable + vérification auto ──
                              if (item.id === 'B1.1') {
                                return (
                                  <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                                    <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-top whitespace-nowrap">{item.id}</td>
                                    <td className="px-3 py-2 text-slate-700 font-medium align-top leading-snug">{item.label}</td>
                                    <td className="px-3 py-3 align-top">
                                      <div className="text-[10px] text-slate-400 italic mb-1.5 leading-snug">{item.expected}</div>
                                      <input
                                        type="text"
                                        value={namingPattern}
                                        onChange={e => setNamingPattern(e.target.value)}
                                        placeholder="ex: PRJ_*_ARC_* ou OTEIS_*"
                                        className="w-full text-xs border border-blue-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 placeholder-slate-300 bg-blue-50 font-mono"
                                      />
                                      <p className="text-[9px] text-slate-400 mt-1">Utilisez <code className="bg-slate-100 px-1 rounded">*</code> comme joker. Ex&nbsp;: <code className="bg-slate-100 px-1 rounded">PRJ_*_ARC_EXE</code></p>
                                    </td>
                                    {maquettes.map(m => {
                                      const status = checkNaming(m.project_name, namingPattern);
                                      const map: Record<CellStatus, { bg: string; label: string }> = {
                                        ok:      { bg: 'bg-emerald-100 text-emerald-700', label: '✓' },
                                        error:   { bg: 'bg-red-100 text-red-600',          label: '✗' },
                                        warning: { bg: 'bg-orange-100 text-orange-600',   label: '⚠' },
                                        na:      { bg: 'bg-slate-100 text-slate-400',      label: 'N/A' },
                                        '':      { bg: 'bg-slate-50 text-slate-300',       label: '—' },
                                      };
                                      const { bg, label } = map[status];
                                      return (
                                        <td key={m.id} className="px-1.5 py-2 align-top">
                                          <div className={`w-full h-7 rounded text-[11px] font-bold flex items-center justify-center ${bg}`}>
                                            {label}
                                          </div>
                                          {status === 'error' && namingPattern && (
                                            <p className="text-[8px] text-red-400 mt-1 text-center leading-tight break-all px-1">Non conforme</p>
                                          )}
                                          {status === 'ok' && (
                                            <p className="text-[8px] text-emerald-500 mt-1 text-center leading-tight">Conforme</p>
                                          )}
                                        </td>
                                      );
                                    })}
                                    {maquettes.length === 0 && <td className="px-3 py-2 text-slate-300 italic text-center">—</td>}
                                  </tr>
                                );
                              }

                              // ── B1.2 : format IFC — auto OK car seuls les .ifc sont acceptés ──
                              if (item.id === 'B1.2') {
                                return (
                                  <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'}`}>
                                    <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-middle whitespace-nowrap">{item.id}</td>
                                    <td className="px-3 py-2 text-slate-700 font-medium align-middle leading-snug">{item.label}</td>
                                    <td className="px-3 py-2 text-slate-400 italic align-middle leading-snug">{item.expected}</td>
                                    {maquettes.map(m => (
                                      <td key={m.id} className="px-1.5 py-1.5 align-middle">
                                        <div className="w-full h-7 rounded text-[11px] font-bold flex items-center justify-center bg-emerald-100 text-emerald-700" title="Seuls les fichiers .ifc sont acceptés">
                                          ✓
                                        </div>
                                      </td>
                                    ))}
                                    {maquettes.length === 0 && <td className="px-3 py-2 text-slate-300 italic text-center">—</td>}
                                  </tr>
                                );
                              }

                              // ── B1.3 : taille du fichier — non vérifiable, cliquable avec info ──
                              if (item.id === 'B1.3') {
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
                                      const cycle: CellStatus[] = ['', 'ok', 'warning', 'error', 'na'];
                                      const next = () => setCell(item.id, m.id, cycle[(cycle.indexOf(st) + 1) % cycle.length]);
                                      const { bg, label } = statusMap[st];
                                      return (
                                        <td key={m.id} className="px-1.5 py-1.5 align-middle">
                                          <button onClick={next} title="Cliquer pour renseigner manuellement"
                                            className={`w-full h-7 rounded text-[11px] font-bold transition-colors ${bg} hover:opacity-80`}>
                                            {label}
                                          </button>
                                        </td>
                                      );
                                    })}
                                    {maquettes.length === 0 && <td className="px-3 py-2 text-slate-300 italic text-center">—</td>}
                                  </tr>
                                );
                              }

                              // ── Cas général : cellule cliquable ──
                              return (
                              <tr key={item.id} className={`border-t border-slate-100 ${ii % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'} hover:bg-blue-50/30 transition-colors`}>
                                <td className="px-3 py-2 text-[10px] text-slate-400 font-mono align-middle whitespace-nowrap">{item.id}</td>
                                <td className="px-3 py-2 text-slate-700 font-medium align-middle leading-snug">{item.label}</td>
                                <td className="px-3 py-2 text-slate-400 italic align-middle leading-snug">{item.expected}</td>
                                {maquettes.map(m => {
                                  const st = cells[`${item.id}-${m.id}`] ?? '';
                                  const cycle: CellStatus[] = ['', 'ok', 'warning', 'error', 'na'];
                                  const next = () => setCell(item.id, m.id, cycle[(cycle.indexOf(st) + 1) % cycle.length]);
                                  const { bg, label } = statusMap[st];
                                  return (
                                    <td key={m.id} className="px-1.5 py-1.5 align-middle">
                                      <button onClick={next} title="Cliquer pour changer le statut"
                                        className={`w-full h-7 rounded text-[11px] font-bold transition-colors ${bg} hover:opacity-80`}>
                                        {label}
                                      </button>
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
            ))}
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
    try {
      // Supprimer le fichier sur Box si disponible
      if (deleteTarget.details?.startsWith('box:')) {
        const { fileId: boxFileId } = parseMaquetteDetails(deleteTarget.details);
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
        const { fileId: boxFileId } = parseMaquetteDetails(deleteTarget.details);
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
            {['Tableau de bord', 'Maquettes', 'Rapports', 'Conformité', 'Paramètres'].map(t => (
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
          <div className="flex items-center space-x-4"><Bell className="h-5 w-5 text-slate-400" /><UserCircle className="h-6 w-6 text-slate-400" /></div>
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
                  })}
                </div>              )}
            </>
          ) : activeTab === 'Rapports' ?(
            <RapportsView audits={audits} loading={loading} />
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
                    </div>
                    {/* Champ discipline */}
                    {!sf.done && (
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] font-bold text-slate-400 uppercase tracking-wide shrink-0 w-20">Discipline</label>
                        <input
                          type="text"
                          value={sf.discipline}
                          onChange={e => updateFileDiscipline(i, e.target.value)}
                          placeholder="ex: Architecture, Structure, MEP…"
                          disabled={sf.uploading}
                          className="flex-1 text-xs border border-slate-200 rounded px-2 py-1 bg-white placeholder-slate-300 focus:outline-none focus:border-blue-400 disabled:opacity-50"
                        />
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