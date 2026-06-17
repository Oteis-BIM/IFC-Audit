// ─────────────────────────────────────────────────────────────
// lib/ifc-parser.ts — Parseur IFC partagé (ai-audit + llm)
// ─────────────────────────────────────────────────────────────

export const MAX_IFC_CHARS = 18000;

export function buildEntityIndex(raw: string): Map<string, string> {
  const index = new Map<string, string>();
  const entityRegex = /(#\d+)\s*=\s*([^;]+);/g;
  let match;
  while ((match = entityRegex.exec(raw)) !== null) {
    index.set(match[1], match[2].trim());
  }
  return index;
}

export function parseArgs(entityBody: string): string[] {
  const start = entityBody.indexOf('(');
  if (start === -1) return [];
  const inner = entityBody.slice(start + 1, entityBody.lastIndexOf(')'));
  const args: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

export function stepStr(val: string): string {
  if (!val || val === '$') return '';
  return val.replace(/^'|'$/g, '');
}

export interface IfcFacts {
  project: { name: string; longName: string; description: string; phase: string } | null;
  site: { name: string; description: string } | null;
  siteCoords: { x: number | null; y: number | null; z: number | null; src: string } | null;
  mapConversion: { easting: number | null; northing: number | null; height: number | null } | null;
  building: { name: string } | null;
  siteAddress: string | null;
  storeys: { name: string; elevation: number | null }[];
}

export function extractIfcFacts(raw: string, projectNgfOffsetMm?: number): IfcFacts {
  const index = buildEntityIndex(raw);
  const facts: IfcFacts = {
    project: null, site: null, siteCoords: null,
    mapConversion: null, building: null, siteAddress: null, storeys: [],
  };

  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCPROJECT(')) {
      const args = parseArgs(body);
      facts.project = {
        name:        stepStr(args[2] ?? ''),
        description: stepStr(args[3] ?? ''),
        longName:    stepStr(args[5] ?? ''),
        phase:       stepStr(args[6] ?? ''),
      };
      break;
    }
  }

  let sitePlacementRef: string | null = null;
  let siteRefElevationMm: number | null = null;
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCSITE(')) {
      const args = parseArgs(body);
      facts.site = { name: stepStr(args[2] ?? ''), description: stepStr(args[3] ?? '') };
      sitePlacementRef = args[5] ?? null;
      const refElev = parseFloat(args[11] ?? '$');
      if (!isNaN(refElev)) siteRefElevationMm = Math.round(refElev * 1000);
      break;
    }
  }

  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCMAPCONVERSION(')) {
      const args = parseArgs(body);
      facts.mapConversion = {
        easting:  isNaN(parseFloat(args[2])) ? null : parseFloat(args[2]),
        northing: isNaN(parseFloat(args[3])) ? null : parseFloat(args[3]),
        height:   isNaN(parseFloat(args[4])) ? null : parseFloat(args[4]),
      };
      break;
    }
  }

  function readCoordsFromAxis2(axis2Ref: string) {
    if (!axis2Ref || !index.has(axis2Ref)) return null;
    const axis2Body = index.get(axis2Ref)!;
    if (!axis2Body.toUpperCase().startsWith('IFCAXIS2PLACEMENT3D(')) return null;
    const axis2Args = parseArgs(axis2Body);
    const ptRef = axis2Args[0];
    if (!ptRef || !index.has(ptRef)) return null;
    const ptBody = index.get(ptRef)!;
    if (!ptBody.toUpperCase().startsWith('IFCCARTESIANPOINT(')) return null;
    const m1 = ptBody.match(/\(\(([^)]+)\)\)/);
    const m2 = ptBody.match(/\(([^)]+)\)/);
    const coordStr = (m1 ?? m2)?.[1];
    if (!coordStr) return null;
    const parts = coordStr.split(',').map((s: string) => parseFloat(s.trim()));
    return {
      x: isNaN(parts[0]) ? null : Math.round(parts[0] * 1000),
      y: isNaN(parts[1]) ? null : Math.round(parts[1] * 1000),
      z: isNaN(parts[2]) ? null : Math.round(parts[2] * 1000),
    };
  }

  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCGEOMETRICREPRESENTATIONCONTEXT(')) {
      const args = parseArgs(body);
      const wcsRef = args[4];
      if (wcsRef && wcsRef !== '$') {
        const coords = readCoordsFromAxis2(wcsRef);
        if (coords && (Math.abs(coords.x ?? 0) > 10000 || Math.abs(coords.y ?? 0) > 10000)) {
          facts.siteCoords = { ...coords, src: 'IFCGEOMETRICREPRESENTATIONCONTEXT->WorldCoordinateSystem' };
          break;
        }
      }
    }
  }

  if (!facts.siteCoords && sitePlacementRef && index.has(sitePlacementRef)) {
    let currentRef: string | null = sitePlacementRef;
    let bestCoords: { x: number | null; y: number | null; z: number | null } | null = null;
    const visited = new Set<string>();
    while (currentRef && index.has(currentRef) && !visited.has(currentRef)) {
      visited.add(currentRef);
      const placBody = index.get(currentRef)!;
      if (!placBody.toUpperCase().startsWith('IFCLOCALPLACEMENT(')) break;
      const placArgs = parseArgs(placBody);
      const parentRef = placArgs[0];
      const axis2Ref  = placArgs[1];
      if (axis2Ref) {
        const coords = readCoordsFromAxis2(axis2Ref);
        if (coords) {
          const mag     = Math.abs(coords.x ?? 0) + Math.abs(coords.y ?? 0);
          const bestMag = Math.abs(bestCoords?.x ?? 0) + Math.abs(bestCoords?.y ?? 0);
          if (mag > bestMag) bestCoords = coords;
        }
      }
      if (!parentRef || parentRef === '$') break;
      currentRef = parentRef;
    }
    if (bestCoords) facts.siteCoords = { ...bestCoords, src: 'IFCLOCALPLACEMENT(chaine)->IFCAXIS2PLACEMENT3D->IFCCARTESIANPOINT' };
  }

  let buildingAddressRef: string | null = null;
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCBUILDING(')) {
      const args = parseArgs(body);
      facts.building = { name: stepStr(args[2] ?? '') };
      const ref = (args[11] ?? '').trim();
      if (ref && ref !== '$') buildingAddressRef = ref;
      break;
    }
  }

  function parsePostalAddress(body: string): string | null {
    const args = parseArgs(body);
    const addrLines = args[4];
    const town    = stepStr(args[6] ?? '');
    const zip     = stepStr(args[8] ?? '');
    const country = stepStr(args[9] ?? '');
    const lineMatch = addrLines ? addrLines.match(/\(([^)]+)\)/) : null;
    const streetParts = lineMatch ? lineMatch[1].split(',').map((s: string) => stepStr(s.trim())).filter(Boolean) : [];
    const parts = [...streetParts, town, zip, country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  if (buildingAddressRef && index.has(buildingAddressRef)) {
    const addrBody = index.get(buildingAddressRef)!;
    if (addrBody.toUpperCase().startsWith('IFCPOSTALADDRESS(')) {
      facts.siteAddress = parsePostalAddress(addrBody);
    }
  }
  if (!facts.siteAddress) {
    for (const [, body] of index) {
      if (body.toUpperCase().startsWith('IFCPOSTALADDRESS(')) {
        facts.siteAddress = parsePostalAddress(body);
        break;
      }
    }
  }

  const mapHeight = facts.mapConversion?.height != null ? Math.round(facts.mapConversion.height * 1000) : null;
  const zOffsetMm: number =
    siteRefElevationMm !== null && siteRefElevationMm !== 0
      ? siteRefElevationMm
      : projectNgfOffsetMm != null && !isNaN(projectNgfOffsetMm)
      ? projectNgfOffsetMm
      : mapHeight !== null && mapHeight !== 0
      ? mapHeight
      : 0;

  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCBUILDINGSTOREY(')) {
      const args = parseArgs(body);
      const name = stepStr(args[2] ?? '');
      const elevRaw = args[9] ?? '$';
      const elevRelM = elevRaw === '$' ? null : parseFloat(elevRaw);
      const elevNgfMm = elevRelM === null || isNaN(elevRelM)
        ? null
        : Math.round(elevRelM * 1000) + zOffsetMm;
      facts.storeys.push({ name, elevation: elevNgfMm });
    }
  }

  return facts;
}

export function extractIfcContent(raw: string): string {
  const lines = raw.split('\n');
  const kept: string[] = [];
  kept.push(...lines.slice(0, 60));
  const keywords = [
    'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY',
    'IFCORGANIZATION', 'IFCAPPLICATION', 'IFCGEOMETRICREPRESENTATIONCONTEXT',
    'IFCUNITASSIGNMENT', 'IFCPOSTALADDRESS', 'IFCRELAGGREGATES',
    'FILE_DESCRIPTION', 'FILE_NAME', 'FILE_SCHEMA', 'IFCMAPCONVERSION',
  ];
  for (let i = 60; i < lines.length && kept.length < 250; i++) {
    const upper = lines[i].toUpperCase();
    if (keywords.some(k => upper.includes(k))) kept.push(lines[i]);
  }
  return kept.join('\n').slice(0, MAX_IFC_CHARS);
}

/** Compte les occurrences d'un type IFC dans le fichier brut */
export function countIfcType(raw: string, ifcType: string): number {
  const upper = raw.toUpperCase();
  const keyword = ifcType.toUpperCase() + '(';
  let count = 0;
  let pos = 0;
  while ((pos = upper.indexOf(keyword, pos)) !== -1) {
    count++;
    pos += keyword.length;
  }
  return count;
}

// ─── Types pour les quantités géométriques ───────────────────────────────────
export interface IfcQuantityEntry {
  globalId: string;
  ifcType: string;
  name: string;
  level: string | null;
  quantities: Record<string, number>; // ex: { "NetVolume": 0.42, "GrossArea": 3.5 }
}

export interface IfcQuantityAgg {
  total: number;
  avg: number;
  count: number;
  unit: string;
}

export interface IfcQuantitySummary {
  totalElements: number;
  elementsWithQuantities: number;
  countByType: Record<string, number>;
  /** Agrégats globaux : type → prop → agg */
  aggregatesByType: Record<string, Record<string, IfcQuantityAgg>>;
  /** Agrégats par niveau : type → niveau → prop → agg */
  aggregatesByTypeAndLevel: Record<string, Record<string, Record<string, IfcQuantityAgg>>>;
  elements: IfcQuantityEntry[];
}

// Noms de quantités et unités associées (IFC standard BaseQuantities)
const QUANTITY_UNITS: Record<string, string> = {
  length: 'mm', width: 'mm', height: 'mm', depth: 'mm', perimeter: 'mm',
  grosssidearea: 'm²', netsidearea: 'm²', grossfloorarea: 'm²', netfloorarea: 'm²',
  grosscrosssectionarea: 'm²', netcrosssectionarea: 'm²', outersurfacearea: 'm²',
  grosssurface: 'm²', netsurface: 'm²', grossvolume: 'm³', netvolume: 'm³',
  grossweight: 'kg', netweight: 'kg', count: 'u',
};

function getQuantityUnit(propName: string): string {
  return QUANTITY_UNITS[propName.toLowerCase()] ?? '';
}

const QUANTITY_IFC_TYPES = [
  'IfcQuantityLength', 'IfcQuantityArea', 'IfcQuantityVolume',
  'IfcQuantityWeight', 'IfcQuantityCount', 'IfcQuantityTime',
];

const TARGET_IFC_TYPES = [
  'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM',
  'IFCDOOR', 'IFCWINDOW', 'IFCSTAIR', 'IFCROOF', 'IFCFOOTING', 'IFCPILE',
  'IFCSPACE', 'IFCLIGHTFIXTURE', 'IFCFLOWTERMINAL', 'IFCFLOWSEGMENT',
  'IFCDISTRIBUTIONFLOWELEMENT', 'IFCCOVERING', 'IFCFURNISHINGELEMENT',
];

/**
 * Extrait les BaseQuantities (IFCELEMENTQUANTITY) depuis le fichier IFC brut.
 * Retourne un résumé agrégé par type IFC, directement utilisable par le LLM.
 */
export function extractIfcQuantities(raw: string): IfcQuantitySummary {
  const index = buildEntityIndex(raw);

  // 1. Mapper chaque entité cible : globalId → { ifcType, name, ref }
  const elementMap = new Map<string, { ifcType: string; name: string; ref: string }>();
  for (const [ref, body] of index) {
    const upper = body.toUpperCase();
    for (const t of TARGET_IFC_TYPES) {
      if (upper.startsWith(t + '(')) {
        const args = parseArgs(body);
        elementMap.set(ref, {
          ifcType: body.substring(0, body.indexOf('(')),
          name: stepStr(args[2] ?? ''),
          ref,
        });
        break;
      }
    }
  }

  // 2. Mapper chaque IFCRELDEFINESBYPROPERTIES → quels éléments → quels psets/qtos
  //    Structure : relatedObjects (liste de refs) → relatingPropertyDefinition (ref vers IFCELEMENTQUANTITY)
  const elementQtoRefs = new Map<string, string[]>(); // elementRef → [qtoRef, ...]
  for (const [, body] of index) {
    const upper = body.toUpperCase();
    if (!upper.startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
    const args = parseArgs(body);
    // args[4] = RelatedObjects (liste), args[5] = RelatingPropertyDefinition
    const relatedStr = args[4] ?? '';
    const defRef = (args[5] ?? '').trim();
    if (!defRef || defRef === '$') continue;
    // Extraire les refs de la liste (#123,#456,...)
    const refs = relatedStr.match(/#\d+/g) ?? [];
    for (const r of refs) {
      if (!elementQtoRefs.has(r)) elementQtoRefs.set(r, []);
      elementQtoRefs.get(r)!.push(defRef);
    }
  }

  // 3. Pour chaque IFCELEMENTQUANTITY, parser les quantités numériques
  const qtoCache = new Map<string, Record<string, number>>();
  for (const [ref, body] of index) {
    const upper = body.toUpperCase();
    if (!upper.startsWith('IFCELEMENTQUANTITY(')) continue;
    const args = parseArgs(body);
    // args[5] = liste de refs vers IFCQUANTITY*
    const quantityListStr = args[5] ?? '';
    const qRefs = quantityListStr.match(/#\d+/g) ?? [];
    const quantities: Record<string, number> = {};
    for (const qRef of qRefs) {
      const qBody = index.get(qRef);
      if (!qBody) continue;
      const qUpper = qBody.toUpperCase();
      const isQuantity = QUANTITY_IFC_TYPES.some(t => qUpper.startsWith(t.toUpperCase() + '('));
      if (!isQuantity) continue;
      const qArgs = parseArgs(qBody);
      const propName = stepStr(qArgs[0] ?? '');
      // La valeur numérique est en args[3] (IFC2x3) ou args[2] selon le type
      const rawVal = qArgs[3] ?? qArgs[2] ?? '$';
      const val = parseFloat(rawVal);
      if (propName && !isNaN(val)) {
        quantities[propName] = val;
      }
    }
    if (Object.keys(quantities).length > 0) qtoCache.set(ref, quantities);
  }

  // 4. Associer quantités aux éléments + récupérer le niveau de rattachement
  // Mapper IFCRELCONTAINEDINSPATIALSTRUCTURE : ref élément → nom niveau
  const levelMap = new Map<string, string>();
  for (const [, body] of index) {
    const upper = body.toUpperCase();
    if (!upper.startsWith('IFCRELCONTAINEDINSPATIALSTRUCTURE(')) continue;
    const args = parseArgs(body);
    const relatingRef = (args[5] ?? '').trim();
    const relatedStr = args[4] ?? '';
    const levelBody = relatingRef ? index.get(relatingRef) : undefined;
    if (!levelBody) continue;
    const levelArgs = parseArgs(levelBody);
    const levelName = stepStr(levelArgs[2] ?? '');
    const refs = relatedStr.match(/#\d+/g) ?? [];
    for (const r of refs) levelMap.set(r, levelName);
  }

  // 5. Construire le résultat
  const entries: IfcQuantityEntry[] = [];
  const countByType: Record<string, number> = {};
  const aggregatesByType: Record<string, Record<string, { total: number; avg: number; count: number; unit: string }>> = {};
  const aggAccum: Record<string, Record<string, number[]>> = {};

  for (const [ref, elInfo] of elementMap) {
    const ifcType = elInfo.ifcType;
    countByType[ifcType] = (countByType[ifcType] ?? 0) + 1;

    const qtoRefs = elementQtoRefs.get(ref) ?? [];
    const allQuantities: Record<string, number> = {};
    for (const qRef of qtoRefs) {
      const qts = qtoCache.get(qRef);
      if (qts) Object.assign(allQuantities, qts);
    }

    const entry: IfcQuantityEntry = {
      globalId: '',
      ifcType,
      name: elInfo.name,
      level: levelMap.get(ref) ?? null,
      quantities: allQuantities,
    };

    // Récupérer le GlobalId
    const elBody = index.get(ref);
    if (elBody) {
      const elArgs = parseArgs(elBody);
      entry.globalId = stepStr(elArgs[0] ?? '');
    }

    entries.push(entry);

    // Agréger par type
    if (Object.keys(allQuantities).length > 0) {
      if (!aggAccum[ifcType]) aggAccum[ifcType] = {};
      for (const [prop, val] of Object.entries(allQuantities)) {
        if (!aggAccum[ifcType][prop]) aggAccum[ifcType][prop] = [];
        aggAccum[ifcType][prop].push(val);
      }
    }
  }
  // Calculer total/avg/count globaux + par niveau
  for (const [type, props] of Object.entries(aggAccum)) {
    aggregatesByType[type] = {};
    for (const [prop, vals] of Object.entries(props)) {
      const total = vals.reduce((a, b) => a + b, 0);
      aggregatesByType[type][prop] = {
        total: Math.round(total * 1000) / 1000,
        avg: Math.round((total / vals.length) * 1000) / 1000,
        count: vals.length,
        unit: getQuantityUnit(prop),
      };
    }
  }

  // Agrégats par niveau (type → niveau → prop → agg)
  const aggByLevel: Record<string, Record<string, Record<string, number[]>>> = {};
  for (const entry of entries) {
    if (Object.keys(entry.quantities).length === 0) continue;
    const niveau = entry.level ?? '(niveau inconnu)';
    if (!aggByLevel[entry.ifcType]) aggByLevel[entry.ifcType] = {};
    if (!aggByLevel[entry.ifcType][niveau]) aggByLevel[entry.ifcType][niveau] = {};
    for (const [prop, val] of Object.entries(entry.quantities)) {
      if (!aggByLevel[entry.ifcType][niveau][prop]) aggByLevel[entry.ifcType][niveau][prop] = [];
      aggByLevel[entry.ifcType][niveau][prop].push(val);
    }
  }
  const aggregatesByTypeAndLevel: Record<string, Record<string, Record<string, IfcQuantityAgg>>> = {};
  for (const [type, niveaux] of Object.entries(aggByLevel)) {
    aggregatesByTypeAndLevel[type] = {};
    for (const [niveau, props] of Object.entries(niveaux)) {
      aggregatesByTypeAndLevel[type][niveau] = {};
      for (const [prop, vals] of Object.entries(props)) {
        const total = vals.reduce((a, b) => a + b, 0);
        aggregatesByTypeAndLevel[type][niveau][prop] = {
          total: Math.round(total * 1000) / 1000,
          avg: Math.round((total / vals.length) * 1000) / 1000,
          count: vals.length,
          unit: getQuantityUnit(prop),
        };
      }
    }
  }

  return {
    totalElements: elementMap.size,
    elementsWithQuantities: entries.filter(e => Object.keys(e.quantities).length > 0).length,
    countByType,
    aggregatesByType,
    aggregatesByTypeAndLevel,
    elements: entries,
  };
}

/** Formate le résumé des quantités en texte lisible pour le LLM */
export function buildQuantitiesBlock(summary: IfcQuantitySummary): string {
  if (summary.totalElements === 0) return '- Aucun élément IFC trouvé.';

  const lines: string[] = [];
  lines.push(`- Éléments analysés : ${summary.totalElements} (${summary.elementsWithQuantities} avec quantités géométriques)`);

  lines.push('- Comptage par type :');
  for (const [type, count] of Object.entries(summary.countByType).sort((a, b) => b[1] - a[1])) {
    lines.push(`    • ${type} : ${count}`);
  }

  const hasAgg = Object.keys(summary.aggregatesByType).length > 0;
  const hasByLevel = Object.keys(summary.aggregatesByTypeAndLevel ?? {}).length > 0;

  if (!hasAgg) {
    lines.push('- Quantités géométriques : non renseignées dans ce fichier IFC (BaseQuantities absentes).');
    lines.push('  → Astuce : exécutez scripts/extract_ifc_quantities.py pour enrichir les données.');
    return lines.join('\n');
  }

  // Totaux globaux (toutes niveaux confondus)
  lines.push('');
  lines.push('- TOTAUX GLOBAUX par type (BaseQuantities, toutes niveaux) :');
  for (const [type, props] of Object.entries(summary.aggregatesByType)) {
    lines.push(`    ${type} (${summary.countByType[type] ?? 0} éléments) :`);
    for (const [prop, agg] of Object.entries(props)) {
      const unit = agg.unit ? ` ${agg.unit}` : '';
      lines.push(`      • ${prop} — total: ${agg.total}${unit}, moy/élément: ${agg.avg}${unit}, nb: ${agg.count}`);
    }
  }

  // Détail par niveau
  if (hasByLevel) {
    lines.push('');
    lines.push('- QUANTITÉS PAR NIVEAU (BaseQuantities) :');
    for (const [type, niveaux] of Object.entries(summary.aggregatesByTypeAndLevel)) {
      lines.push(`    ${type} :`);
      for (const [niveau, props] of Object.entries(niveaux)) {
        lines.push(`      Niveau "${niveau}" :`);
        for (const [prop, agg] of Object.entries(props)) {
          const unit = agg.unit ? ` ${agg.unit}` : '';
          lines.push(`        • ${prop} — total: ${agg.total}${unit}, nb: ${agg.count}`);
        }
      }
    }
  }

  return lines.join('\n');
}

/** Construit un bloc de faits lisible pour le LLM à partir des facts parsés */
export function buildFactsBlock(facts: IfcFacts, fileName: string, discipline: string): string {
  const coords = facts.mapConversion
    ? { x: facts.mapConversion.easting, y: facts.mapConversion.northing, z: facts.mapConversion.height, src: 'IFCMAPCONVERSION' }
    : facts.siteCoords
    ? { x: facts.siteCoords.x, y: facts.siteCoords.y, z: facts.siteCoords.z, src: facts.siteCoords.src }
    : null;

  return [
    `### Maquette : "${fileName}" | Discipline : ${discipline || 'non précisée'}`,
    `- IFCPROJECT.Name        : ${facts.project?.name ? `"${facts.project.name}"` : '(vide)'}`,
    `- IFCPROJECT.LongName    : ${facts.project?.longName ? `"${facts.project.longName}"` : '(vide)'}`,
    `- IFCPROJECT.Description : ${facts.project?.description ? `"${facts.project.description}"` : '(vide)'}`,
    `- IFCPROJECT.Phase       : ${facts.project?.phase ? `"${facts.project.phase}"` : '(vide)'}`,
    `- IFCSITE.Name           : ${facts.site?.name ? `"${facts.site.name}"` : '(vide)'}`,
    `- IFCBUILDING.Name       : ${facts.building?.name ? `"${facts.building.name}"` : '(vide)'}`,
    `- Adresse                : ${facts.siteAddress ? `"${facts.siteAddress}"` : '(vide)'}`,
    coords
      ? `- Géoréférencement       : Y=${coords.x} mm, X=${coords.y} mm, Z=${coords.z} mm (${coords.src})`
      : `- Géoréférencement       : non trouvé`,
    facts.storeys.length > 0
      ? `- Niveaux (NGF)          :\n` + facts.storeys.map(s => `    • ${s.name} : ${s.elevation !== null ? `${s.elevation} mm NGF` : '(non défini)'}`).join('\n')
      : `- Niveaux                : aucun trouvé`,
  ].join('\n');
}

// ─── Extraction des Property Sets (Psets) par type IFC ───────────────────────

export interface IfcPsetSummary {
  byType: Record<string, Record<string, {
    presents: number;
    absents: number;
    total: number;
    exempleValeur: string;
    exemplesManquants: string[];
  }>>;
  countByType: Record<string, number>;
}

const PSET_TARGET_TYPES = [
  'IFCWALL', 'IFCWALLSTANDARDCASE', 'IFCSLAB', 'IFCCOLUMN', 'IFCBEAM',
  'IFCDOOR', 'IFCWINDOW', 'IFCSTAIR', 'IFCROOF', 'IFCFOOTING', 'IFCPILE',
  'IFCSPACE', 'IFCLIGHTFIXTURE', 'IFCFLOWTERMINAL', 'IFCFLOWSEGMENT',
  'IFCDISTRIBUTIONFLOWELEMENT', 'IFCELECTRICDISTRIBUTIONBOARD',
  'IFCCOVERING', 'IFCFURNISHINGELEMENT', 'IFCOUTLET', 'IFCSENSOR',
  'IFCFLOWCONTROLLER', 'IFCENERGYCONVERSIONDEVICE', 'IFCPIPEFITTING',
  'IFCPIPESEGMENT', 'IFCDUCTSEGMENT', 'IFCDUCTFITTING', 'IFCMEMBER', 'IFCPLATE',
];

export function extractIfcPsets(raw: string): IfcPsetSummary {
  const index = buildEntityIndex(raw);

  const elementMap = new Map<string, { ifcType: string; name: string }>();
  for (const [ref, body] of index) {
    const upper = body.toUpperCase();
    for (const t of PSET_TARGET_TYPES) {
      if (upper.startsWith(t + '(')) {
        const args = parseArgs(body);
        elementMap.set(ref, {
          ifcType: body.substring(0, body.indexOf('(')),
          name: stepStr(args[2] ?? '') || ref,
        });
        break;
      }
    }
  }

  const elementPsetRefs = new Map<string, string[]>();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
    const args = parseArgs(body);
    const relatedStr = args[4] ?? '';
    const defRef = (args[5] ?? '').trim();
    if (!defRef || defRef === '$') continue;
    for (const r of (relatedStr.match(/#\d+/g) ?? [])) {
      if (!elementPsetRefs.has(r)) elementPsetRefs.set(r, []);
      elementPsetRefs.get(r)!.push(defRef);
    }
  }

  const psetCache = new Map<string, Record<string, string>>();
  for (const [ref, body] of index) {
    if (!body.toUpperCase().startsWith('IFCPROPERTYSET(')) continue;
    const args = parseArgs(body);
    const propRefs = (args[4] ?? '').match(/#\d+/g) ?? [];
    const props: Record<string, string> = {};
    for (const pRef of propRefs) {
      const pBody = index.get(pRef);
      if (!pBody || !pBody.toUpperCase().startsWith('IFCPROPERTYSINGLEVALUE(')) continue;
      const pArgs = parseArgs(pBody);
      const propName = stepStr(pArgs[0] ?? '');
      const rawVal = pArgs[2] ?? '$';
      const m = rawVal.match(/IFC\w+\('(.+?)'\)|IFC\w+\(\.(.+?)\.\)|IFC\w+\((.+?)\)|'(.+?)'/i);
      const val = m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '') : stepStr(rawVal);
      if (propName) props[propName] = val;
    }
    if (Object.keys(props).length > 0) psetCache.set(ref, props);
  }

  const countByType: Record<string, number> = {};
  const accumProps: Record<string, Record<string, { vals: string[] }>> = {};
  const elementPropsMap = new Map<string, Set<string>>();

  for (const [ref, elInfo] of elementMap) {
    const { ifcType } = elInfo;
    countByType[ifcType] = (countByType[ifcType] ?? 0) + 1;
    const allProps: Record<string, string> = {};
    for (const pRef of (elementPsetRefs.get(ref) ?? [])) {
      const cached = psetCache.get(pRef);
      if (cached) Object.assign(allProps, cached);
    }
    const filledProps = new Set<string>();
    if (!accumProps[ifcType]) accumProps[ifcType] = {};
    for (const [prop, val] of Object.entries(allProps)) {
      if (val !== '' && val !== '$') {
        filledProps.add(prop);
        if (!accumProps[ifcType][prop]) accumProps[ifcType][prop] = { vals: [] };
        accumProps[ifcType][prop].vals.push(val);
      }
    }
    elementPropsMap.set(ref, filledProps);
  }

  const byType: IfcPsetSummary['byType'] = {};
  for (const [type, props] of Object.entries(accumProps)) {
    byType[type] = {};
    const total = countByType[type] ?? 0;
    for (const [prop, data] of Object.entries(props)) {
      const presents = data.vals.length;
      const absents = total - presents;
      const exemplesManquants: string[] = [];
      for (const [eRef, ePropSet] of elementPropsMap) {
        if (elementMap.get(eRef)?.ifcType === type && !ePropSet.has(prop) && exemplesManquants.length < 5) {
          exemplesManquants.push(elementMap.get(eRef)?.name ?? eRef);
        }
      }
      byType[type][prop] = {
        presents, absents, total,
        exempleValeur: data.vals[0] ?? '',
        exemplesManquants,
      };
    }
  }

  return { byType, countByType };
}

export function buildPsetsBlock(summary: IfcPsetSummary): string {
  const types = Object.keys(summary.byType);
  if (types.length === 0) return '- Aucune propriete Pset trouvee dans ce fichier IFC.';
  const lines: string[] = ['- PROPRIETES (Psets) PAR TYPE IFC :'];
  for (const type of types) {
    const total = summary.countByType[type] ?? 0;
    const props = summary.byType[type];
    lines.push(`    ${type} (${total} elements, ${Object.keys(props).length} proprietes) :`);
    for (const [prop, stat] of Object.entries(props)) {
      const taux = total > 0 ? Math.round((stat.presents / total) * 100) : 0;
      const conformite = taux === 100 ? 'OK' : taux === 0 ? 'ABSENT' : taux + '%';
      let line = `      - ${prop} : ${stat.presents}/${total} (${conformite})`;
      if (stat.exempleValeur) line += ` ex:"${stat.exempleValeur}"`;
      if (stat.absents > 0 && stat.exemplesManquants.length > 0) {
        line += ` manquants: ${stat.exemplesManquants.slice(0, 3).join(', ')}${stat.absents > 3 ? ' (+' + (stat.absents - 3) + ')' : ''}`;
      }
      lines.push(line);
    }
  }
  return lines.join('\n');
}
