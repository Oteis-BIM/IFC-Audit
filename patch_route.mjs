import { readFileSync, writeFileSync } from 'fs';

const path = 'app/api/ai-audit/route.ts';
let content = readFileSync(path, 'utf-8');

// 1. Vérifier que IFCBUILDING extraction est bien là
if (!content.includes('IFCBUILDING(')) {
  console.error('IFCBUILDING extraction missing!');
}

// 2. Insérer les lignes 4.x dans factsBlock
const marker = `        : '- Coordonnees non trouvees dans le fichier',\n    ].join('\\n');`;
const facts4 = `        : '- Coordonnees non trouvees dans le fichier',
      '',
      '### IFCBUILDING :',
      \`- Name (critere 4.1) : \${facts.building ? (facts.building.name ? '"' + facts.building.name + '"' : '(vide)') : 'non trouve'}\`,
      '',
      '### Adresse IFCSITE (IFCPOSTALADDRESS) :',
      \`- Adresse (critere 4.2) : \${facts.siteAddress ? '"' + facts.siteAddress + '"' : '(vide/non trouve)'}\`,
    ].join('\\n');`;

if (content.includes(marker)) {
  content = content.replace(marker, facts4);
  console.log('factsBlock updated');
} else {
  console.error('marker not found!');
  const idx = content.indexOf('Coordonnees non trouvees');
  console.log('context:', JSON.stringify(content.slice(idx - 5, idx + 60)));
}

writeFileSync(path, content, 'utf-8');
console.log('Done, size:', content.length);
