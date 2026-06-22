"""
check_ifc_props.py
==================
Batch property checker for IFC files using ifcopenshell.

Input JSON:
{
  "ifcPath": "path/to/model.ifc",
  "requests": [
    {"nomDuType": "...", "type": "...", "properties": ["INF_Type"]}
  ]
}

Output JSON:
{
  "results": [...]
}
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from typing import Any

import ifcopenshell
import ifcopenshell.util.element as ifc_element


TYPE_NAME_PROPERTIES = [
    "Nom du type",
    "Type Name",
    "TypeName",
    "IfcType",
    "Type IFC",
    "Family and Type",
    "Famille et type",
    "Name",
    "INF_Type",
]


def normalise(value: Any) -> str:
    text = "" if value is None else str(value)
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return re.sub(r"[^a-zA-Z0-9]", "", text).lower()


def property_match_keys(value: Any) -> list[str]:
    text = "" if value is None else str(value)
    raw_parts = [part.strip() for part in re.split(r"[.:]", text) if part.strip()]
    parts = raw_parts or [text]
    keys: dict[str, None] = {}

    for part in parts:
        norm = normalise(part)
        if not norm:
            continue
        keys[norm] = None
        if len(norm) > 4 and norm.endswith("s"):
            keys[norm[:-1]] = None

    full = normalise(text)
    if full:
        keys[full] = None
        if len(full) > 4 and full.endswith("s"):
            keys[full[:-1]] = None

    return list(keys.keys())


def property_names_match(actual_name: str, expected_name: str) -> bool:
    actual_keys = property_match_keys(actual_name)
    expected_keys = property_match_keys(expected_name)

    return any(
        actual == expected or (len(expected) > 4 and actual.endswith(expected))
        for actual in actual_keys
        for expected in expected_keys
    )


def search_key_variants(value: Any) -> list[str]:
    text = "" if value is None else str(value)
    keys: dict[str, None] = {}

    def add_key(candidate: str) -> None:
        key = normalise(candidate)
        if len(key) >= 4:
            keys[key] = None

    add_key(text)
    for part in re.split(r"[:;/|_\-\n\r]+", text):
        part = part.strip()
        if part:
            add_key(part)

    return list(keys.keys())


def stringify_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, tuple, set)):
        return ", ".join(stringify_value(v) for v in value if stringify_value(v))
    if isinstance(value, dict):
        values = [stringify_value(v) for key, v in value.items() if key != "id"]
        return ", ".join(v for v in values if v)
    if hasattr(value, "Name"):
        return stringify_value(getattr(value, "Name", None))
    return str(value).strip()


def is_filled(value: Any) -> bool:
    text = stringify_value(value)
    return text not in ("", "$", "*", "None", "null")


def get_type_object(element: Any) -> Any | None:
    try:
        return ifc_element.get_type(element)
    except Exception:
        return None


def get_psets(element: Any) -> dict[str, dict[str, Any]]:
    try:
        return ifc_element.get_psets(element, should_inherit=True)
    except TypeError:
        return ifc_element.get_psets(element)
    except Exception:
        return {}


def collect_material_names(material: Any, visited: set[int] | None = None) -> list[str]:
    if material is None:
        return []
    if visited is None:
        visited = set()

    material_id = getattr(material, "id", lambda: id(material))()
    if material_id in visited:
        return []
    visited.add(material_id)

    names: list[str] = []
    name = stringify_value(getattr(material, "Name", None))
    if name:
        names.append(name)

    for attr in (
        "Material",
        "Materials",
        "MaterialLayers",
        "MaterialProfiles",
        "MaterialConstituents",
        "ForLayerSet",
        "ForProfileSet",
    ):
        child = getattr(material, attr, None)
        if isinstance(child, (list, tuple, set)):
            for item in child:
                names.extend(collect_material_names(item, visited))
        elif child is not None:
            names.extend(collect_material_names(child, visited))

    return list(dict.fromkeys(names))


def add_material_properties(element: Any, flat: dict[str, list[dict[str, str]]]) -> None:
    try:
        material = ifc_element.get_material(element, should_inherit=True)
    except TypeError:
        material = ifc_element.get_material(element)
    except Exception:
        material = None

    material_names = collect_material_names(material)
    if not material_names:
        return

    value = ", ".join(material_names)
    for prop_name in ("Matériau", "Materiau", "Material", "Materials", "Structural Material"):
        flat.setdefault(prop_name, []).append({"pset": "Materials", "value": value})


def flatten_properties(psets: dict[str, dict[str, Any]]) -> dict[str, list[dict[str, str]]]:
    flat: dict[str, list[dict[str, str]]] = {}

    for pset_name, props in psets.items():
        if not isinstance(props, dict):
            continue

        pset_has_value = False
        for prop_name, raw_value in props.items():
            if prop_name == "id":
                continue

            value = stringify_value(raw_value)
            if not is_filled(value):
                continue

            pset_has_value = True
            flat.setdefault(prop_name, []).append({"pset": pset_name, "value": value})

        # This supports checks where the expected "property" is really a Pset/group name.
        if pset_has_value:
            flat.setdefault(pset_name, []).append({"pset": pset_name, "value": "Oui"})

    return flat


def lookup_property(flat_props: dict[str, list[dict[str, str]]], prop_name: str) -> list[dict[str, str]]:
    matches: list[dict[str, str]] = []

    for key, entries in flat_props.items():
        if key == prop_name or key.lower() == prop_name.lower() or property_names_match(key, prop_name):
            matches.extend(entries)

    return matches


def candidate_values(element: Any, psets: dict[str, dict[str, Any]]) -> list[str]:
    values: list[str] = []

    try:
        values.append(element.is_a())
    except Exception:
        pass

    for attr in ("Name", "ObjectType", "Tag", "GlobalId"):
        value = stringify_value(getattr(element, attr, None))
        if value:
            values.append(value)

    type_object = get_type_object(element)
    if type_object is not None:
        try:
            values.append(type_object.is_a())
        except Exception:
            pass
        for attr in ("Name", "ElementType", "Tag", "GlobalId"):
            value = stringify_value(getattr(type_object, attr, None))
            if value:
                values.append(value)

    for attr in ("PredefinedType", "ObjectType", "ElementType"):
        value = stringify_value(getattr(element, attr, None))
        if value:
            values.append(value)
        if type_object is not None:
            type_value = stringify_value(getattr(type_object, attr, None))
            if type_value:
                values.append(type_value)

    flat_props = flatten_properties(psets)
    for prop_name in TYPE_NAME_PROPERTIES:
        for entry in lookup_property(flat_props, prop_name):
            if entry["value"]:
                values.append(entry["value"])

    return list(dict.fromkeys(values))


def element_matches(element: Any, request: dict[str, Any], psets: dict[str, dict[str, Any]]) -> bool:
    search_terms = [request.get("nomDuType"), request.get("type")]
    search_keys = list(dict.fromkeys(key for term in search_terms for key in search_key_variants(term)))
    if not search_keys:
        return False

    candidates = [normalise(value) for value in candidate_values(element, psets) if normalise(value)]
    if any(
        candidate == search_key or candidate in search_key or search_key in candidate
        for candidate in candidates
        for search_key in search_keys
    ):
        return True

    ifc_classes = request.get("ifcClasses")
    if isinstance(ifc_classes, list):
        class_keys = []
        for value in ifc_classes:
            class_keys.extend(normalise(part) for part in re.split(r"[\s,]+", str(value)) if normalise(part))
            if normalise(value):
                class_keys.append(normalise(value))
        class_keys = list(dict.fromkeys(class_keys))
        return any(candidate == class_key for candidate in candidates for class_key in class_keys)

    return False


def check_request(elements: list[Any], request: dict[str, Any]) -> dict[str, Any]:
    matched: list[tuple[Any, dict[str, dict[str, Any]], dict[str, list[dict[str, str]]]]] = []

    for element in elements:
        psets = get_psets(element)
        if element_matches(element, request, psets):
            flat_props = flatten_properties(psets)
            add_material_properties(element, flat_props)
            matched.append((element, psets, flat_props))

    prop_values: dict[str, str | None] = {}
    prop_details: dict[str, dict[str, Any]] = {}

    for prop_name in request.get("properties", []):
        hits: list[dict[str, str]] = []
        missing_examples: list[str] = []

        for element, _psets, flat_props in matched:
            element_hits = lookup_property(flat_props, prop_name)
            if element_hits:
                hits.extend(element_hits)
            elif len(missing_examples) < 5:
                missing_examples.append(
                    stringify_value(getattr(element, "Name", None))
                    or stringify_value(getattr(element, "GlobalId", None))
                    or "element"
                )

        values = [hit["value"] for hit in hits if hit["value"]]
        psets = [hit["pset"] for hit in hits if hit["pset"]]
        unique_values = list(dict.fromkeys(values))
        unique_psets = list(dict.fromkeys(psets))

        prop_values[prop_name] = " / ".join(unique_values) if unique_values else None
        prop_details[prop_name] = {
            "presentCount": len({(hit["pset"], hit["value"]) for hit in hits}),
            "checkedCount": len(matched),
            "psets": unique_psets,
            "values": unique_values,
            "missingExamples": missing_examples,
        }

    ifc_name = request.get("nomDuType", "")
    if matched:
        ifc_name = stringify_value(getattr(matched[0][0], "Name", None)) or ifc_name

    return {
        "nomDuType": request.get("nomDuType", ""),
        "ifcName": ifc_name,
        "instanceCount": len(matched),
        "props": prop_values,
        "propDetails": prop_details,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Path to input JSON")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as handle:
        payload = json.load(handle)

    model = ifcopenshell.open(payload["ifcPath"])
    elements = list(model.by_type("IfcObject"))
    requests = payload.get("requests", [])
    results = [check_request(elements, request) for request in requests]

    print(json.dumps({"results": results}, ensure_ascii=False))


if __name__ == "__main__":
    main()
