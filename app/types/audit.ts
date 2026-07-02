export type Audit = {
  id: number;
  created_at: string;
  project_name: string;
  status: string;
  details: string | null;
};

export type SelectedFile = {
  file: File;
  status: 'OK' | 'WARNING' | 'CRITICAL';
  discipline: string;
  uploading: boolean;
  done: boolean;
  error: string | null;
  progress: number;
};

export type CellStatus = 'ok' | 'warning' | 'error' | 'na' | 'unclear' | '';

export type MappingRule = 'Auto-detect' | 'Manual Mapping' | 'Excluded';

export type MappingRow = {
  ifcType: string;
  category: string;
  rule: MappingRule;
  aiStatus: 'Verified' | 'Incoh?rence Nommage' | 'Warning' | '';
};

export type ExcelMappingRow = {
  composant: string;
  nomDuType: string;
  type: string;
  categorieTnd: string;
  selectedTnd: string;
  validation?: string;
};

export type PropsSheetInfo = {
  sheetName: string;
  categoryName?: string;
  categoryNameNormalised?: string;
  headers: string[];
  preview: string[][];
};

export type PropsSheetMapping = { colCategorie: string; colsProprietes: string[] };

export type PropsCategoryData = {
  name: string;
  nameNormalised: string;
  ifcClasses?: string[];
  properties: string[];
};

export type PropCheckResult = {
  nomDuType: string;
  ifcName: string;
  instanceCount: number;
  props: Record<string, string | null>;
};

export type ParametresSavedState = {
  mappingRows: MappingRow[];
  excelRows: ExcelMappingRow[];
  categoryProps: Record<string, string[]>;
  propsCategories: PropsCategoryData[] | null;
};

export type MaquetteCardData = {
  name: string;
  discipline: string;
  date: string;
  status: 'OK' | 'WARNING' | 'CRITICAL';
  globalScore: number;
  controls: { label: string; status: 'ok' | 'error' | 'warning'; detail: string }[];
};
