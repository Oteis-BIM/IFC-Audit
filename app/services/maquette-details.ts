export function parseMaquetteDetails(details: string | null): { fileId: string; discipline: string; downloadUrl: string } {
  if (!details?.startsWith('box:')) return { fileId: '', discipline: '', downloadUrl: '' };
  const parts = details.split(':');
  const fileId = parts[1] ?? '';
  const third = parts[2] ?? '';
  if (third === '' || third === 'https' || third === 'http') {
    return { fileId, discipline: '', downloadUrl: parts.slice(2).join(':') };
  }
  return { fileId, discipline: third, downloadUrl: parts.slice(3).join(':') };
}
