/**
 * Funil: um evento por gesto, para saber o que as pessoas FAZEM aqui.
 *
 * A borda sabe dizer quantas vezes a home foi baixada e o banco sabe quantos
 * sorteios nasceram. Entre uma coisa e outra — rolar até o formulário, trocar
 * de aba, começar a digitar a lista, apertar o botão — não havia um único
 * número. Em 12–18/09 foram 573 sessões e UM sorteio criado, e nada no sistema
 * sabia dizer onde as outras 572 pararam. É esse buraco que isto fecha.
 *
 * Mesmo desenho do funil do onde-morar: lista fechada de eventos, um freio por
 * IP, teto de linhas por dia e falha em silêncio. Nada identifica ninguém — no
 * corpo vai o nome do evento e mais nada.
 */

/** Os eventos que o navegador pode contar. Lista fechada de propósito: o que
 * chega de fora é uma string que vai para dentro do banco, e o jeito de isso
 * nunca virar problema é não existir caminho para uma string arbitrária. */
const EVENTOS = new Set([
  'home_pronta',        // a home apareceu e responde
  'saiu_carregando',    // fechou a aba ANTES disso — a desistência, medida
  'tocou_criar',        // tocou no "Fazer um sorteio" do alto da página
  'trocou_para_lista',  // abriu a aba de sortear uma lista
  'trocou_para_loteria',// voltou para a aba de jogos de loteria
  'mexeu_loteria',      // mexeu na modalidade, na quantidade ou nas dezenas
  'focou_lista',        // pôs o cursor na caixa de participantes
  'usou_exemplo',       // preencheu com a lista de exemplo
  'submeteu',           // apertou o botão de criar
  'criou',              // o sorteio nasceu (201 de volta)
  'erro_envio',         // o botão foi apertado e o servidor recusou
  'abriu_sorteio',      // abriu uma página /s/<código>
  'copiou_link',        // copiou o link do sorteio para mandar a alguém
  'verificou',          // rodou uma verificação
]);

/** Quantas linhas por dia UTC o funil pode gravar, somando todos os eventos.
 * O plano gratuito do D1 dá 100 mil escritas por dia e os contadores de visita
 * dependem delas; 5.000 é dezenas de vezes qualquer dia real deste site. O que
 * estoura um teto destes não é gente, é laço. */
const TETO_DIA = 5000;

export interface FunilEnv {
  DB: D1Database;
  LIMITE_FUNIL?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

export function eventoValido(evento: unknown): evento is string {
  return typeof evento === 'string' && EVENTOS.has(evento);
}

/** Grava um evento. Falha FECHADO — em dúvida, não grava: a cota de escrita
 * que ele gastaria é a mesma de que o contador de visitas precisa. E nunca
 * lança: quem chamou já recebeu 204 e não está esperando nada. */
export async function anotarFunil(env: FunilEnv, evento: string, quem: string): Promise<void> {
  try {
    if (!env.LIMITE_FUNIL) return;
    const { success } = await env.LIMITE_FUNIL.limit({ key: `funil:${quem}` });
    if (!success) return;
    const dia = new Date().toISOString().slice(0, 10);
    const linha = await env.DB.prepare('SELECT SUM(n) AS total FROM funil WHERE dia = ?')
      .bind(dia)
      .first<{ total: number | null }>();
    if (Number(linha?.total ?? 0) >= TETO_DIA) return;
    await env.DB.prepare(
      `INSERT INTO funil (dia, evento, n) VALUES (?, ?, 1)
       ON CONFLICT(dia, evento) DO UPDATE SET n = n + 1`,
    )
      .bind(dia, evento)
      .run();
  } catch {
    // o funil é enfeite, como o contador: some em silêncio
  }
}
