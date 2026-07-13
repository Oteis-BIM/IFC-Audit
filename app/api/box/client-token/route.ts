import { NextResponse } from 'next/server';
import { getBoxAuthFromCookies, setBoxTokenCookies } from '@/lib/box';

// Fournit un access token Box valide au navigateur pour les uploads volumineux :
// ceux-ci doivent partir directement du client vers Box, car les fonctions
// serverless Vercel plafonnent la taille du corps de requête bien en-deçà
// de la taille d'une maquette IFC.
export async function GET() {
  const auth = await getBoxAuthFromCookies();
  if (!auth) {
    return NextResponse.json({ error: 'Non authentifié sur Box.' }, { status: 401 });
  }

  const response = NextResponse.json({ accessToken: auth.accessToken });
  if (auth.refreshedTokens) setBoxTokenCookies(response, auth.refreshedTokens);
  return response;
}
