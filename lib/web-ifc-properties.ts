import type { IfcAPI } from 'web-ifc';
import {
  IFCRELASSOCIATESMATERIAL,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELDEFINESBYTYPE,
} from 'web-ifc';

export type IfcPropertyValue = string | number | boolean | null;
export type IfcPropertySets = Record<string, Record<string, IfcPropertyValue>>;

export type IfcPropertyLookup = {
  has: (propertyName: string, psetName?: string) => boolean;
  get: (propertyName: string, psetName?: string) => IfcPropertyValue | undefined;
  entries: Map<string, IfcPropertyValue>;
};

export type ObjectPropertiesResult = {
  propertySets: IfcPropertySets;
  lookup: IfcPropertyLookup;
};

export type IfcPropertyIndex = {
  definesByProperties: Map<number, number[]>;
  definesByType: Map<number, number>;
  typePropertySets: Map<number, number[]>;
  materialAssociations: Map<number, number[]>;
};

type IfcLine = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function refId(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (isRecord(value) && typeof value.value === 'number') return value.value;
  return null;
}

function refIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(refId).filter((id): id is number => id !== null);
}

function lineName(line: unknown): string {
  if (!isRecord(line)) return '';
  const name = line.Name;
  if (isRecord(name) && name.value != null) return String(name.value);
  if (typeof name === 'string') return name;
  return '';
}

function unwrapIfcValue(value: unknown): IfcPropertyValue {
  if (value == null) return null;

  if (isRecord(value)) {
    if ('value' in value) return unwrapIfcValue(value.value);
    if ('wrappedValue' in value) return unwrapIfcValue(value.wrappedValue);
    if ('type' in value && 'value' in value) return unwrapIfcValue(value.value);
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  return String(value);
}

function normaliseKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function getLine(ifcApi: IfcAPI, modelID: number, expressID: number): IfcLine | null {
  try {
    const line = ifcApi.GetLine(modelID, expressID);
    return isRecord(line) ? line : null;
  } catch {
    return null;
  }
}

function getLineIdsWithType(ifcApi: IfcAPI, modelID: number, type: number): number[] {
  try {
    const ids = ifcApi.GetLineIDsWithType(modelID, type, true);
    const result: number[] = [];
    for (let i = 0; i < ids.size(); i++) result.push(ids.get(i));
    return result;
  } catch {
    return [];
  }
}

function addToMapList(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) {
    if (!list.includes(value)) list.push(value);
  } else {
    map.set(key, [value]);
  }
}

export function buildIfcPropertyIndex(ifcApi: IfcAPI, modelID: number): IfcPropertyIndex {
  const index: IfcPropertyIndex = {
    definesByProperties: new Map(),
    definesByType: new Map(),
    typePropertySets: new Map(),
    materialAssociations: new Map(),
  };

  for (const relId of getLineIdsWithType(ifcApi, modelID, IFCRELDEFINESBYPROPERTIES)) {
    const rel = getLine(ifcApi, modelID, relId);
    const psetId = refId(rel?.RelatingPropertyDefinition);
    if (!psetId) continue;

    for (const objectId of refIds(rel?.RelatedObjects)) {
      addToMapList(index.definesByProperties, objectId, psetId);
    }
  }

  for (const relId of getLineIdsWithType(ifcApi, modelID, IFCRELDEFINESBYTYPE)) {
    const rel = getLine(ifcApi, modelID, relId);
    const typeId = refId(rel?.RelatingType);
    if (!typeId) continue;

    for (const objectId of refIds(rel?.RelatedObjects)) {
      index.definesByType.set(objectId, typeId);
    }

    const typeLine = getLine(ifcApi, modelID, typeId);
    const psetIds = refIds(typeLine?.HasPropertySets);
    if (psetIds.length > 0) index.typePropertySets.set(typeId, psetIds);
  }

  for (const relId of getLineIdsWithType(ifcApi, modelID, IFCRELASSOCIATESMATERIAL)) {
    const rel = getLine(ifcApi, modelID, relId);
    const materialId = refId(rel?.RelatingMaterial);
    if (!materialId) continue;

    for (const objectId of refIds(rel?.RelatedObjects)) {
      addToMapList(index.materialAssociations, objectId, materialId);
    }
  }

  return index;
}

function readSingleProperty(prop: IfcLine): [string, IfcPropertyValue] | null {
  const name = lineName(prop);
  if (!name) return null;

  const value =
    prop.NominalValue ??
    prop.EnumerationValues ??
    prop.ListValues ??
    prop.UpperBoundValue ??
    prop.LowerBoundValue ??
    prop.SetPointValue ??
    prop.PropertyReference ??
    null;

  if (Array.isArray(value)) {
    return [name, value.map(unwrapIfcValue).filter(v => v !== null).join(', ')];
  }

  return [name, unwrapIfcValue(value)];
}

function readQuantity(quantity: IfcLine): [string, IfcPropertyValue] | null {
  const name = lineName(quantity);
  if (!name) return null;

  const value =
    quantity.LengthValue ??
    quantity.AreaValue ??
    quantity.VolumeValue ??
    quantity.WeightValue ??
    quantity.CountValue ??
    quantity.TimeValue ??
    null;

  return [name, unwrapIfcValue(value)];
}

function readPropertySet(ifcApi: IfcAPI, modelID: number, psetId: number): [string, Record<string, IfcPropertyValue>] | null {
  const pset = getLine(ifcApi, modelID, psetId);
  if (!pset) return null;

  const psetName = lineName(pset) || `PropertySet_${psetId}`;
  const isQuantitySet = Array.isArray(pset.Quantities);
  const propertyRefs = refIds(pset.HasProperties ?? pset.Quantities);
  const properties: Record<string, IfcPropertyValue> = {};

  for (const propId of propertyRefs) {
    const prop = getLine(ifcApi, modelID, propId);
    if (!prop) continue;

    const entry = isQuantitySet ? readQuantity(prop) : readSingleProperty(prop) ?? readQuantity(prop);
    if (entry) properties[entry[0]] = entry[1];
  }

  return [psetName, properties];
}

function collectMaterialNames(ifcApi: IfcAPI, modelID: number, materialId: number, visited = new Set<number>()): string[] {
  if (visited.has(materialId)) return [];
  visited.add(materialId);

  const material = getLine(ifcApi, modelID, materialId);
  if (!material) return [];

  const name = lineName(material);
  const nestedRefs = [
    ...refIds(material.Materials),
    ...refIds(material.MaterialLayers),
    ...refIds(material.MaterialConstituents),
    ...refIds(material.ForLayerSet),
    ...refIds(material.MaterialProfiles),
    ...refIds(material.ForProfileSet),
  ];

  const nestedNames = nestedRefs.flatMap(id => collectMaterialNames(ifcApi, modelID, id, visited));
  return [...new Set([name, ...nestedNames].filter(Boolean))];
}

function buildLookup(propertySets: IfcPropertySets): IfcPropertyLookup {
  const entries = new Map<string, IfcPropertyValue>();

  for (const [psetName, props] of Object.entries(propertySets)) {
    for (const [propName, value] of Object.entries(props)) {
      entries.set(`${normaliseKey(psetName)}.${normaliseKey(propName)}`, value);
      entries.set(normaliseKey(propName), value);
    }
  }

  return {
    entries,
    has(propertyName, psetName) {
      const value = this.get(propertyName, psetName);
      return value !== undefined && value !== null && String(value).trim() !== '';
    },
    get(propertyName, psetName) {
      const propKey = normaliseKey(propertyName);
      if (psetName) return entries.get(`${normaliseKey(psetName)}.${propKey}`);
      return entries.get(propKey);
    },
  };
}

export function getObjectProperties(
  ifcApi: IfcAPI,
  modelID: number,
  objectExpressID: number,
  index = buildIfcPropertyIndex(ifcApi, modelID)
): ObjectPropertiesResult {
  const propertySets: IfcPropertySets = {};
  const psetIds = new Set(index.definesByProperties.get(objectExpressID) ?? []);

  const typeId = index.definesByType.get(objectExpressID);
  if (typeId) {
    for (const psetId of index.typePropertySets.get(typeId) ?? []) {
      psetIds.add(psetId);
    }
  }

  for (const psetId of psetIds) {
    const pset = readPropertySet(ifcApi, modelID, psetId);
    if (!pset) continue;
    const [psetName, props] = pset;
    propertySets[psetName] = { ...(propertySets[psetName] ?? {}), ...props };
  }

  const materialNames = (index.materialAssociations.get(objectExpressID) ?? [])
    .flatMap(materialId => collectMaterialNames(ifcApi, modelID, materialId));

  if (materialNames.length > 0) {
    propertySets.Materials = {
      Material: [...new Set(materialNames)].join(', '),
      Materiau: [...new Set(materialNames)].join(', '),
      'Matériau': [...new Set(materialNames)].join(', '),
    };
  }

  return {
    propertySets,
    lookup: buildLookup(propertySets),
  };
}
