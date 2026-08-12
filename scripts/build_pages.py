#!/usr/bin/env python3
"""
Gera as páginas estáticas de aterrissagem.

    python3 scripts/build_pages.py

Produz dois tipos de página em web/:

  /<lang>/            — o app inteiro, com idioma pré-definido e meta traduzida
  /pt/<modalidade>    — conteúdo sobre cada loteria da Caixa

Por que estático e não renderizado por JS: o Googlebot executa JavaScript, mas
enfileira essas páginas para um segundo passe que pode demorar dias. Uma página
que já chega pronta no HTML é indexada no primeiro rastreamento. E como o
conteúdo aqui não muda (regras e probabilidades são fixas), não há motivo para
calcular nada em runtime.

As probabilidades são calculadas, não copiadas: `python3 -c` com math.comb
reproduz cada número desta tabela, e eles batem com os valores oficiais.
"""

from __future__ import annotations

import json
import os
import re
from math import comb

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
WEB = os.path.join(ROOT, "web")
BASE = "https://sorteio.vynstream.com"

# Idiomas com página própria. O inglês fica na raiz (é o x-default), então não
# ganha /en/ — teria conteúdo idêntico a / e viraria duplicata.
LANGS = {
    "pt": ("Português", "ltr", "pt_BR"),
    "es": ("Español", "ltr", "es_ES"),
    "fr": ("Français", "ltr", "fr_FR"),
    "zh": ("中文", "ltr", "zh_CN"),
    "hi": ("हिन्दी", "ltr", "hi_IN"),
    "ar": ("العربية", "rtl", "ar_EG"),
    "ru": ("Русский", "ltr", "ru_RU"),
}

LANG_META = {
    "pt": ("Sorteio Quântico — sorteador online com prova pública",
           "Sorteador online grátis e gerador de jogos das loterias da Caixa, com números vindos de medição quântica em hardware real da IBM e prova que qualquer um confere."),
    "es": ("Sorteo Cuántico — sorteador online con prueba pública",
           "Sorteador online gratis con números de medición cuántica en hardware real de IBM y una prueba que cualquiera puede comprobar."),
    "fr": ("Tirage Quantique — tirage au sort en ligne vérifiable",
           "Tirage au sort en ligne gratuit, décidé par une mesure quantique sur du matériel IBM réel, avec une preuve vérifiable par tous."),
    "zh": ("量子抽奖 — 可公开验证的在线抽奖工具",
           "免费在线抽奖工具，号码来自 IBM 真实量子硬件的测量，并附带任何人都能验证的证明。"),
    "hi": ("क्वांटम ड्रॉ — सार्वजनिक प्रमाण वाला ऑनलाइन ड्रॉ",
           "मुफ़्त ऑनलाइन लकी ड्रॉ, जिसके नंबर IBM के असली क्वांटम हार्डवेयर पर मापन से आते हैं, ऐसे प्रमाण के साथ जिसे कोई भी जाँच सकता है।"),
    "ar": ("السحب الكمّي — أداة سحب على الإنترنت ببرهان علني",
           "أداة سحب مجانية على الإنترنت، بأرقام من قياس كمّي على عتاد IBM حقيقي، مع برهان يستطيع أي شخص التحقق منه."),
    "ru": ("Квантовый розыгрыш — онлайн-рандомайзер с публичным доказательством",
           "Бесплатный онлайн-рандомайзер: номера получены квантовым измерением на реальном оборудовании IBM, с доказательством, которое может проверить каждый."),
}

# ------------------------------------------------------------------ loterias

def odds_table(lo: int, hi: int, drawn: int, lo_p: int, hi_p: int, extra: int = 1):
    """Chance do prêmio máximo para cada quantidade marcada."""
    total = comb(hi - lo + 1, drawn)
    rows = []
    for picks in range(lo_p, hi_p + 1):
        chance = total * extra // comb(picks, drawn)
        rows.append((picks, chance))
    return rows


LOTTERIES = [
    {
        "slug": "mega-sena", "id": "megasena", "name": "Mega-Sena",
        "rule": "Marque de 6 a 20 números entre os 60 do volante. São sorteadas 6 dezenas.",
        "odds": odds_table(1, 60, 6, 6, 20),
        "min_label": "6 números", "extra": None,
        "note": "É a loteria de maior prêmio do país, e também a de menor chance entre as tradicionais.",
    },
    {
        "slug": "lotofacil", "id": "lotofacil", "name": "Lotofácil",
        "rule": "Marque de 15 a 20 números entre os 25 do volante. São sorteadas 15 dezenas.",
        "odds": odds_table(1, 25, 15, 15, 20),
        "min_label": "15 números", "extra": None,
        "note": "É a de melhor chance entre todas: acertar 11, 12, 13 ou 14 dezenas também paga.",
    },
    {
        "slug": "quina", "id": "quina", "name": "Quina",
        "rule": "Marque de 5 a 15 números entre os 80 do volante. São sorteadas 5 dezenas.",
        "odds": odds_table(1, 80, 5, 5, 15),
        "min_label": "5 números", "extra": None,
        "note": "Acertar 2, 3 ou 4 dezenas também paga, o que torna o prêmio secundário frequente.",
    },
    {
        "slug": "lotomania", "id": "lotomania", "name": "Lotomania",
        "rule": "Marque 50 números entre 00 e 99 — metade de todos. São sorteadas 20 dezenas.",
        "odds": [(50, comb(100, 20) // comb(50, 20))],
        "min_label": "50 números", "extra": None,
        "note": "É a única em que não acertar nenhuma dezena também premia.",
    },
    {
        "slug": "dupla-sena", "id": "duplasena", "name": "Dupla Sena",
        "rule": "Marque de 6 a 15 números entre os 50 do volante. Há dois sorteios por concurso.",
        "odds": odds_table(1, 50, 6, 6, 15),
        "min_label": "6 números", "extra": None,
        "note": "Como são dois sorteios no mesmo bilhete, a chance efetiva por concurso é melhor que a da tabela.",
    },
    {
        "slug": "timemania", "id": "timemania", "name": "Timemania",
        "rule": "Marque 10 números entre os 80 do volante e escolha um Time do Coração. São sorteadas 7 dezenas.",
        "odds": [(10, comb(80, 7) // comb(10, 7))],
        "min_label": "10 números", "extra": "O Time do Coração é escolha pessoal — o gerador não sorteia por você.",
        "note": "Repare que se aposta 10 dezenas mas só 7 são sorteadas; é a modalidade que mais confunde.",
    },
    {
        "slug": "dia-de-sorte", "id": "diadesorte", "name": "Dia de Sorte",
        "rule": "Marque de 7 a 15 números entre os 31 do volante e um Mês da Sorte. São sorteadas 7 dezenas e um mês.",
        "odds": [(p, comb(31, 7) * 12 // comb(p, 7)) for p in range(7, 16)],
        "min_label": "7 números + mês", "extra": "O Mês da Sorte entra no sorteio junto com as dezenas.",
        "note": "Os números vão só até 31 porque representam dias do mês.",
    },
    {
        "slug": "super-sete", "id": "supersete", "name": "Super Sete",
        "rule": "São 7 colunas. Em cada uma, marque de 1 a 3 algarismos de 0 a 9.",
        "odds": [(1, 10 ** 7), (2, 10 ** 7 // 2 ** 7), (3, 10 ** 7 // 3 ** 7)],
        "min_label": "1 algarismo por coluna", "extra": None,
        "note": "Cada coluna é um sorteio independente, com seu próprio globo de 10 bolas.",
        "odds_label": "algarismos por coluna",
    },
    {
        "slug": "mais-milionaria", "id": "maismilionaria", "name": "+Milionária",
        "rule": "Marque de 6 a 12 números entre os 50 e de 2 a 6 trevos entre os 6. São sorteadas 6 dezenas e 2 trevos.",
        "odds": [(p, comb(50, 6) * comb(6, 2) // comb(p, 6)) for p in range(6, 13)],
        "min_label": "6 números + 2 trevos", "extra": "Os trevos são sorteados junto com as dezenas.",
        "note": "É a de menor chance entre todas, e a de maior prêmio mínimo.",
    },
]


def br(n: int) -> str:
    return f"{n:,}".replace(",", ".")


# ------------------------------------------------------------------ template

def hreflangs(path_by_lang: dict[str, str]) -> str:
    out = [f'<link rel="alternate" hreflang="x-default" href="{BASE}/">',
           f'<link rel="alternate" hreflang="en" href="{BASE}/">']
    for lg, p in path_by_lang.items():
        out.append(f'<link rel="alternate" hreflang="{lg}" href="{BASE}{p}">')
    return "\n".join(out)


LANG_PATHS = {lg: f"/{lg}/" for lg in LANGS}


def build_lang_pages(index_html: str) -> list[str]:
    """Cada idioma ganha o app inteiro, com meta traduzida no HTML servido."""
    written = []
    for lg, (native, direction, og_locale) in LANGS.items():
        title, desc = LANG_META[lg]
        html = index_html

        html = html.replace('<html lang="en" dir="ltr">', f'<html lang="{lg}" dir="{direction}">')
        html = re.sub(r"<title>.*?</title>", f"<title>{title}</title>", html, count=1, flags=re.S)
        html = re.sub(r'(<meta name="description" id="meta-desc" content=")[^"]*(">)',
                      lambda m: m.group(1) + desc + m.group(2), html, count=1)
        html = html.replace(f'<link rel="canonical" href="{BASE}/">',
                            f'<link rel="canonical" href="{BASE}/{lg}/">')
        html = html.replace(f'<meta property="og:url" content="{BASE}/">',
                            f'<meta property="og:url" content="{BASE}/{lg}/">\n'
                            f'<meta property="og:locale" content="{og_locale}">')
        html = re.sub(r'<meta property="og:title" content="[^"]*">',
                      f'<meta property="og:title" content="{title}">', html)
        html = re.sub(r'<meta property="og:description" content="[^"]*">',
                      f'<meta property="og:description" content="{desc}">', html)

        # O app lê isto antes de olhar o navegador, então a página abre no
        # idioma da URL mesmo para quem nunca visitou o site.
        html = html.replace('<script type="module" src="/app.js"></script>',
                            f'<script>window.__QDRAW_LANG__ = "{lg}";</script>\n'
                            '<script type="module" src="/app.js"></script>')

        # Caminhos relativos quebrariam num subdiretório; o index já usa raiz.
        d = os.path.join(WEB, lg)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "index.html"), "w", encoding="utf-8") as f:
            f.write(html)
        written.append(f"/{lg}/")
    return written


def build_verify_page(index_html: str) -> None:
    """`/verificar` como arquivo de verdade, não como fallback.

    Enquanto era servida pelo fallback de SPA, qualquer caminho inexistente
    devolvia esta mesma página com HTTP 200 — o "soft 404" que o Google
    reclama. Sendo um arquivo, ela resolve sozinha e o fallback pode virar 404.
    """
    title = "Verificar um sorteio — Quantum Draw"
    desc = ("Confira você mesmo qualquer sorteio: a verificação roda no seu navegador e "
            "busca o farol público direto no drand, sem passar pelos nossos servidores.")
    html = index_html
    html = re.sub(r"<title>.*?</title>", f"<title>{title}</title>", html, count=1, flags=re.S)
    html = re.sub(r'(<meta name="description" id="meta-desc" content=")[^"]*(">)',
                  lambda m: m.group(1) + desc + m.group(2), html, count=1)
    html = html.replace(f'<link rel="canonical" href="{BASE}/">',
                        f'<link rel="canonical" href="{BASE}/verificar">')
    html = html.replace(f'<meta property="og:url" content="{BASE}/">',
                        f'<meta property="og:url" content="{BASE}/verificar">')
    with open(os.path.join(WEB, "verificar.html"), "w", encoding="utf-8") as f:
        f.write(html)


NOT_FOUND = f"""<!doctype html>
<html lang="pt" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Página não encontrada — Quantum Draw</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#06070d">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/assets/favicon.ico" sizes="any">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
</head>
<body>
<div class="veil" aria-hidden="true"></div>
<header>
  <div class="wrap bar">
    <a class="brand" href="/">
      <svg width="27" height="27" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="13" fill="none" stroke="#8b6cf6" stroke-width="2.2"/>
        <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="#35e6d4" stroke-width="1.8"/>
        <circle cx="16" cy="16" r="3.4" fill="#f062a6"/>
      </svg>
      <span>Quantum Draw</span>
    </a>
  </div>
</header>
<main>
  <section class="hero">
    <div class="wrap" style="max-width:620px">
      <h1 style="font-size:clamp(2rem,5vw,3rem)">404</h1>
      <p class="lede">Esta página não existe. Se você chegou por um link de sorteio,
        confira se o código está completo — ou verifique o sorteio pelo código.</p>
      <div class="cta-row">
        <a class="btn btn-primary" href="/">Ir para o início</a>
        <a class="btn btn-ghost" href="/verificar">Verificar um sorteio</a>
      </div>
    </div>
  </section>
</main>
<footer>
  <div class="wrap">
    <span>Entropia quântica de hardware da IBM, selada sob raiz de Merkle, misturada a um farol público do drand.</span>
    <span><a href="mailto:contact@stellardev.dev">contact@stellardev.dev</a></span>
  </div>
</footer>
</body>
</html>
"""


def lottery_page(lot: dict) -> str:
    odds_label = lot.get("odds_label", "números marcados")
    rows = "\n".join(
        f"        <tr><td>{p}</td><td>1 em {br(c)}</td></tr>" for p, c in lot["odds"]
    )
    others = "\n".join(
        f'        <a class="recent-card" href="/pt/{o["slug"]}"><h4>{o["name"]}</h4>'
        f'<div class="meta">1 em {br(o["odds"][0][1])} · {o["min_label"]}</div></a>'
        for o in LOTTERIES if o["slug"] != lot["slug"]
    )
    best = min(lot["odds"], key=lambda r: r[1])
    title = f"Gerador de jogos da {lot['name']} — números quânticos com prova"
    desc = (f"Gere jogos da {lot['name']} com números vindos de medição quântica em hardware "
            f"da IBM. Prova pública de que os números saíram antes do sorteio. Grátis.")

    faq = [
        (f"O gerador aumenta minha chance na {lot['name']}?",
         "Não. Nenhum método aumenta. A chance é a mesma de qualquer combinação, sorteada "
         "por computador quântico ou escolhida de cabeça. O que o site entrega é outra "
         "coisa: prova de quando os números foram gerados."),
        (f"Para que serve a prova, então?",
         "Para bolão. Como o compromisso com os números é registrado antes de a "
         "aleatoriedade existir, dá para demonstrar ao grupo que o organizador não "
         "escolheu as dezenas depois de ver o resultado da Caixa."),
        (f"Quantos números posso marcar na {lot['name']}?",
         lot["rule"]),
        ("Os números são mesmo quânticos?",
         "São. Qubits de um processador da IBM são colocados em superposição e medidos; "
         "o resultado de cada medição é um bit. A prova de cada geração traz o "
         "identificador do job executado na IBM."),
    ]
    faq_html = "\n".join(
        f'      <details class="order"><summary>{q}</summary><p style="color:var(--text-dim);'
        f'font-size:.92rem;padding:6px 0 14px">{a}</p></details>' for q, a in faq
    )
    faq_ld = {
        "@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q,
                        "acceptedAnswer": {"@type": "Answer", "text": a}} for q, a in faq],
    }

    return f"""<!doctype html>
<html lang="pt" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#06070d">
<link rel="canonical" href="{BASE}/pt/{lot['slug']}">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:type" content="article">
<meta property="og:url" content="{BASE}/pt/{lot['slug']}">
<meta property="og:image" content="{BASE}/assets/og.png">
<meta property="og:locale" content="pt_BR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="{BASE}/assets/og.png">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="/assets/favicon.ico" sizes="any">
<link rel="icon" href="/assets/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/icon-180.png">
<script type="application/ld+json">{json.dumps(faq_ld, ensure_ascii=False)}</script>
</head>
<body>
<div class="veil" aria-hidden="true"></div>

<header>
  <div class="wrap bar">
    <a class="brand" href="/pt/">
      <svg width="27" height="27" viewBox="0 0 32 32" aria-hidden="true">
        <circle cx="16" cy="16" r="13" fill="none" stroke="#8b6cf6" stroke-width="2.2"/>
        <ellipse cx="16" cy="16" rx="13" ry="5" fill="none" stroke="#35e6d4" stroke-width="1.8"/>
        <circle cx="16" cy="16" r="3.4" fill="#f062a6"/>
      </svg>
      <span>Quantum Draw</span>
    </a>
    <nav class="links">
      <a href="/pt/">Sortear</a>
      <a href="/verificar">Verificar</a>
    </nav>
  </div>
</header>

<main>
<section class="hero" style="padding:64px 0 30px">
  <div class="wrap" style="max-width:760px">
    <span class="eyebrow"><i class="dot"></i>Entropia quântica ao vivo</span>
    <h1 style="font-size:clamp(1.9rem,4.6vw,2.9rem)">Gerador de jogos da <em>{lot['name']}</em></h1>
    <p class="lede">Dezenas geradas por medição quântica em hardware real da IBM, com prova
      pública de que saíram antes do sorteio. De graça, sem cadastro.</p>
    <div class="cta-row">
      <a class="btn btn-primary" href="/pt/?lottery={lot['id']}#create">Gerar meus jogos</a>
      <a class="btn btn-ghost" href="/pt/#how">Como funciona</a>
    </div>
  </div>
</section>

<section style="padding:26px 0">
  <div class="wrap" style="max-width:760px">
    <div class="card">
      <h2 style="font-size:1.3rem;text-align:start">Como se joga na {lot['name']}</h2>
      <p style="color:var(--text-dim)">{lot['rule']}</p>
      <p style="color:var(--text-dim)">{lot['note']}</p>
      {f'<p style="color:var(--text-dim)">{lot["extra"]}</p>' if lot["extra"] else ''}
    </div>

    <div class="card" style="margin-top:18px">
      <h2 style="font-size:1.3rem;text-align:start">Qual a chance real</h2>
      <p style="color:var(--text-dim);font-size:.92rem">Probabilidade de acertar o prêmio
        máximo, por quantidade marcada. A melhor aposta desta tabela ainda é
        <strong style="color:var(--cyan)">1 em {br(best[1])}</strong>.</p>
      <table class="odds">
        <thead><tr><th>{odds_label}</th><th>chance</th></tr></thead>
        <tbody>
{rows}
        </tbody>
      </table>
    </div>

    <div class="card" style="margin-top:18px">
      <h2 style="font-size:1.3rem;text-align:start">O que a prova garante — e o que não garante</h2>
      <p style="color:var(--text-dim)"><strong style="color:var(--text)">Não garante</strong>
        chance melhor. Nenhum gerador garante, e quem prometer isso está mentindo. As
        combinações são todas igualmente improváveis.</p>
      <p style="color:var(--text-dim)"><strong style="color:var(--text)">Garante</strong> que
        os números existiam antes do sorteio da Caixa. A semente mistura um pulso quântico
        selado sob uma raiz de Merkle publicada de antemão com um round futuro do drand,
        um farol público que ninguém consegue prever. Como o compromisso é registrado
        antes de esse round existir, ninguém — nem nós — poderia ter escolhido as dezenas.</p>
      <p style="color:var(--text-dim)">Isso resolve um problema concreto de bolão: provar ao
        grupo que o organizador não montou o jogo depois de ver o resultado.</p>
      <a class="btn btn-ghost btn-sm" href="/verificar">Ver como a verificação funciona</a>
    </div>

    <div class="card" style="margin-top:18px">
      <h2 style="font-size:1.3rem;text-align:start">Perguntas frequentes</h2>
{faq_html}
    </div>

    <h2 style="font-size:1.2rem;margin:34px 0 14px">Outras loterias</h2>
    <div class="recent-grid">
{others}
    </div>
  </div>
</section>
</main>

<footer>
  <div class="wrap">
    <span>Entropia quântica de hardware da IBM, selada sob raiz de Merkle, misturada a um farol público do drand.</span>
    <span><a href="mailto:contact@stellardev.dev">contact@stellardev.dev</a></span>
  </div>
</footer>
</body>
</html>
"""


def build_sitemap(lang_paths: list[str], lottery_paths: list[str]) -> str:
    alts = "\n".join(
        f'    <xhtml:link rel="alternate" hreflang="{lg}" href="{BASE}{p}"/>'
        for lg, p in LANG_PATHS.items()
    )
    entries = [f"""  <url>
    <loc>{BASE}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="x-default" href="{BASE}/"/>
    <xhtml:link rel="alternate" hreflang="en" href="{BASE}/"/>
{alts}
  </url>"""]
    for p in lang_paths:
        entries.append(f"""  <url>
    <loc>{BASE}{p}</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>""")
    for p in lottery_paths:
        entries.append(f"""  <url>
    <loc>{BASE}{p}</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>""")
    entries.append(f"""  <url>
    <loc>{BASE}/verificar</loc>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>""")
    body = "\n".join(entries)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!-- Gerado por scripts/build_pages.py. Não editar à mão. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
{body}
</urlset>
"""


def main() -> int:
    with open(os.path.join(WEB, "index.html"), encoding="utf-8") as f:
        index_html = f.read()

    lang_paths = build_lang_pages(index_html)
    print(f"idiomas: {len(lang_paths)} páginas")

    build_verify_page(index_html)
    with open(os.path.join(WEB, "404.html"), "w", encoding="utf-8") as f:
        f.write(NOT_FOUND)
    print("avulsas: verificar.html, 404.html")

    lottery_paths = []
    d = os.path.join(WEB, "pt")
    os.makedirs(d, exist_ok=True)
    for lot in LOTTERIES:
        with open(os.path.join(d, f"{lot['slug']}.html"), "w", encoding="utf-8") as f:
            f.write(lottery_page(lot))
        lottery_paths.append(f"/pt/{lot['slug']}")
    print(f"loterias: {len(lottery_paths)} páginas")

    with open(os.path.join(WEB, "sitemap.xml"), "w", encoding="utf-8") as f:
        f.write(build_sitemap(lang_paths, lottery_paths))
    print(f"sitemap: {1 + len(lang_paths) + len(lottery_paths) + 1} URLs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
