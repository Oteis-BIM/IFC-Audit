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
