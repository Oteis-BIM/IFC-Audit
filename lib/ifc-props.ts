import { buildEntityIndex, parseArgs, stepStr } from '@/lib/ifc-parser';

export type PropCheckRequest = {
  nomDuType: string;
  type?: string;
  ifcClasses?: string[];
  properties: string[];
};

export type PropCheckResult = {
  nomDuType: string;
  ifcName: string;
  ifcClass: string;
  ifcClassesFound: string[];
  instanceCount: number;
  props: Record<string, string | null>;
};

function decodeIfcEscapes(value: string): string {
  return value
    .replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_match, hex: string) => {
      const chars: string[] = [];
      for (let i = 0; i + 3 < hex.length; i += 4) {
        chars.push(String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)));
      }
      return chars.join('');
    })
    .replace(/\\X\\([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function repairMojibake(value: string): string {
  if (!/[ÃÂâ€Å]/.test(value)) return value;
  try {
    const bytes = Uint8Array.from([...value].map((char) => char.charCodeAt(0)));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}

function cleanText(value: string): string {
  return repairMojibake(decodeIfcEscapes(value));
}

function normalise(s: string): string {
  return cleanText(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function propertyMatchKeys(value: string): string[] {
  const rawParts = value
    .split(/[.:]/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const parts = rawParts.length > 0 ? rawParts : [value];
  const keys = new Set<string>();

  for (const part of parts) {
    const norm = normalise(part);
    if (!norm) continue;
    keys.add(norm);
    if (norm.endsWith('s') && norm.length > 4) keys.add(norm.slice(0, -1));
  }

  const full = normalise(value);
  if (full) {
    keys.add(full);
    if (full.endsWith('s') && full.length > 4) keys.add(full.slice(0, -1));
  }

  return [...keys];
}

function propertyNamesMatch(actualName: string, expectedName: string): boolean {
  const actualKeys = propertyMatchKeys(actualName);
  const expectedKeys = propertyMatchKeys(expectedName);

  return actualKeys.some((actual) => expectedKeys.some((expected) =>
    actual === expected ||
    (expected.length > 4 && actual.endsWith(expected))
  ));
}

function searchKeyVariants(value?: string): string[] {
  if (!value) return [];

  const keys = new Set<string>();
  const addKey = (candidate: string) => {
    const key = normalise(candidate);
    if (key.length >= 4) keys.add(key);
  };

  addKey(value);
  value
    .split(/[:;/|_\-\n\r]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach(addKey);

  return [...keys];
}

function parseRefList(raw: string): string[] {
  return raw.replace(/[()]/g, '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('#'));
}

function parseIfcValue(rawValue: string): string {
  const raw = rawValue.trim();
  if (!raw || raw === '$' || raw === '*') return '';

  const typedValues = [...raw.matchAll(/IFC[A-Z0-9_]+\(([^()]*)\)/gi)]
    .map((match) => cleanText(stepStr(match[1].trim().replace(/^\.(.*)\.$/, '$1'))))
    .filter(Boolean);
  if (typedValues.length > 0) return typedValues.join(', ');

  return cleanText(stepStr(raw.replace(/^\.(.*)\.$/, '$1')));
}

function parseIfcValues(rawValue: string): string {
  const typedValues = [...rawValue.matchAll(/IFC[A-Z0-9_]+\(([^()]*)\)/gi)]
    .map((match) => parseIfcValue(match[1] ?? ''))
    .filter(Boolean);
  if (typedValues.length > 0) return [...new Set(typedValues)].join(', ');
  return parseIfcValue(rawValue);
}

function getEntityTypeName(body: string): string {
  return body.split('(')[0].trim();
}

function splitCompoundPropertyName(propName: string): string[] {
  const variants = new Set<string>([propName]);
  const norm = normalise(propName);

  if (norm === 'longueurlargeurhauteurprofondeurdiametrevolume') {
    [
      'Longueur', 'Largeur', 'Hauteur', 'Profondeur', 'Diamètre', 'Diametre', 'Volume',
      'Length', 'Width', 'Height', 'Depth', 'Diameter', 'NominalDiameter',
      'GrossVolume', 'NetVolume',
    ].forEach((variant) => variants.add(variant));
  }

  if (norm === 'materiau' || norm === 'materiaux') {
    ['Matériau', 'Materiau', 'Material', 'Materials', 'Structural Material'].forEach((variant) => variants.add(variant));
  }

  if (norm === 'phasedeconstruction') {
    [
      'Phase de construction', 'Phase Construction', 'Phase de création', 'Phase Creation',
      'Phase Created', 'Created Phase', 'Construction Phase',
    ].forEach((variant) => variants.add(variant));
  }

  propName
    .split(/[/\n\r]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => variants.add(part));

  return [...variants];
}

const TYPE_NAME_PROPERTIES = [
  'Nom du type',
  'Type Name',
  'TypeName',
  'IfcType',
  'Type IFC',
  'Family and Type',
  'Famille et type',
  'Name',
  'INF_Type',
];

function isLikelyElementEntity(body: string): boolean {
  const entityTypeName = body.split('(')[0].toUpperCase();
  return (
    entityTypeName.startsWith('IFC') &&
    !entityTypeName.startsWith('IFCREL') &&
    !entityTypeName.startsWith('IFCPROPERTY') &&
    !entityTypeName.startsWith('IFCQUANTITY') &&
    !entityTypeName.startsWith('IFCMATERIAL') &&
    entityTypeName !== 'IFCPROPERTYSET' &&
    entityTypeName !== 'IFCELEMENTQUANTITY' &&
    entityTypeName !== 'IFCOWNERHISTORY' &&
    entityTypeName !== 'IFCAPPLICATION' &&
    entityTypeName !== 'IFCORGANIZATION' &&
    entityTypeName !== 'IFCPERSON' &&
    entityTypeName !== 'IFCPOSTALADDRESS'
  );
}

function lookupProp(allProps: Map<string, string>, propName: string): string | null {
  const matches: string[] = [];

  for (const candidate of splitCompoundPropertyName(propName)) {
    const exact = allProps.get(candidate);
    if (exact !== undefined && exact !== '') matches.push(exact);

    const lower = candidate.toLowerCase();
    for (const [key, value] of allProps) {
      if (key.toLowerCase() === lower && value !== '') matches.push(value);
    }

    for (const [key, value] of allProps) {
      if (propertyNamesMatch(key, candidate) && value !== '') matches.push(value);
    }
  }

  const unique = [...new Set(matches)];
  return unique.length > 0 ? unique.join(' / ') : null;
}

export function extractPropsFromIfc(raw: string, requests: PropCheckRequest[]): PropCheckResult[] {
  const index = buildEntityIndex(raw);

  const nameToIds = new Map<string, string[]>();
  for (const [id, body] of index) {
    if (!body.toUpperCase().startsWith('IFC')) continue;
    const name = stepStr(parseArgs(body)[2] ?? '');
    if (!name) continue;
    const key = normalise(name);
    if (!nameToIds.has(key)) nameToIds.set(key, []);
    nameToIds.get(key)!.push(id);
  }

  const entityToProps = new Map<string, string[]>();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELDEFINESBYPROPERTIES(')) continue;
    const args = parseArgs(body);
    const psetRef = (args[5] ?? '').trim();
    if (!psetRef.startsWith('#')) continue;
    for (const relatedId of parseRefList(args[4] ?? '')) {
      if (!entityToProps.has(relatedId)) entityToProps.set(relatedId, []);
      entityToProps.get(relatedId)!.push(psetRef);
    }
  }

  // IFC2x3 TypeObjects carry direct HasPropertySets references.
  for (const [id, body] of index) {
    const entityTypeName = body.split('(')[0].toUpperCase();
    if (entityTypeName.startsWith('IFCREL') || !entityTypeName.endsWith('TYPE')) continue;

    const psetListRaw = (parseArgs(body)[5] ?? '').trim();
    if (!psetListRaw || psetListRaw === '$') continue;

    for (const ref of parseRefList(psetListRaw)) {
      if (!entityToProps.has(id)) entityToProps.set(id, []);
      if (!entityToProps.get(id)!.includes(ref)) entityToProps.get(id)!.push(ref);
    }
  }

  const instanceToType = new Map<string, string>();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELDEFINESBYTYPE(')) continue;
    const args = parseArgs(body);
    const typeRef = (args[5] ?? '').trim();
    if (!typeRef.startsWith('#')) continue;
    for (const relatedId of parseRefList(args[4] ?? '')) instanceToType.set(relatedId, typeRef);
  }

  const typeToInstances = new Map<string, string[]>();
  for (const [instanceId, typeId] of instanceToType) {
    if (!typeToInstances.has(typeId)) typeToInstances.set(typeId, []);
    typeToInstances.get(typeId)!.push(instanceId);
  }

  const psetValues = new Map<string, Map<string, string>>();

  function readPropertyLike(propRef: string, propMap: Map<string, string>): void {
    const propertyBody = index.get(propRef);
    if (!propertyBody) return;
    const propertyArgs = parseArgs(propertyBody);
    const propName = stepStr(propertyArgs[0] ?? '');
    if (!propName) return;

    const upper = propertyBody.toUpperCase();
    if (upper.startsWith('IFCPROPERTYSINGLEVALUE(')) {
      propMap.set(propName, parseIfcValue(propertyArgs[2] ?? '$'));
    } else if (upper.startsWith('IFCPROPERTYENUMERATEDVALUE(')) {
      propMap.set(propName, parseIfcValues(propertyArgs[2] ?? '$'));
    } else if (upper.startsWith('IFCPROPERTYLISTVALUE(')) {
      propMap.set(propName, parseIfcValues(propertyArgs[2] ?? '$'));
    } else if (upper.startsWith('IFCPROPERTYBOUNDEDVALUE(')) {
      propMap.set(propName, [parseIfcValues(propertyArgs[2] ?? '$'), parseIfcValues(propertyArgs[3] ?? '$')].filter(Boolean).join(' - '));
    } else if (upper.startsWith('IFCPROPERTYTABLEVALUE(')) {
      propMap.set(propName, [parseIfcValues(propertyArgs[2] ?? '$'), parseIfcValues(propertyArgs[3] ?? '$')].filter(Boolean).join(' / '));
    } else if (upper.startsWith('IFCPROPERTYREFERENCEVALUE(')) {
      const ref = (propertyArgs[2] ?? '').trim();
      const refBody = ref.startsWith('#') ? index.get(ref) : undefined;
      propMap.set(propName, refBody ? stepStr(parseArgs(refBody)[0] ?? '') || ref : ref);
    } else if (upper.startsWith('IFCCOMPLEXPROPERTY(')) {
      for (const nestedRef of parseRefList(propertyArgs[3] ?? '')) readPropertyLike(nestedRef, propMap);
    } else if (upper.startsWith('IFCQUANTITY')) {
      const value = propertyArgs[3] ?? propertyArgs[2] ?? '$';
      propMap.set(propName, parseIfcValue(value));
    }
  }

  for (const [psetId, body] of index) {
    const entityTypeName = body.split('(')[0].toUpperCase();
    if (entityTypeName !== 'IFCPROPERTYSET' && entityTypeName !== 'IFCELEMENTQUANTITY') continue;

    const propMap = new Map<string, string>();
    const psetArgs = parseArgs(body);
    const propsListRaw = (entityTypeName === 'IFCELEMENTQUANTITY' ? psetArgs[5] ?? '' : psetArgs[4] ?? '').trim();
    if (!propsListRaw || propsListRaw === '$') {
      psetValues.set(psetId, propMap);
      continue;
    }

    for (const propRef of parseRefList(propsListRaw)) readPropertyLike(propRef, propMap);

    const psetName = stepStr(psetArgs[2] ?? '');
    if (psetName && [...propMap.values()].some((value) => value !== '')) {
      propMap.set(psetName, 'Oui');
    }

    psetValues.set(psetId, propMap);
  }

  const materialByEntity = new Map<string, string[]>();
  const readMaterialNames = (ref: string): string[] => {
    const body = index.get(ref);
    if (!body) return [];

    const entityTypeName = body.split('(')[0].toUpperCase();
    const args = parseArgs(body);

    if (entityTypeName === 'IFCMATERIAL') {
      const name = stepStr(args[0] ?? '');
      return name ? [name] : [];
    }

    if (
      entityTypeName === 'IFCMATERIALLIST' ||
      entityTypeName === 'IFCMATERIALLAYERSET' ||
      entityTypeName === 'IFCMATERIALPROFILESET' ||
      entityTypeName === 'IFCMATERIALCONSTITUENTSET'
    ) {
      return parseRefList(args[0] ?? '').flatMap(readMaterialNames);
    }

    if (
      entityTypeName === 'IFCMATERIALLAYER' ||
      entityTypeName === 'IFCMATERIALPROFILE' ||
      entityTypeName === 'IFCMATERIALCONSTITUENT'
    ) {
      return parseRefList(args.join(',')).flatMap(readMaterialNames);
    }

    if (
      entityTypeName === 'IFCMATERIALLAYERSETUSAGE' ||
      entityTypeName === 'IFCMATERIALPROFILESETUSAGE'
    ) {
      return readMaterialNames((args[0] ?? '').trim());
    }

    return [];
  };

  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith('IFCRELASSOCIATESMATERIAL(')) continue;
    const args = parseArgs(body);
    const materialNames = [...new Set(readMaterialNames((args[5] ?? '').trim()).filter(Boolean))];
    if (materialNames.length === 0) continue;

    for (const relatedId of parseRefList(args[4] ?? '')) {
      materialByEntity.set(relatedId, materialNames);
    }
  }

  function getEntityProps(entityId: string): Map<string, string> {
    const result = new Map<string, string>();

    const collect = (id: string) => {
      for (const psetId of entityToProps.get(id) ?? []) {
        const props = psetValues.get(psetId);
        if (!props) continue;
        for (const [key, value] of props) {
          if (!result.has(key) || (result.get(key) === '' && value !== '')) result.set(key, value);
        }
      }
      const materialNames = materialByEntity.get(id);
      if (materialNames?.length) {
        const value = materialNames.join(', ');
        result.set('Matériau', value);
        result.set('Materiau', value);
        result.set('Material', value);
        result.set('Materials', value);
        result.set('Structural Material', value);
      }
    };

    collect(entityId);
    const typeId = instanceToType.get(entityId);
    if (typeId) collect(typeId);
    return result;
  }

  let typePropertySearchEntries: { id: string; keys: string[] }[] | null = null;
  function getTypePropertySearchEntries(): { id: string; keys: string[] }[] {
    if (typePropertySearchEntries) return typePropertySearchEntries;
    typePropertySearchEntries = [];
    for (const [id, body] of index) {
      if (!isLikelyElementEntity(body)) continue;

      const entityArgs = parseArgs(body);
      const ifcClass = getEntityTypeName(body);
      const entityName = stepStr(entityArgs[2] ?? '');
      const allProps = getEntityProps(id);
      const candidateValues = [
        ifcClass,
        entityName,
        stepStr(entityArgs[4] ?? ''),
        ...TYPE_NAME_PROPERTIES.map((propName) => lookupProp(allProps, propName) ?? ''),
      ].filter(Boolean);

      const candidateKeys = candidateValues.map(normalise).filter(Boolean);
      if (candidateKeys.length > 0) typePropertySearchEntries.push({ id, keys: [...new Set(candidateKeys)] });
    }
    return typePropertySearchEntries;
  }

  function findIdsByTypeProperties(searchKeys: string[]): string[] {
    const ids = getTypePropertySearchEntries()
      .filter((entry) => entry.keys.some((candidateKey) => searchKeys.some((searchKey) =>
        candidateKey === searchKey ||
        candidateKey.includes(searchKey) ||
        searchKey.includes(candidateKey)
      )))
      .map((entry) => entry.id);

    return [...new Set(ids)];
  }

  return requests.map((request) => {
    const searchKeys = searchKeyVariants(request.nomDuType);
    if (request.type) {
      for (const key of searchKeyVariants(request.type)) {
        if (!searchKeys.includes(key)) searchKeys.push(key);
      }
    }
    let matchedIds: string[] = [];
    let ifcName = request.nomDuType;

    for (const key of searchKeys) {
      const ids = nameToIds.get(key);
      if (ids) {
        matchedIds = ids;
        break;
      }
    }

    if (matchedIds.length === 0) {
      for (const key of searchKeys) {
        for (const [candidateKey, ids] of nameToIds) {
          if (candidateKey.includes(key) || key.includes(candidateKey)) matchedIds = [...matchedIds, ...ids];
        }
        if (matchedIds.length > 0) break;
      }
    }

    const idsFromTypeProperties = findIdsByTypeProperties(searchKeys);
    if (idsFromTypeProperties.length > 0) {
      matchedIds = idsFromTypeProperties;
    }

    const expandedIds = new Set(matchedIds);
    const countedInstanceIds = new Set<string>();
    for (const id of matchedIds) {
      const typeInstances = typeToInstances.get(id) ?? [];
      if (typeInstances.length > 0) {
        for (const instanceId of typeInstances) {
          expandedIds.add(instanceId);
          countedInstanceIds.add(instanceId);
        }
      } else {
        countedInstanceIds.add(id);
      }
    }

    const allProps = new Map<string, string>();
    const ifcClassesFound = new Set<string>();
    for (const id of expandedIds) {
      const body = index.get(id);
      if (body) {
        const entityTypeName = getEntityTypeName(body);
        if (entityTypeName) ifcClassesFound.add(entityTypeName);
        const realName = stepStr(parseArgs(body)[2] ?? '');
        if (realName) ifcName = realName;
      }
      for (const [key, value] of getEntityProps(id)) {
        if (!allProps.has(key) || (allProps.get(key) === '' && value !== '')) allProps.set(key, value);
      }
    }

    const props: Record<string, string | null> = {};
    for (const prop of request.properties) props[prop] = lookupProp(allProps, prop);

    const classes = [...ifcClassesFound];
    return {
      nomDuType: request.nomDuType,
      ifcName,
      ifcClass: classes[0] ?? '',
      ifcClassesFound: classes,
      instanceCount: countedInstanceIds.size,
      props,
    };
  });
}
