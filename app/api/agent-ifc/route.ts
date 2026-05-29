import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const question = (body.question ?? body.prompt ?? '').trim();
    const ifcPath = (body.ifcPath ?? body.ifc ?? '').trim();

    if (!question || !ifcPath) {
      return NextResponse.json({ error: 'Champs manquants.' }, { status: 400 });
    }

    const projectRoot = process.cwd();
    const scriptPath = path.join(projectRoot, 'scripts', 'agent_ifc.py');

    // Chemin absolu vers Python pour éviter ENOENT quand le PATH du process enfant est restreint
    // Windows Store alias ('python') peut être invisible aux process enfants → on utilise le chemin complet
    const pythonCommand = process.platform === 'win32'
      ? (process.env.PYTHON_PATH ?? 'C:\\Users\\morgan.Lenin\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe')
      : 'python3';

    const childEnv = {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    };

    // On lance le script Python
    const child = spawn(pythonCommand, [scriptPath, '--question', question, '--ifc', ifcPath], {
      cwd: projectRoot,
      env: childEnv,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    return new Promise<NextResponse>((resolve) => {
      child.on('close', (code) => {
        if (code !== 0) {
          resolve(NextResponse.json({ error: `Erreur Python : ${stderr}` }, { status: 500 }));
        } else {
          // Extraction du résultat final du script
          const marker = 'RESULTAT_FINAL:';
          const idx = stdout.lastIndexOf(marker);
          const response = idx !== -1 ? stdout.slice(idx + marker.length).trim() : stdout.trim();
          resolve(NextResponse.json({ response }));
        }
      });

      child.on('error', (err) => {
        resolve(NextResponse.json({ error: `Lancement impossible : ${err.message}` }, { status: 500 }));
      });
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}