/**
 * Ponto de dado no Analytics Engine, um por sessão de visitante.
 *
 * O GraphQL da Cloudflare, no plano Free, só entrega o PAÍS de quem visita —
 * cidade, região e operadora são campos pagos. Mas o próprio Worker recebe
 * tudo isso de graça em `request.cf`, e o Analytics Engine guarda com consulta
 * por SQL. O dataset é um só para todos os sites *.vynstream.com, indexado
 * pelo host; nenhum IP e nenhum identificador de pessoa entram nele.
 *
 * Colunas: blob1 host, blob2 país, blob3 região, blob4 cidade, blob5
 * datacenter da borda, blob6 operadora (ASN), blob7 aparelho; double1 = 1.
 */
export function anotarVisita(request: Request, env: { VISITAS?: AnalyticsEngineDataset }): void {
  try {
    const cf = (request.cf ?? {}) as Record<string, unknown>;
    const host = new URL(request.url).hostname;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    env.VISITAS?.writeDataPoint({
      indexes: [host],
      blobs: [host, s(cf.country), s(cf.region), s(cf.city), s(cf.colo), s(cf.asOrganization),
              aparelho(request.headers.get('user-agent') ?? '')],
      doubles: [1],
    });
  } catch {
    // métrica é enfeite: nunca pode derrubar a visita
  }
}

function aparelho(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return 'outro';
}
