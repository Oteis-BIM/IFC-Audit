import { readFileSync, writeFileSync } from 'fs';

let c = readFileSync('app/api/ai-audit/route.ts', 'utf8');

const marker = "        : '- Coordonnees non trouvees dans le fichier',\n    ].join('\\n');";
const replacement = `        : '- Coordonnees non trouvees dans le fichier',
      '',
      '### IFCBUILDING :',
      \`- Name (critere 4.1)   : \${facts.building ? (facts.building.name ? '"' + facts.building.name + '"' : '(vide)') : 'non trouve'}\`,
      '',
      '### Adresse IFCSITE (IFCPOSTALADDRESS) :',
      \`- Adresse (critere 4.2) : \${facts.siteAddress ? '"' + facts.siteAddress + '"' : '(vide/non trouve)'}\`,
    ].join('\\n');`;

if (c.includes(marker)) {
  c = c.replace(marker, replacement);
  writeFileSync('app/api/ai-audit/route.ts', c);
  console.log('OK size=' + c.length);
} else {
  const idx = c.indexOf('Coordonnees non trouvees');
  console.log('NOT FOUND, context:', JSON.stringify(c.substring(idx - 10, idx + 100)));
}
