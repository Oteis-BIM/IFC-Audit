import { buildEntityIndex, parseArgs, stepStr } from '@/lib/ifc-parser';

export type PropCheckRequest = {
  nomDuType: string;
  type?: string;
  properties: string[];
};

export type PropCheckResult = {
  nomDuType: string;
  ifcName: string;
  instanceCount: number;
  props: Record<string, string | null>;
};

function normalise(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseRefList(raw: string): string[] {
  return raw.replace(/[()]/g, '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('#'));
}

function lookupProp(allProps: Map<string, string>, propName: string): string | null {
  const exact = allProps.get(propName);
  if (exact !== undefined) return exact === '' ? null : exact;

  const lower = propName.toLowerCase();
  for (const [key, value] of allProps) {
    if (key.toLowerCase() === lower) return value === '' ? null : value;
  }

  const norm = normalise(propName);
  for (const [key, value] of allProps) {
    if (normalise(key) === norm) return value === '' ? null : value;
  }

  return null;
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

  const psetValues = new Map<string, Map<string, string>>();
  for (const [psetId, body] of index) {
    const entityTypeName = body.split('(')[0].toUpperCase();
    if (entityTypeName !== 'IFCPROPERTYSET' && entityTypeName !== 'IFCELEMENTQUANTITY') continue;

    const propMap = new Map<string, string>();
    const propsListRaw = (parseArgs(body)[4] ?? '').trim();
    if (!propsListRaw || propsListRaw === '$') {
      psetValues.set(psetId, propMap);
      continue;
    }

    for (const propRef of parseRefList(propsListRaw)) {
      const propertyBody = index.get(propRef);
      if (!propertyBody) continue;
      const propertyArgs = parseArgs(propertyBody);
      const propName = stepStr(propertyArgs[0] ?? '');
      if (!propName) continue;

      const upper = propertyBody.toUpperCase();
      if (upper.startsWith('IFCPROPERTYSINGLEVALUE(')) {
        const nominalValue = propertyArgs[2] ?? '$';
        const inner = nominalValue !== '$' ? nominalValue.match(/\(([^)]*)\)/) : null;
        propMap.set(propName, inner ? stepStr(inner[1]) : stepStr(nominalValue));
      } else if (upper.startsWith('IFCPROPERTYENUMERATEDVALUE(')) {
        const enumValsRaw = (propertyArgs[2] ?? '$').replace(/[()]/g, '');
        const vals = [...enumValsRaw.matchAll(/\(([^)]*)\)/g)].map((match) => stepStr(match[1])).filter(Boolean);
        propMap.set(propName, vals.join(', '));
      } else if (upper.startsWith('IFCQUANTITY')) {
        const value = propertyArgs[3] ?? propertyArgs[2] ?? '$';
        propMap.set(propName, value === '$' ? '' : value.trim());
      }
    }

    psetValues.set(psetId, propMap);
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
    };

    collect(entityId);
    const typeId = instanceToType.get(entityId);
    if (typeId) collect(typeId);
    return result;
  }

  return requests.map((request) => {
    const searchKeys = [normalise(request.nomDuType)];
    if (request.type) {
      const shortType = normalise(request.type);
      if (!searchKeys.includes(shortType)) searchKeys.push(shortType);
    }

    let instanceIds: string[] = [];
    let ifcName = request.nomDuType;

    for (const key of searchKeys) {
      const ids = nameToIds.get(key);
      if (ids) {
        instanceIds = ids;
        break;
      }
    }

    if (instanceIds.length === 0) {
      for (const key of searchKeys) {
        for (const [candidateKey, ids] of nameToIds) {
          if (candidateKey.includes(key) || key.includes(candidateKey)) instanceIds = [...instanceIds, ...ids];
        }
        if (instanceIds.length > 0) break;
      }
    }

    const allProps = new Map<string, string>();
    for (const id of instanceIds) {
      const body = index.get(id);
      if (body) {
        const realName = stepStr(parseArgs(body)[2] ?? '');
        if (realName) ifcName = realName;
      }
      for (const [key, value] of getEntityProps(id)) {
        if (!allProps.has(key) || (allProps.get(key) === '' && value !== '')) allProps.set(key, value);
      }
    }

    const props: Record<string, string | null> = {};
    for (const prop of request.properties) props[prop] = lookupProp(allProps, prop);

    return { nomDuType: request.nomDuType, ifcName, instanceCount: instanceIds.length, props };
  });
}
