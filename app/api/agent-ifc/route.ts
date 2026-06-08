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
    // Les alias Windows Store (WindowsApps\python.exe) existent sur le disque
    // mais ne peuvent pas être lancés via spawn() — ils nécessitent une interaction UI.
    // Priorité : PYTHON_PATH env > py launcher > chemins réels Python connus > python
    function resolvePython(): string {
      if (process.env.PYTHON_PATH && fs.existsSync(process.env.PYTHON_PATH)) {
        return process.env.PYTHON_PATH;
      }
      if (process.platform === 'win32') {
        // 1. py.exe launcher (toujours fonctionnel, pas affecté par WindowsApps)
        const pyLauncher = 'C:\\Users\\' + (process.env.USERNAME ?? '') + '\\AppData\\Local\\Programs\\Python\\Launcher\\py.exe';
        if (fs.existsSync(pyLauncher)) return pyLauncher;

        // 2. Chemins réels Python (non-WindowsApps) — via `py -3 -c "import sys; print(sys.executable)"`
        try {
          const real = execSync('py -3 -c "import sys; print(sys.executable)"', { encoding: 'utf-8', timeout: 5000 }).trim();
          if (real && fs.existsSync(real) && !real.includes('WindowsApps')) return real;
        } catch { /* ignore */ }

        // 3. `where python` en filtrant les stubs WindowsApps
        try {
          const result = execSync('where python', { encoding: 'utf-8', timeout: 3000 }).trim();
          const lines = result.split('\n').map(l => l.trim()).filter(l =>
            l.endsWith('.exe') && !l.includes('WindowsApps')
          );
          if (lines.length > 0) return lines[0];
        } catch { /* ignore */ }

        // 4. Chemins d'installation standard Python
        const base = process.env.LOCALAPPDATA ?? 'C:\\Users\\' + (process.env.USERNAME ?? '') + '\\AppData\\Local';
        const knownPaths = [
          base + '\\Programs\\Python\\Python313\\python.exe',
          base + '\\Programs\\Python\\Python312\\python.exe',
          base + '\\Programs\\Python\\Python311\\python.exe',
          base + '\\Programs\\Python\\Python310\\python.exe',
          'C:\\Python313\\python.exe',
          'C:\\Python312\\python.exe',
        ];
        for (const p of knownPaths) {
          if (p && fs.existsSync(p)) return p;
        }
        return 'python';
      }
      return 'python3';
    }

    const pythonCommand = resolvePython();
    // Si c'est le launcher py.exe, on lui passe -3 en premier argument
    const isPyLauncher = pythonCommand.toLowerCase().endsWith('\\py.exe');
    const spawnArgs = isPyLauncher
      ? ['-3', scriptPath, '--question', question, '--ifc', ifcPath]
      : [scriptPath, '--question', question, '--ifc', ifcPath];

    const childEnv = {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    };

    // On lance le script Python
    const child = spawn(pythonCommand, spawnArgs, {
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