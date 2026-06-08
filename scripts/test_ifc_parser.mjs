/**
 * Test unitaire du parseur check-ifc-props.
 * Simule un fragment IFC 2x3 Revit avec :
 *  - Un IfcElectricApplianceType (TypeObject) avec HasPropertySets
 *  - Un IfcFlowTerminal (instance) lié au TypeObject via IfcRelDefinesByType
 *  - Des IfcPropertySingleValue et IfcPropertyEnumeratedValue
 *
 * Exécuter : node scripts/test_ifc_parser.mjs
 */

// ─── Fragment IFC de test ─────────────────────────────────────────────────────
// Reproduit la structure typique d'un export Revit IFC 2x3
const SAMPLE_IFC = `
ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1 = IFCPROJECT('xxx',$,'Test Project',$,$,$,$,$,$);
#10 = IFCPROPERTYSINGLEVALUE('INF_Puissance Electrique',$,IFCREAL(60.0),$);
#11 = IFCPROPERTYSINGLEVALUE('GMAO_Marque',$,IFCTEXT('Schneider'),$);
#12 = IFCPROPERTYSINGLEVALUE('INF_Tension',$,IFCTEXT('230V'),$);
#13 = IFCPROPERTYSINGLEVALUE('INF_IP/IK',$,IFCTEXT('IP44'),$);
#14 = IFCPROPERTYENUMERATEDVALUE('Phase de construction',$,(IFCLABEL('Travaux')),(#99));
#20 = IFCPROPERTYSET('pset001',$,'Pset_CustomElec',$,(#10,#11,#12,#13,#14));
#30 = IFCELECTRICAPPLIANCETYPE('guid001',$,'LUM_BP_Simple',$,$,(),(),(#20),$,.USERDEFINED.,$);
#40 = IFCFLOWTERMINAL('guid002',$,'ELE_Prise_Bloc:LUM_BP_Simple',$,$,$,$,$,$);
#50 = IFCRELDEFINESBYTYPE('rel001',$,$,$,(#40),#30);
ENDSEC;
END-ISO-10303-21;
`;

// ─── Copie du parseur (fonctions extraites de check-ifc-props/route.ts) ───────
function stepStr(val) {
  if (!val || val === '$') return '';
  return val.replace(/^'|'$/g, '');
}
function buildEntityIndex(raw) {
  const index = new Map();
  const dataStart = raw.indexOf('DATA;');
  const content = dataStart >= 0 ? raw.slice(dataStart) : raw;
  const re = /(#\d+)\s*=\s*([^;]+);/g;
  let m;
  while ((m = re.exec(content)) !== null) index.set(m[1], m[2].trim());
  return index;
}
function parseArgs(body) {
  const start = body.indexOf('(');
  if (start === -1) return [];
  const inner = body.slice(start + 1, body.lastIndexOf(')'));
  const args = []; let depth = 0, cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}
function normalise(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function parseRefList(raw) {
  return raw.replace(/[()]/g, '').split(',').map(s => s.trim()).filter(s => s.startsWith('#'));
}

function extractPropsFromIfc(raw, requests) {
  const index = buildEntityIndex(raw);

  // 1. Index nom -> [#id]
  const nameToIds = new Map();
  for (const [id, body] of index) {
    if (!body.toUpperCase().startsWith('IFC')) continue;
    const name = stepStr(parseArgs(body)[2] ?? '');
    if (!name) continue;
    const key = normalise(name);
    if (!nameToIds.has(key)) nameToIds.set(key, []);
    nameToIds.get(key).push(id);
  }

  // 2. IfcRelDefinesByProperties
  const entityToProps = new Map();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
    const args = parseArgs(body);
    const psetRef = (args[5] ?? '').trim();
    if (!psetRef.startsWith('#')) continue;
    for (const rid of parseRefList(args[4] ?? '')) {
      if (!entityToProps.has(rid)) entityToProps.set(rid, []);
      entityToProps.get(rid).push(psetRef);
    }
  }

  // 2b. TypeObject HasPropertySets (IFC 2x3 args[5])
  for (const [id, body] of index) {
    const entityTypeName = body.split('(')[0].toUpperCase();
    if (!entityTypeName.startsWith('IFCREL') && entityTypeName.endsWith('TYPE')) {
      const args = parseArgs(body);
      const psetListRaw = (args[5] ?? '').trim();
      if (psetListRaw && psetListRaw !== '$') {
        for (const ref of parseRefList(psetListRaw)) {
          if (!entityToProps.has(id)) entityToProps.set(id, []);
          if (!entityToProps.get(id).includes(ref)) entityToProps.get(id).push(ref);
        }
      }
    }
  }

  // 3. IfcRelDefinesByType
  const instanceToType = new Map();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELDEFINESBYTYPE(')) continue;
    const args = parseArgs(body);
    const typeRef = (args[5] ?? '').trim();
    if (!typeRef.startsWith('#')) continue;
    for (const rid of parseRefList(args[4] ?? '')) instanceToType.set(rid, typeRef);
  }

  // 4. PropertySets
  const psetValues = new Map();
  for (const [psetId, body] of index) {
    const entityTypeName = body.split('(')[0].toUpperCase();
    if (entityTypeName !== 'IFCPROPERTYSET' && entityTypeName !== 'IFCELEMENTQUANTITY') continue;
    const propMap = new Map();
    const pArgs = parseArgs(body);
    const propsListRaw = (pArgs[4] ?? '').trim();
    if (!propsListRaw || propsListRaw === '$') { psetValues.set(psetId, propMap); continue; }
    for (const propRef of parseRefList(propsListRaw)) {
      const pb = index.get(propRef);
      if (!pb) continue;
      const pbUpper = pb.toUpperCase();
      const pa = parseArgs(pb);
      const propName = stepStr(pa[0] ?? '');
      if (!propName) continue;
      if (pbUpper.startsWith('IFCPROPERTYSINGLEVALUE(')) {
        const nom = pa[2] ?? '$';
        let val = '';
        if (nom && nom !== '$') { const inner = nom.match(/\(([^)]*)\)/); val = inner ? stepStr(inner[1]) : stepStr(nom); }
        propMap.set(propName, val);
      } else if (pbUpper.startsWith('IFCPROPERTYENUMERATEDVALUE(')) {
        const enumValsRaw = pa[2] ?? '$';
        const vals = [...enumValsRaw.matchAll(/\(([^)]*)\)/g)].map(mv => stepStr(mv[1])).filter(Boolean);
        propMap.set(propName, vals.join(', '));
      } else if (pbUpper.startsWith('IFCQUANTITY')) {
        const val = pa[3] ?? pa[2] ?? '$';
        propMap.set(propName, val === '$' ? '' : val.trim());
      }
    }
    psetValues.set(psetId, propMap);
  }

  function getEntityProps(eid) {
    const result = new Map();
    const collect = (id) => {
      for (const psetId of entityToProps.get(id) ?? []) {
        const pm = psetValues.get(psetId);
        if (!pm) continue;
        for (const [k, v] of pm) {
          if (!result.has(k) || (result.get(k) === '' && v !== '')) result.set(k, v);
        }
      }
    };
    collect(eid);
    const typeId = instanceToType.get(eid);
    if (typeId) collect(typeId);
    return result;
  }

  function lookupProp(allProps, propName) {
    const exact = allProps.get(propName);
    if (exact !== undefined) return exact === '' ? null : exact;
    const lower = propName.toLowerCase();
    for (const [k, v] of allProps) {
      if (k.toLowerCase() === lower) return v === '' ? null : v;
    }
    const norm = normalise(propName);
    for (const [k, v] of allProps) {
      if (normalise(k) === norm) return v === '' ? null : v;
    }
    return null;
  }

  const results = [];
  for (const req of requests) {
    const searchKeys = [normalise(req.nomDuType)];
    if (req.type) { const short = normalise(req.type); if (!searchKeys.includes(short)) searchKeys.push(short); }

    let instanceIds = [];
    let ifcName = req.nomDuType;

    for (const key of searchKeys) {
      if (nameToIds.has(key)) { instanceIds = nameToIds.get(key); break; }
    }
    if (instanceIds.length === 0) {
      for (const key of searchKeys) {
        for (const [k, ids] of nameToIds) {
          if (k.includes(key) || key.includes(k)) instanceIds = [...instanceIds, ...ids];
        }
        if (instanceIds.length > 0) break;
      }
    }

    const allProps = new Map();
    for (const id of instanceIds) {
      const body = index.get(id);
      if (body) { const rn = stepStr(parseArgs(body)[2] ?? ''); if (rn) ifcName = rn; }
      for (const [k, v] of getEntityProps(id)) {
        if (!allProps.has(k) || (allProps.get(k) === '' && v !== '')) allProps.set(k, v);
      }
    }

    const propValues = {};
    for (const prop of req.properties) propValues[prop] = lookupProp(allProps, prop);
    results.push({ nomDuType: req.nomDuType, ifcName, instanceCount: instanceIds.length, props: propValues });
  }
  return results;
}

// ─── Tests ────────────────────────────────────────────────────────────────────
const requests = [
  {
    nomDuType: 'ELE_Prise_Bloc:LUM_BP_Simple',
    type: 'LUM_BP_Simple',
    properties: ['INF_Puissance Electrique', 'GMAO_Marque', 'INF_Tension', 'INF_IP/IK', 'Phase de construction', 'GMAO_Domaine métier'],
  },
];

const results = extractPropsFromIfc(SAMPLE_IFC, requests);

let allPassed = true;
for (const r of results) {
  console.log(`\n=== ${r.nomDuType} (${r.instanceCount} instance(s)) — ifcName: "${r.ifcName}")`);
  for (const [prop, val] of Object.entries(r.props)) {
    const ok = val !== null;
    const icon = ok ? '✅' : '❌';
    console.log(`  ${icon} ${prop}: ${val ?? 'null (MANQUANTE)'}`);
    if (!ok && ['INF_Puissance Electrique', 'GMAO_Marque', 'INF_Tension', 'INF_IP/IK', 'Phase de construction'].includes(prop)) {
      allPassed = false;
    }
  }
}

console.log('\n' + (allPassed ? '✅ TOUS LES TESTS PASSÉS' : '❌ CERTAINS TESTS ONT ÉCHOUÉ'));
if (!allPassed) process.exit(1);
