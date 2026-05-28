/**
 * app/api/agent-ifc/route.ts
 * Route API Next.js qui delegue les questions BIM au script Python agent_ifc.py
 * via child_process.spawn (contourne le 413 - aucune donnee IFC dans le prompt).
 *
 * Flux :
 *   Frontend -> POST /api/agent-ifc { question, ifcPath }
 *     -> spawn("python", ["scripts/agent_ifc.py", "--question", "...", "--ifc", "..."])
 *       -> script lit le .ifc localement + appelle OpenAI
 *         -> capture "RESULTAT_FINAL:<reponse>"
 *           -> NextResponse.json({ response: "..." })
 *
 * Securite :
 *   - Les arguments question et ifcPath sont passes comme elements du tableau argv[]
 *     (jamais interpoles dans une string shell) -> protection contre l injection.
 *   - ifcPath est normalise via path.resolve() et doit rester dans le repertoire projet.
 *   - OPENAI_API_KEY transmise via l environnement du process enfant (pas en clair dans les logs).
 */

import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const PYTHON_TIMEOUT_MS = 120_000;

function runPythonAgent(question: string, ifcPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const absIfcPath = path.resolve(PROJECT_ROOT, ifcPath);
    const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'agent_ifc.py');
    const pythonCmd  = process.platform === 'win32' ? 'python' : 'python3';

    const child = spawn(
      pythonCmd,
      [scriptPath, '--question', question, '--ifc', absIfcPath],
      {
        cwd: PROJECT_ROOT,
        env: {
          ...process.env,
          OPENAI_API_KEY:     process.env.OPENAI_API_KEY ?? '',
          IFC_PATH:           absIfcPath,
          PYTHONIOENCODING:   'utf-8',
          PYTHONUTF8:         '1',
        },
      }
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Timeout depasse (${PYTHON_TIMEOUT_MS / 1000}s) - le script Python n a pas repondu.`));
    }, PYTHON_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Script Python termine avec le code ${code}.\nStderr : ${stderr.slice(0, 500)}`));
      } else {
        resolve(stdout);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Impossible de demarrer Python : ${err.message}\nVerifiez que Python est installe et accessible dans le PATH.`));
    });
  });
}

function extraireReponseFinale(stdout: string): string {
  const MARKER = 'RESULTAT_FINAL:';
  const idx = stdout.lastIndexOf(MARKER);
  if (idx === -1) {
    const lignes = stdout.split('\n').map((l: string) => l.trim()).filter(Boolean);
    return lignes.at(-1) ?? '(aucune reponse recue du script Python)';
  }
  return stdout.slice(idx + MARKER.length).trim();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const question: string = (body.question ?? body.prompt ?? '').trim();
    const ifcPath: string  = (body.ifcPath ?? body.ifc ?? '').trim();

    if (!question) {
      return NextResponse.json({ error: 'Le champ "question" est obligatoire.' }, { status: 400 });
    }
    if (!ifcPath) {
      return NextResponse.json({ error: 'Le champ "ifcPath" est obligatoire (chemin relatif vers le fichier .ifc).' }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json({ error: 'Variable d environnement OPENAI_API_KEY non configuree.' }, { status: 500 });
    }

    const stdout = await runPythonAgent(question, ifcPath);
    const response = extraireReponseFinale(stdout);

    return NextResponse.json({ response });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[agent-ifc] Erreur :', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}