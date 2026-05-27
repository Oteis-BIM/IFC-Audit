import re

with open('app/api/ai-audit/route.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Insert IFCBUILDING + IFCPOSTALADDRESS extraction before 'return facts;'
insertion = """
  // IFCBUILDING - Name (critere 4.1)
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCBUILDING(')) {
      const args = parseArgs(body);
      facts.building = { name: stepStr(args[2] ?? '') };
      break;
    }
  }

  // IFCPOSTALADDRESS - adresse du site (critere 4.2)
  for (const [, body] of index) {
    if (body.toUpperCase().startsWith('IFCPOSTALADDRESS(')) {
      const args = parseArgs(body);
      const addrLines = args[4];
      const town     = stepStr(args[6] ?? '');
      const zip      = stepStr(args[8] ?? '');
      const country  = stepStr(args[9] ?? '');
      const lineMatch = addrLines ? addrLines.match(/\\(([^)]+)\\)/) : null;
      const streetParts = lineMatch ? lineMatch[1].split(',').map((s: string) => stepStr(s.trim())).filter(Boolean) : [];
      const parts = [...streetParts, town, zip, country].filter(Boolean);
      facts.siteAddress = parts.length > 0 ? parts.join(', ') : null;
      break;
    }
  }
"""

old_ret = "  return facts;\n}\nfunction extractIfcContent"
if old_ret in content:
    content = content.replace(old_ret, insertion + "  return facts;\n}\nfunction extractIfcContent")
    print("Extraction block inserted")
else:
    print("ERROR: return facts marker not found")

# 2. Add 4.x lines in factsBlock using simple string concat (no template literals)
facts_4 = """,
      '',
      '### IFCBUILDING :',
      `- Name (critere 4.1) : ${facts.building ? (facts.building.name ? '"' + facts.building.name + '"' : '(vide)') : 'non trouve'}`,
      '',
      '### Adresse IFCSITE (IFCPOSTALADDRESS) :',
      `- Adresse (critere 4.2) : ${facts.siteAddress ? '"' + facts.siteAddress + '"' : '(vide/non trouve)'}`,"""

marker = "        : '- Coordonnees non trouvees dans le fichier',\n    ].join('\\n');"
if marker in content:
    content = content.replace(
        marker,
        "        : '- Coordonnees non trouvees dans le fichier'," + facts_4 + "\n    ].join('\\n');"
    )
    print("factsBlock updated")
else:
    print("ERROR: factsBlock marker not found, trying alternative...")
    # Try to find and show context
    idx = content.find("Coordonnees non trouvees")
    if idx >= 0:
        print("Context:", repr(content[idx-10:idx+80]))

with open('app/api/ai-audit/route.ts', 'w', encoding='utf-8') as f:
    f.write(content)
print('Done, size:', len(content))
