import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import path from 'path';

export const runtime = 'nodejs';
export const maxDuration = 300;

function resolvePython(): string {
  return process.env.PYTHON_PATH || (process.platform === 'win32' ? 'py' : 'python3');
}

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
    const pythonCommand = resolvePython();
    const isPyLauncher = pythonCommand.toLowerCase() === 'py' || pythonCommand.toLowerCase().endsWith('\\py.exe');
    const spawnArgs = isPyLauncher
      ? ['-3', scriptPath, '--question', question, '--ifc', ifcPath]
      : [scriptPath, '--question', question, '--ifc', ifcPath];

    const child = spawn(pythonCommand, spawnArgs, {
      cwd: projectRoot,
      env: {
        ...process.env,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });

    return new Promise<NextResponse>((resolve) => {
      child.on('close', (code) => {
        if (code !== 0) {
          resolve(NextResponse.json({ error: `Erreur Python : ${stderr}` }, { status: 500 }));
          return;
        }

        const marker = 'RESULTAT_FINAL:';
        const idx = stdout.lastIndexOf(marker);
        const response = idx !== -1 ? stdout.slice(idx + marker.length).trim() : stdout.trim();
        resolve(NextResponse.json({ response }));
      });

      child.on('error', (err) => {
        resolve(NextResponse.json({ error: `Lancement impossible : ${err.message}` }, { status: 500 }));
      });
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
