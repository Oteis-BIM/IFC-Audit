import { NextRequest, NextResponse } from 'next/server';
import { spawn, execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

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

    // Résolution robuste de Python sur Windows :
    // 1. Variable d'env PYTHON_PATH (priorité absolue)
    // 2. `where python` / `which python3` selon la plateforme
    // 3. Fallbacks connus
    function resolvePython(): string {
      if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
        return process.env.PYTHON_PATH;
      }
      if (process.platform === 'win32') {
        try {
          const result = execSync('where python', { encoding: 'utf-8', timeout: 3000 }).trim();
          const lines = result.split('\n').map(l => l.trim()).filter(l => l.endsWith('.exe') && !l.includes('WindowsApps\\python.exe'));
          if (lines.length > 0) return lines[0];
          // Accepter aussi WindowsApps si c'est le seul disponible
          const allLines = result.split('\n').map(l => l.trim()).filter(Boolean);
          if (allLines.length > 0) return allLines[0];
        } catch { /* ignore */ }
        // Fallback : chemin exact détecté sur cette machine
        const knownPaths = [
          process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\\python.exe',
          process.env.LOCALAPPDATA + '\\Microsoft\\WindowsApps\\python.exe',
          'C:\\Python313\\python.exe',
          'C:\\Python312\\python.exe',
          'C:\\Python311\\python.exe',
          'C:\\Python310\\python.exe',
        ];
        for (const p of knownPaths) {
          if (p && fs.existsSync(p)) return p;
        }
        return 'python';
      }
      return 'python3';
    }

    const pythonCommand = resolvePython();

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