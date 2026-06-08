import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

export const runtime = "nodejs";

export type PropCheckResult = {
  nomDuType:     string;
  ifcName:       string;
  instanceCount: number;
  props:         Record<string, string | null>;
};

function stepStr(val: string): string {
  if (!val || val === "$") return "";
  return val.replace(/^'|'$/g, "");
}

function buildEntityIndex(raw: string): Map<string, string> {
  const index     = new Map<string, string>();
  const dataStart = raw.indexOf("DATA;");
  const content   = dataStart >= 0 ? raw.slice(dataStart) : raw;
  const re = /(#\d+)\s*=\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) index.set(m[1], m[2].trim());
  return index;
}

function parseArgs(body: string): string[] {
  const start = body.indexOf("(");
  if (start === -1) return [];
  const inner = body.slice(start + 1, body.lastIndexOf(")"));
  const args: string[] = [];
  let depth = 0, cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { args.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

function normalise(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseRefList(raw: string): string[] {
  return raw.replace(/[()]/g, "").split(",").map((s: string) => s.trim()).filter((s: string) => s.startsWith("#"));
}

function extractPropsFromIfc(
  raw: string,
  requests: { nomDuType: string; type?: string; properties: string[] }[],
): PropCheckResult[] {
  const index = buildEntityIndex(raw);

  // 1. Index nom normalise -> [#id]
  const nameToIds = new Map<string, string[]>();
  for (const [id, body] of index) {
    if (!body.toUpperCase().startsWith("IFC")) continue;
    const name = stepStr(parseArgs(body)[2] ?? "");
    if (!name) continue;
    const key = normalise(name);
    if (!nameToIds.has(key)) nameToIds.set(key, []);
    nameToIds.get(key)!.push(id);
  }

  // 2. IfcRelDefinesByProperties : entite -> [psetId]
  const entityToProps = new Map<string, string[]>();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith("IFCRELDEFINESBYPROPERTIES(")) continue;
    const args   = parseArgs(body);
    const psetRef = (args[5] ?? "").trim();
    if (!psetRef.startsWith("#")) continue;
    for (const rid of parseRefList(args[4] ?? "")) {
      if (!entityToProps.has(rid)) entityToProps.set(rid, []);
      entityToProps.get(rid)!.push(psetRef);
    }
  }

  // 2b. TypeObject HasPropertySets — IFC 2x3 : les TypeObjects (IfcElectricApplianceType,
  //     IfcLightFixtureType, etc.) référencent leurs Psets DIRECTEMENT via HasPropertySets
  //     (args[5]), PAS via IfcRelDefinesByProperties. C'est la cause des valeurs manquantes.
  for (const [id, body] of index) {
    const entityTypeName = body.split("(")[0].toUpperCase();
    // TypeObjects : nom IFC qui finit par "TYPE" mais qui n'est pas une Relation (IFCREL…)
    if (!entityTypeName.startsWith("IFCREL") && entityTypeName.endsWith("TYPE")) {
      const args = parseArgs(body);
      const psetListRaw = (args[5] ?? "").trim();
      if (psetListRaw && psetListRaw !== "$") {
        const psetRefs = parseRefList(psetListRaw);
        for (const ref of psetRefs) {
          if (!entityToProps.has(id)) entityToProps.set(id, []);
          if (!entityToProps.get(id)!.includes(ref)) entityToProps.get(id)!.push(ref);
        }
      }
    }
  }

  // 3. IfcRelDefinesByType : instance -> typeObjectId
  const instanceToType = new Map<string, string>();
  for (const [, body] of index) {
    if (!body.toUpperCase().startsWith("IFCRELDEFINESBYTYPE(")) continue;
    const args   = parseArgs(body);
    const typeRef = (args[5] ?? "").trim();
    if (!typeRef.startsWith("#")) continue;
    for (const rid of parseRefList(args[4] ?? "")) instanceToType.set(rid, typeRef);
  }

  // 4. PropertySet -> Map<propName, valeur>
  const psetValues = new Map<string, Map<string, string>>();
  for (const [psetId, body] of index) {
    const entityTypeName = body.split("(")[0].toUpperCase();
    // Gère IfcPropertySet ET IfcElementQuantity
    if (entityTypeName !== "IFCPROPERTYSET" && entityTypeName !== "IFCELEMENTQUANTITY") continue;
    const propMap = new Map<string, string>();
    const pArgs = parseArgs(body);
    const propsListRaw = (pArgs[4] ?? "").trim();
    if (!propsListRaw || propsListRaw === "$") { psetValues.set(psetId, propMap); continue; }
    for (const propRef of parseRefList(propsListRaw)) {
      const pb = index.get(propRef);
      if (!pb) continue;
      const pbUpper = pb.toUpperCase();
      const pa = parseArgs(pb);
      // IfcPropertySingleValue(Name, Description, NominalValue, Unit)
      if (pbUpper.startsWith("IFCPROPERTYSINGLEVALUE(")) {
        const propName = stepStr(pa[0] ?? "");
        if (!propName) continue;
        const nom = pa[2] ?? "$";
        let val = "";
        if (nom && nom !== "$") {
          const inner = nom.match(/\(([^)]*)\)/);
          val = inner ? stepStr(inner[1]) : stepStr(nom);
        }
        propMap.set(propName, val);
      }
      // IfcPropertyEnumeratedValue(Name, Description, EnumerationValues, EnumerationReference)
      else if (pbUpper.startsWith("IFCPROPERTYENUMERATEDVALUE(")) {
        const propName = stepStr(pa[0] ?? "");
        if (!propName) continue;
        const enumValsRaw = (pa[2] ?? "$").replace(/[()]/g, "");
        const vals = [...enumValsRaw.matchAll(/\(([^)]*)\)/g)].map(mm => stepStr(mm[1])).filter(Boolean);
        propMap.set(propName, vals.join(", "));
      }
      // IfcQuantityLength / IfcQuantityArea / IfcQuantityVolume
      else if (pbUpper.startsWith("IFCQUANTITY")) {
        const propName = stepStr(pa[0] ?? "");
        if (!propName) continue;
        const val = pa[3] ?? pa[2] ?? "$";
        propMap.set(propName, val === "$" ? "" : val.trim());
      }
    }
    psetValues.set(psetId, propMap);
  }

  function getEntityProps(eid: string): Map<string, string> {
    const result = new Map<string, string>();
    const collect = (id: string) => {
      for (const psetId of entityToProps.get(id) ?? []) {
        const pm = psetValues.get(psetId);
        if (!pm) continue;
        for (const [k, v] of pm) {
          if (!result.has(k) || (result.get(k) === "" && v !== "")) result.set(k, v);
        }
      }
    };
    collect(eid);
    const typeId = instanceToType.get(eid);
    if (typeId) collect(typeId);
    return result;
  }

  /** Lookup insensible à la casse, puis normalisé sans accents */
  function lookupProp(allProps: Map<string, string>, propName: string): string | null {
    // 1) Correspondance exacte
    const exact = allProps.get(propName);
    if (exact !== undefined) return exact === "" ? null : exact;
    // 2) Insensible à la casse
    const lower = propName.toLowerCase();
    for (const [k, v] of allProps) {
      if (k.toLowerCase() === lower) return v === "" ? null : v;
    }
    // 3) Normalisé (sans accents, sans tirets/espaces)
    const norm = normalise(propName);
    for (const [k, v] of allProps) {
      if (normalise(k) === norm) return v === "" ? null : v;
    }
    return null;
  }

  const results: PropCheckResult[] = [];

  for (const req of requests) {
    const searchKeys = [normalise(req.nomDuType)];
    if (req.type) {
      const short = normalise(req.type);
      if (!searchKeys.includes(short)) searchKeys.push(short);
    }

    let instanceIds: string[] = [];
    let ifcName = req.nomDuType;

    for (const key of searchKeys) {
      if (nameToIds.has(key)) { instanceIds = nameToIds.get(key)!; break; }
    }

    if (instanceIds.length === 0) {
      for (const key of searchKeys) {
        for (const [k, ids] of nameToIds) {
          if (k.includes(key) || key.includes(k)) instanceIds = [...instanceIds, ...ids];
        }
        if (instanceIds.length > 0) break;
      }
    }

    const allProps = new Map<string, string>();
    for (const id of instanceIds) {
      const body = index.get(id);
      if (body) {
        const rn = stepStr(parseArgs(body)[2] ?? "");
        if (rn) ifcName = rn;
      }
      for (const [k, v] of getEntityProps(id)) {
        if (!allProps.has(k) || (allProps.get(k) === "" && v !== "")) allProps.set(k, v);
      }
    }

    const propValues: Record<string, string | null> = {};
    for (const prop of req.properties) {
      propValues[prop] = lookupProp(allProps, prop);
    }

    results.push({ nomDuType: req.nomDuType, ifcName, instanceCount: instanceIds.length, props: propValues });
  }

  return results;
}

async function refreshAccessToken(rt: string): Promise<string | null> {
  const res = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token", refresh_token: rt,
      client_id: process.env.BOX_CLIENT_ID!, client_secret: process.env.BOX_CLIENT_SECRET!,
    }),
  });
  return (await res.json()).access_token ?? null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      fileId:   string;
      requests: { nomDuType: string; type?: string; properties: string[] }[];
    };
    const { fileId, requests } = body;
    if (!fileId)           return NextResponse.json({ error: "fileId requis" }, { status: 400 });
    if (!requests?.length) return NextResponse.json({ results: [] });

    const cookieStore  = await cookies();
    let accessToken    = cookieStore.get("box_access_token")?.value;
    const refreshToken = cookieStore.get("box_refresh_token")?.value;
    if (!accessToken && refreshToken) accessToken = await refreshAccessToken(refreshToken) ?? undefined;
    if (!accessToken) return NextResponse.json({ error: "Non authentifie sur Box" }, { status: 401 });

    const boxRes = await fetch(`https://api.box.com/2.0/files/${fileId}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!boxRes.ok) return NextResponse.json({ error: `Erreur Box ${boxRes.status}` }, { status: 502 });

    const raw     = new TextDecoder("utf-8", { fatal: false }).decode(await boxRes.arrayBuffer());
    const results = extractPropsFromIfc(raw, requests);
    return NextResponse.json({ results });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}