"use client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import * as OBC from "@thatopen/components";

interface IfcViewerProps {
  fileUrl: string;
  onClose: () => void;
}

export default function IfcViewer({ fileUrl, onClose }: IfcViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const componentsRef = useRef<OBC.Components | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;

    // Init components
    const components = new OBC.Components();
    componentsRef.current = components;

    // World (scene + renderer + camera)
    const worlds = components.get(OBC.Worlds);
    const world = worlds.create<
      OBC.SimpleScene,
      OBC.SimpleCamera,
      OBC.SimpleRenderer
    >();

    world.scene = new OBC.SimpleScene(components);
    world.renderer = new OBC.SimpleRenderer(components, container);
    world.camera = new OBC.SimpleCamera(components);

    components.init();

    world.camera.controls.setLookAt(12, 6, 8, 0, 0, -10);

    world.scene.setup();

    // Grille
    const grids = components.get(OBC.Grids);
    grids.create(world);

    // Loader IFC
    const ifcLoader = components.get(OBC.IfcLoader);

    async function loadIfc() {
      await ifcLoader.setup();
      const response = await fetch(fileUrl);
      const buffer = await response.arrayBuffer();
      const data = new Uint8Array(buffer);
      const model = await ifcLoader.load(data);
      world.scene.three.add(model);

      // Centrer la caméra sur le modèle
      const bbox = new THREE.Box3().setFromObject(model);
      const center = bbox.getCenter(new THREE.Vector3());
      const size = bbox.getSize(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z);
      world.camera.controls.setLookAt(
        center.x + maxDim,
        center.y + maxDim * 0.8,
        center.z + maxDim,
        center.x,
        center.y,
        center.z,
        true
      );
    }

    loadIfc().catch(console.error);

    return () => {
      components.dispose();
    };
  }, [fileUrl]);

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 bg-blue-600 rounded flex items-center justify-center text-white text-[10px] font-bold">IFC</div>
            <h3 className="text-lg font-bold text-slate-800">Visionneuse IFC 3D</h3>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>🖱️ Clic gauche : orbiter</span>
            <span>🖱️ Clic droit : déplacer</span>
            <span>🖱️ Molette : zoom</span>
            <button
              onClick={onClose}
              className="ml-4 text-slate-400 hover:text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg px-3 py-1.5 font-semibold transition-colors"
            >
              ✕ Fermer
            </button>
          </div>
        </div>
        {/* Viewer */}
        <div ref={containerRef} className="flex-1 w-full bg-slate-900 relative">
          <div className="absolute inset-0 flex items-center justify-center text-slate-500 text-sm animate-pulse pointer-events-none" id="loading-hint">
            Chargement du modèle IFC...
          </div>
        </div>
      </div>
    </div>
  );
}
