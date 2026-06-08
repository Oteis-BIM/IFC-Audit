/**
 * Diagnostic : analyse la structure IFC autour d'un nom de type donné
 * Usage : node scripts/diagnose_ifc.mjs <chemin_ifc_local.ifc> "LUM_BP_Simple"
 */
import fs from 'fs';

const ifcPath = process.argv[2];
const targetName = process.argv[3] ?? 'LUM_BP_Simple';

if (!ifcPath || !fs.existsSync(ifcPath)) {
  console.error('Usage: node diagnose_ifc.mjs <fichier.ifc> "NomDuType"');
  process.exit(1);
}

const raw = fs.readFileSync(ifcPath, 'utf-8');
console.log(`Fichier : ${ifcPath} (${Math.round(raw.length / 1024)} Ko)\n`);

// --- Helpers ---
function stepStr(val) {
  if (!val || val === '$') return '';
  return val.replace(/^'|'$/g, '');
}
function parseArgs(body) {
  const start = body.indexOf('(');
  if (start === -1) return [];
  const inner = body.slice(start + 1, body.lastIndexOf(')'));
  const args = []; let depth = 0, cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}
function normalise(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// --- Build index ---
const dataStart = raw.indexOf('DATA;');
const content = dataStart >= 0 ? raw.slice(dataStart) : raw;
const index = new Map();
const re = /(#\d+)\s*=\s*([^;]+);/g;
let m;
while ((m = re.exec(content)) !== null) index.set(m[1], m[2].trim());
console.log(`Total entités indexées : ${index.size}\n`);

// --- Cherche les entités dont le Name contient targetName ---
const targetNorm = normalise(targetName);
const found = [];
for (const [id, body] of index) {
  const args = parseArgs(body);
  const name = stepStr(args[2] ?? '');
  if (name && normalise(name).includes(targetNorm)) {
    found.push({ id, body: body.slice(0, 120), name, entityType: body.split('(')[0] });
  }
}
console.log(`=== Entités avec Name contenant "${targetName}" (${found.length} trouvées) ===`);
found.slice(0, 10).forEach(f => console.log(`  ${f.id} [${f.entityType}] Name="${f.name}"`));

if (found.length === 0) {
  // Cherche aussi dans args[0] et args[1]
  console.log('\nRecherche élargie (tous args)...');
  let count = 0;
  for (const [id, body] of index) {
    if (body.includes(targetName) && count < 5) {
      console.log(`  ${id}: ${body.slice(0, 150)}`);
      count++;
    }
  }
  process.exit(0);
}

// --- Analyse IfcRelDefinesByProperties ---
console.log('\n=== IfcRelDefinesByProperties liées à ces entités ===');
const entityToProps = new Map();
for (const [, body] of index) {
  if (!body.toUpperCase().startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
  const args = parseArgs(body);
  const psetRef = (args[5] ?? '').trim();
  const relatedStr = args[4] ?? '';
  const relatedIds = relatedStr.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  for (const rid of relatedIds) {
    if (!entityToProps.has(rid)) entityToProps.set(rid, []);
    entityToProps.get(rid).push(psetRef);
  }
}
for (const f of found.slice(0, 3)) {
  const psets = entityToProps.get(f.id) ?? [];
  console.log(`\n  ${f.id} (${f.entityType} "${f.name}") → ${psets.length} PropertySet(s) : ${psets.join(', ')}`);
}

// --- Analyse IfcRelDefinesByType ---
console.log('\n=== IfcRelDefinesByType (instance → type) ===');
const instanceToType = new Map();
for (const [, body] of index) {
  if (!body.toUpperCase().startsWith('IFCRELDEFINESBYTYPE(')) continue;
  const args = parseArgs(body);
  const typeRef = (args[5] ?? '').trim();
  const relatedStr = args[4] ?? '';
  const relatedIds = relatedStr.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(Boolean);
  for (const rid of relatedIds) instanceToType.set(rid, typeRef);
}
for (const f of found.slice(0, 3)) {
  const typeId = instanceToType.get(f.id);
  if (typeId) {
    const typeBody = index.get(typeId) ?? '?';
    const typeName = stepStr(parseArgs(typeBody)[2] ?? '');
    console.log(`  ${f.id} → TypeObject ${typeId} [${typeBody.split('(')[0]}] Name="${typeName}"`);
    // Psets du type
    const typePsets = entityToProps.get(typeId) ?? [];
    console.log(`    TypeObject PropertySets : ${typePsets.join(', ') || 'aucun'}`);
  } else {
    console.log(`  ${f.id} → pas de TypeObject`);
  }
}

// --- Affiche les propriétés d'un PropertySet ---
console.log('\n=== Contenu d\'un PropertySet (premier trouvé) ===');
const firstEntity = found[0];
const allPsetIds = new Set([
  ...(entityToProps.get(firstEntity?.id) ?? []),
  ...(entityToProps.get(instanceToType.get(firstEntity?.id)) ?? []),
]);
for (const psetId of Array.from(allPsetIds).slice(0, 3)) {
  const psetBody = index.get(psetId);
  if (!psetBody) { console.log(`  ${psetId} : non trouvé dans l'index`); continue; }
  const pArgs = parseArgs(psetBody);
  const psetName = stepStr(pArgs[2] ?? '');
  const propRefs = (pArgs[4] ?? '').replace(/[()]/g, '').split(',').map(s => s.trim()).filter(s => s.startsWith('#'));
  console.log(`\n  ${psetId} [${psetBody.split('(')[0]}] Name="${psetName}" → ${propRefs.length} propriété(s)`);
  for (const propRef of propRefs.slice(0, 8)) {
    const pb = index.get(propRef);
    if (!pb) { console.log(`    ${propRef} : non trouvé`); continue; }
    const pa = parseArgs(pb);
    const propName = stepStr(pa[0] ?? '');
    const nomRaw = pa[2] ?? '$';
    const inner = nomRaw.match(/\(([^)]*)\)/);
    const val = inner ? stepStr(inner[1]) : stepStr(nomRaw);
    console.log(`    ${propRef} "${propName}" = "${val}" (raw: ${nomRaw.slice(0,40)})`);
  }
}

// --- Résumé : nombre de psets par type d'entité ---
console.log('\n=== Résumé global ===');
let withPsets = 0, withType = 0;
for (const [id] of index) {
  if (entityToProps.has(id)) withPsets++;
  if (instanceToType.has(id)) withType++;
}
console.log(`Entités avec PropertySet direct   : ${withPsets}`);
console.log(`Entités avec lien TypeObject       : ${withType}`);
