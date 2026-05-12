"use client";
import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { Eye, EyeOff, X, Loader2 } from "lucide-react";

export interface FileEntry {
  fileId: string;
  fileName: string;
}

interface IfcViewerProps {
  files: FileEntry[];
  onClose: () => void;
  onRemoveFile: (fileId: string) => void;
}

// Palette de teintes HSL par modele (modele 0 = couleurs natives IFC)
const PALETTE: Array<{ h: number; s: number } | null> = [
  null,
  { h: 0.06, s: 0.9 },
  { h: 0.35, s: 0.8 },
  { h: 0.75, s: 0.8 },
  { h: 0.55, s: 0.8 },
  { h: 0.93, s: 0.8 },
];
const BADGE_COLORS = ["#3b82f6","#f97316","#22c55e","#a855f7","#06b6d4","#ec4899"];

type ModelState = {
  fileId: string;
  fileName: string;
  status: "loading" | "loaded" | "error";
  error: string | null;
  visible: boolean;
  meshCount: number;
};

export default function IfcViewer({ files, onClose, onRemoveFile }: IfcViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const groupsRef = useRef<Map<string, THREE.Group>>(new Map());
  const loadedIdsRef = useRef<Set<string>>(new Set());
  const orbitRef = useRef({ phi: Math.PI / 3, theta: Math.PI / 4, radius: 100 });
  const targetRef = useRef(new THREE.Vector3());
  const animIdRef = useRef<number>(0);
  const [models, setModels] = useState<ModelState[]>([]);

  // Instance IfcAPI partagée + mutex pour sérialiser les chargements
  // (web-ifc ne supporte pas plusieurs Init() simultanés)
  const ifcApiRef = useRef<import("web-ifc").IfcAPI | null>(null);
  const loadQueueRef = useRef<Array<() => Promise<void>>>([]);
  const loadingRef = useRef(false);

  async function runQueue() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    while (loadQueueRef.current.length > 0) {
      const task = loadQueueRef.current.shift()!;
      await task();
    }
    loadingRef.current = false;
  }

  async function getIfcApi(): Promise<import("web-ifc").IfcAPI> {
    if (ifcApiRef.current) return ifcApiRef.current;
    const { IfcAPI } = await import("web-ifc");
    const api = new IfcAPI();
    api.SetWasmPath("/", true);
    await api.Init();
    ifcApiRef.current = api;
    return api;
  }

  // ─── Setup Three.js (une seule fois) ───────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x1a1a2e);
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1);
    dir.position.set(100, 200, 100);
    scene.add(dir);
    scene.add(new THREE.GridHelper(500, 60, 0x444466, 0x333355));

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 50000);
    cameraRef.current = camera;

    function updateCamera() {
      const { phi, theta, radius } = orbitRef.current;
      const t = targetRef.current;
      camera.position.set(
        t.x + radius * Math.sin(phi) * Math.cos(theta),
        t.y + radius * Math.cos(phi),
        t.z + radius * Math.sin(phi) * Math.sin(theta)
      );
      camera.lookAt(t);
    }
    updateCamera();

    let isLeft = false, isRight = false, lastX = 0, lastY = 0;
    const cv = renderer.domElement;
    cv.addEventListener("pointerdown", e => {
      if (e.button === 0) isLeft = true;
      if (e.button === 2) isRight = true;
      lastX = e.clientX; lastY = e.clientY;
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener("pointerup", () => { isLeft = false; isRight = false; });
    cv.addEventListener("pointermove", e => {
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      const o = orbitRef.current;
      if (isLeft) {
        o.theta -= dx * 0.01;
        o.phi = Math.max(0.05, Math.min(Math.PI - 0.05, o.phi - dy * 0.01));
        updateCamera();
      }
      if (isRight) {
        const fwd = new THREE.Vector3().subVectors(targetRef.current, camera.position).normalize();
        const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0,1,0)).normalize();
        targetRef.current.addScaledVector(right, -dx * o.radius * 0.001);
        targetRef.current.y += dy * o.radius * 0.001;
        updateCamera();
      }
    });
    cv.addEventListener("wheel", e => {
      orbitRef.current.radius = Math.max(0.5, orbitRef.current.radius * (1 + e.deltaY * 0.001));
      updateCamera();
    });
    cv.addEventListener("contextmenu", e => e.preventDefault());

    const obs = new ResizeObserver(() => {
      renderer.setSize(container.clientWidth, container.clientHeight);
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
    });
    obs.observe(container);

    function animate() {
      animIdRef.current = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    }
    animate();

    return () => {
      cancelAnimationFrame(animIdRef.current);
      obs.disconnect();
      renderer.dispose();
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement);
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  // ─── Recentrer la caméra sur tous les modèles ─────────────────────────────
  const recenter = useCallback(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    const box = new THREE.Box3();
    groupsRef.current.forEach(g => { if (g.visible) box.expandByObject(g); });
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    targetRef.current.copy(center);
    orbitRef.current.radius = Math.max(size.x, size.y, size.z) * 1.8;
    orbitRef.current.phi = Math.PI / 3;
    orbitRef.current.theta = Math.PI / 4;
    const { phi, theta, radius } = orbitRef.current;
    const t = targetRef.current;
    camera.position.set(
      t.x + radius * Math.sin(phi) * Math.cos(theta),
      t.y + radius * Math.cos(phi),
      t.z + radius * Math.sin(phi) * Math.sin(theta)
    );
    camera.lookAt(t);
  }, []);

  // ─── Charger un modèle IFC (sérialisé via queue) ─────────────────────────
  const loadModel = useCallback((entry: FileEntry, modelIndex: number) => {
    const { fileId, fileName } = entry;
    if (loadedIdsRef.current.has(fileId)) return;
    loadedIdsRef.current.add(fileId);

    setModels(prev => [...prev, { fileId, fileName, status: "loading", error: null, visible: true, meshCount: 0 }]);

    const task = async () => {
      try {
        const res = await fetch(`/api/box/file?fileId=${fileId}`);
        if (!res.ok) throw new Error(`Proxy ${res.status} : ${await res.text()}`);
        const buffer = await res.arrayBuffer();

        // Instance WASM partagée — initialisée une seule fois
        const ifcApi = await getIfcApi();
        const modelID = ifcApi.OpenModel(new Uint8Array(buffer), { COORDINATE_TO_ORIGIN: true });

        const group = new THREE.Group();
        group.name = fileId;
        const palette = PALETTE[modelIndex % PALETTE.length];
        let meshCount = 0;

        ifcApi.StreamAllMeshes(modelID, (mesh) => {
          const geoms = mesh.geometries;
          for (let i = 0; i < geoms.size(); i++) {
            const placed = geoms.get(i);
            const geomData = ifcApi.GetGeometry(modelID, placed.geometryExpressID);
            const verts = ifcApi.GetVertexArray(geomData.GetVertexData(), geomData.GetVertexDataSize());
            const idxs = ifcApi.GetIndexArray(geomData.GetIndexData(), geomData.GetIndexDataSize());
            geomData.delete();

            const n = verts.length / 6;
            const pos = new Float32Array(n * 3);
            const nor = new Float32Array(n * 3);
            for (let j = 0; j < n; j++) {
              pos[j*3]=verts[j*6]; pos[j*3+1]=verts[j*6+1]; pos[j*3+2]=verts[j*6+2];
              nor[j*3]=verts[j*6+3]; nor[j*3+1]=verts[j*6+4]; nor[j*3+2]=verts[j*6+5];
            }

            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
            geo.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
            geo.setIndex(new THREE.BufferAttribute(idxs, 1));

            const col = placed.color;
            const color = palette
              ? new THREE.Color().setHSL(palette.h, palette.s, 0.55)
              : new THREE.Color(col.x, col.y, col.z);

            const mat = new THREE.MeshLambertMaterial({
              color,
              transparent: col.w < 1,
              opacity: col.w,
              side: THREE.DoubleSide,
            });

            const m = new THREE.Mesh(geo, mat);
            m.applyMatrix4(new THREE.Matrix4().fromArray(Array.from(placed.flatTransformation)));
            group.add(m);
            meshCount++;
          }
        });

        ifcApi.CloseModel(modelID);
        if (group.children.length === 0) throw new Error("Aucune géométrie trouvée dans ce fichier.");

        sceneRef.current!.add(group);
        groupsRef.current.set(fileId, group);
        setModels(prev => prev.map(m => m.fileId === fileId ? { ...m, status: "loaded", meshCount } : m));
        setTimeout(recenter, 50);

      } catch (e: unknown) {
        loadedIdsRef.current.delete(fileId);
        setModels(prev => prev.map(m => m.fileId === fileId
          ? { ...m, status: "error", error: e instanceof Error ? e.message : String(e) }
          : m
        ));
      }
    };

    loadQueueRef.current.push(task);
    runQueue();
  }, [recenter]); // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Réagir aux changements de la liste de fichiers ───────────────────────
  useEffect(() => {
    files.forEach((entry, index) => {
      if (!loadedIdsRef.current.has(entry.fileId)) loadModel(entry, index);
    });
    const fileIds = new Set(files.map(f => f.fileId));
    groupsRef.current.forEach((group, id) => {
      if (!fileIds.has(id)) {
        sceneRef.current?.remove(group);
        groupsRef.current.delete(id);
        loadedIdsRef.current.delete(id);
        setModels(prev => prev.filter(m => m.fileId !== id));
      }
    });
  }, [files, loadModel]);

  function toggleVisibility(fileId: string) {
    const group = groupsRef.current.get(fileId);
    if (group) group.visible = !group.visible;
    setModels(prev => prev.map(m => m.fileId === fileId ? { ...m, visible: !m.visible } : m));
  }

  const anyLoading = models.some(m => m.status === "loading");

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-7xl h-[90vh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-slate-200 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 bg-blue-600 rounded flex items-center justify-center text-white text-[10px] font-bold">IFC</div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">Visionneuse IFC 3D — Fédération</h3>
              <p className="text-xs text-slate-400">{models.filter(m => m.status === "loaded").length} modèle(s) chargé(s)</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="hidden sm:inline">Gauche : orbiter</span>
            <span className="hidden sm:inline">Droit : déplacer</span>
            <span className="hidden sm:inline">Molette : zoom</span>
            <button onClick={recenter} className="bg-slate-100 hover:bg-slate-200 text-slate-600 px-3 py-1.5 rounded-lg font-semibold transition-colors">Recentrer</button>
            <button onClick={onClose} className="bg-slate-100 hover:bg-slate-200 text-slate-600 px-3 py-1.5 rounded-lg font-semibold transition-colors">Fermer</button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Panneau latéral */}
          <div className="w-60 border-r border-slate-200 bg-slate-50 flex flex-col shrink-0">
            <div className="px-4 py-2.5 border-b border-slate-200">
              <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wide">Modèles ({models.length})</p>
            </div>
            <div className="flex-1 overflow-y-auto p-2.5 space-y-2">
              {models.length === 0 && (
                <p className="text-xs text-slate-400 italic text-center mt-6">Aucun modèle</p>
              )}
              {models.map((model, idx) => (
                <div key={model.fileId} className="bg-white rounded-xl border border-slate-200 p-3 shadow-sm">
                  <div className="flex items-start gap-2 mb-2">
                    <div className="w-3 h-3 rounded-full mt-0.5 shrink-0" style={{ background: BADGE_COLORS[idx % BADGE_COLORS.length] }} />
                    <p className="text-xs font-semibold text-slate-700 flex-1 break-words leading-tight" title={model.fileName}>{model.fileName}</p>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      {model.status === "loading" && (
                        <span className="flex items-center gap-1 text-[10px] text-blue-500">
                          <Loader2 className="h-3 w-3 animate-spin" /> Chargement...
                        </span>
                      )}
                      {model.status === "loaded" && (
                        <span className="text-[10px] text-emerald-600 font-medium">✓ {model.meshCount} mesh</span>
                      )}
                      {model.status === "error" && (
                        <span className="text-[10px] text-red-500" title={model.error ?? ""}>⚠ Erreur</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {model.status === "loaded" && (
                        <button onClick={() => toggleVisibility(model.fileId)} className="text-slate-400 hover:text-slate-700 transition-colors" title={model.visible ? "Masquer" : "Afficher"}>
                          {model.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                        </button>
                      )}
                      <button onClick={() => onRemoveFile(model.fileId)} className="text-slate-300 hover:text-red-500 transition-colors" title="Retirer de la visionneuse">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {model.status === "error" && (
                    <p className="text-[9px] text-red-400 mt-1.5 font-mono break-all leading-tight">{model.error}</p>
                  )}
                </div>
              ))}
            </div>
            <div className="p-3 border-t border-slate-200 text-[10px] text-slate-400 text-center leading-snug">
              Cliquez sur 👁 dans le tableau pour ajouter un modèle
            </div>
          </div>

          {/* Canvas 3D */}
          <div className="relative flex-1 bg-[#1a1a2e]">
            <div ref={containerRef} className="w-full h-full" />
            {anyLoading && (
              <div className="absolute bottom-4 right-4 flex items-center gap-2 bg-slate-900/80 text-white text-xs px-3 py-2 rounded-lg pointer-events-none">
                <Loader2 className="h-4 w-4 animate-spin text-blue-400" />
                Chargement en cours...
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}