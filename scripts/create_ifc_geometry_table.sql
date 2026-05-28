-- Migration : création de la table ifc_geometry pour stocker les données géométriques IFC
-- À exécuter dans l'éditeur SQL de Supabase (https://supabase.com/dashboard)

CREATE TABLE IF NOT EXISTS public.ifc_geometry (
    id                    bigserial PRIMARY KEY,
    project_name          text NOT NULL,
    file_name             text NOT NULL,
    schema                text,
    extracted_at          timestamptz NOT NULL DEFAULT now(),
    total_elements        integer DEFAULT 0,
    elements_with_geometry integer DEFAULT 0,
    stats_by_type         jsonb DEFAULT '{}',
    geometry_data         jsonb NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ifc_geometry_project_file_unique UNIQUE (project_name, file_name)
);

-- Index pour les recherches fréquentes
CREATE INDEX IF NOT EXISTS idx_ifc_geometry_project ON public.ifc_geometry (project_name);
CREATE INDEX IF NOT EXISTS idx_ifc_geometry_file    ON public.ifc_geometry (file_name);
CREATE INDEX IF NOT EXISTS idx_ifc_geometry_data    ON public.ifc_geometry USING gin (geometry_data);

-- Mise à jour automatique du champ updated_at
CREATE OR REPLACE FUNCTION update_ifc_geometry_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ifc_geometry_updated_at ON public.ifc_geometry;
CREATE TRIGGER trg_ifc_geometry_updated_at
    BEFORE UPDATE ON public.ifc_geometry
    FOR EACH ROW EXECUTE FUNCTION update_ifc_geometry_updated_at();

-- Activer RLS (Row Level Security) si nécessaire
-- ALTER TABLE public.ifc_geometry ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "anon_read" ON public.ifc_geometry FOR SELECT USING (true);
-- CREATE POLICY "anon_insert" ON public.ifc_geometry FOR INSERT WITH CHECK (true);
-- CREATE POLICY "anon_update" ON public.ifc_geometry FOR UPDATE USING (true);
