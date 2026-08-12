/**
 * Ponto de entrada do bundle que o navegador carrega.
 *
 * Existe para o verificador ter protocolo e loterias num arquivo só. Empacotar
 * lottery.ts separadamente duplicaria o Drbg e o SHA-256 dentro dele — duas
 * cópias do mesmo código sendo servidas, e a possibilidade de uma divergir da
 * outra num build futuro.
 *
 * Gerado por `npm run build:protocol` em ../../web/protocol.js. Não editar
 * o arquivo de saída à mão.
 */

export * from './protocol.ts';
export {
  LOTTERIES,
  MESES,
  MAX_GAMES,
  generate as generateLottery,
  lotteryCommitHash,
  pickDistinct,
  validate as validateLottery,
  type Game,
  type LotterySpec,
} from './lottery.ts';
