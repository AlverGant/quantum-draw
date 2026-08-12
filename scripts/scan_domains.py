#!/usr/bin/env python3
"""
Varre todos os hosts da conta Cloudflare procurando o padrão que o Google
classifica como "Deceptive pages".

    python3 scripts/scan_domains.py                 # enumera pela API e varre
    python3 scripts/scan_domains.py --hosts a.com b.com
    python3 scripts/scan_domains.py --json          # saída para máquina

O que ele procura
-----------------
O classificador de engenharia social do Google não lê intenção, lê padrão. O
mais perigoso é a combinação:

    tela de login  +  marca de terceiro  +  domínio que não é daquela marca

Isso é indistinguível de phishing de credenciais, mesmo quando é só um
dashboard interno protegido por Cloudflare Access. O nome que aparece em
"Log in to ..." vem da configuração do app no Access, e é o texto que mais
pesa: é o que o visitante (e o robô) lê na hora de decidir se confia.

O script não decide nada sozinho. Ele mostra os sinais e a que host pertencem;
julgar o que é uso legítimo de marca continua com você.

Enumeração
----------
Usa o token OAuth do wrangler (~/.config/.wrangler/config/default.toml), o
mesmo que já autoriza o deploy. Nada é enviado para lugar nenhum além da API
da Cloudflare e dos próprios hosts varridos.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
UA = "qdraw-scan/1.0"
TIMEOUT = 20

# Marcas de terceiros que costumam aparecer em projetos de mídia e TV no
# Brasil. A lista existe para levantar a bandeira, não para acusar: citar uma
# marca pode ser perfeitamente legítimo (o nosso próprio site fala das
# loterias da Caixa). O que muda o jogo é a marca aparecer numa tela de login.
BRANDS = [
    "globoplay", "globo", "sbt", "record", "band", "netflix", "disney", "hbo",
    "max", "prime video", "amazon", "youtube", "spotify", "apple", "samsung",
    "tizen", "roku", "webos", "vivo", "claro", "tim", "sky", "caixa",
    "itau", "itaú", "bradesco", "nubank", "santander", "mercado pago", "pix",
]

LOGIN_HINTS = re.compile(
    r"(log ?in to|sign in|entrar com|fa[cç]a login|acesse sua conta|"
    r"type=[\"']?password|oauth|single sign[- ]on)", re.I)
CRYPTO = re.compile(r"\b(bc1[a-z0-9]{20,}|0x[a-f0-9]{40}|carteira bitcoin|crypto wallet)\b", re.I)
PERSONAL = re.compile(r"\b(cpf|cnpj|cart[aã]o de cr[eé]dito|credit card|n[uú]mero do cart[aã]o)\b", re.I)
DOWNLOAD = re.compile(r"(baixar|download)[^<]{0,40}\.(exe|apk|msi|dmg|zip)", re.I)
# "Log in to <nome do app>" é o texto do Cloudflare Access.
ACCESS_APP = re.compile(r"log ?in to ([^<\n\"]{2,60})", re.I)


def wrangler_token() -> str | None:
    path = os.path.expanduser("~/.config/.wrangler/config/default.toml")
    try:
        with open(path, encoding="utf-8") as f:
            m = re.search(r'oauth_token\s*=\s*"([^"]+)"', f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def api_get(path: str, token: str):
    req = urllib.request.Request(f"{API}/{path}", headers={
        "authorization": f"Bearer {token}", "user-agent": UA, "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = json.load(r)
        return body.get("result") or []
    except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError):
        return []


def enumerate_hosts(token: str) -> dict[str, list[str]]:
    """Descobre todos os hostnames da conta. Devolve host -> origens."""
    hosts: dict[str, list[str]] = {}

    def add(h: str, origem: str):
        h = h.strip().lower()
        if h and "." in h and not h.endswith(".workers.dev"):
            hosts.setdefault(h, [])
            if origem not in hosts[h]:
                hosts[h].append(origem)

    accounts = api_get("accounts", token)
    for acc in accounts:
        aid = acc["id"]

        for d in api_get(f"accounts/{aid}/workers/domains", token):
            add(d.get("hostname", ""), f"worker:{d.get('service', '?')}")

        for p in api_get(f"accounts/{aid}/pages/projects", token):
            name = p.get("name", "?")
            for dom in p.get("domains", []) or []:
                add(dom, f"pages:{name}")

        # Rotas por zona pegam o que não é "custom domain".
        for z in api_get("zones", token):
            for r in api_get(f"zones/{z['id']}/workers/routes", token):
                pattern = r.get("pattern", "")
                host = pattern.split("/")[0].replace("*.", "").replace("*", "")
                add(host, f"route:{r.get('script', '?')}")
            # Registros DNS revelam hosts que não passam por Worker nenhum.
            for rec in api_get(f"zones/{z['id']}/dns_records?per_page=200", token):
                if rec.get("type") in ("A", "AAAA", "CNAME") and rec.get("proxied"):
                    add(rec.get("name", ""), "dns")

    return hosts


def fetch(host: str) -> tuple[int, str]:
    for scheme in ("https", "http"):
        req = urllib.request.Request(f"{scheme}://{host}", headers={"user-agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.status, r.read(400_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            try:
                return e.code, e.read(400_000).decode("utf-8", "replace")
            except Exception:
                return e.code, ""
        except Exception:
            continue
    return 0, ""


def strip_tags(html: str) -> str:
    txt = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.S | re.I)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", txt))


def analyse(host: str, status: int, html: str) -> dict:
    text = strip_tags(html)
    low = (text + " " + host).lower()

    title = ""
    m = re.search(r"<title>(.*?)</title>", html, re.S | re.I)
    if m:
        title = re.sub(r"\s+", " ", strip_tags(m.group(1))).strip()[:60]

    app = ""
    m = ACCESS_APP.search(text)
    if m:
        # O texto da interface do Access vem colado no nome do app depois de
        # remover as tags; cortamos no primeiro rótulo conhecido.
        app = re.split(r"\s+(?:Email|Send login code|Sign in|Entrar|Continue)\b",
                       m.group(1).strip(), maxsplit=1)[0].strip()[:44]

    has_login = bool(LOGIN_HINTS.search(html))
    brands_page = sorted({b for b in BRANDS if re.search(rf"\b{re.escape(b)}\b", text.lower())})
    brands_host = sorted({b for b in BRANDS if b.replace(" ", "") in host.lower()})
    brands = sorted(set(brands_page) | set(brands_host))

    flags = []
    if has_login:
        flags.append("login")
    if brands_host:
        flags.append("marca-no-host")
    if brands_page:
        flags.append("marca-no-texto")
    if CRYPTO.search(text):
        flags.append("cripto")
    if PERSONAL.search(text):
        flags.append("dado-pessoal")
    if DOWNLOAD.search(html):
        flags.append("download")

    # O padrão de phishing é login + marca. O resto é ruído em comparação.
    if has_login and brands:
        risk, why = "ALTO", "tela de login exibindo marca de terceiro em domínio que não é dela"
    elif brands_host:
        risk, why = "MEDIO", "marca de terceiro no próprio hostname"
    elif has_login and status in (401, 403):
        risk, why = "BAIXO", "login sem marca"
    elif brands_page:
        risk, why = "BAIXO", "marca citada no texto, sem login"
    elif "cripto" in flags or "dado-pessoal" in flags:
        risk, why = "MEDIO", "pede pagamento ou dado pessoal"
    elif status == 0:
        risk, why = "-", "não respondeu"
    else:
        risk, why = "OK", ""

    partes = host.split(".")
    registravel = ".".join(partes[-2:]) if len(partes) >= 2 else host

    return {"host": host, "dominio": registravel, "status": status, "title": title, "access_app": app,
            "brands": brands, "flags": flags, "risk": risk, "why": why}


ORDER = {"ALTO": 0, "MEDIO": 1, "BAIXO": 2, "OK": 3, "-": 4}
COLOR = {"ALTO": "\033[31m", "MEDIO": "\033[33m", "BAIXO": "\033[36m", "OK": "\033[32m", "-": "\033[2m"}


def main() -> int:
    ap = argparse.ArgumentParser(description="Varre hosts procurando padrão de página enganosa")
    ap.add_argument("--hosts", nargs="*", help="varre estes hosts em vez de enumerar")
    ap.add_argument("--json", action="store_true", help="saída em JSON")
    args = ap.parse_args()

    if args.hosts:
        hosts = {h: ["manual"] for h in args.hosts}
    else:
        token = wrangler_token()
        if not token:
            print("token do wrangler não encontrado; rode `npx wrangler login` "
                  "ou use --hosts", file=sys.stderr)
            return 2
        hosts = enumerate_hosts(token)
        if not hosts:
            print("nenhum host encontrado pela API", file=sys.stderr)
            return 1

    results = []
    for host in sorted(hosts):
        status, html = fetch(host)
        r = analyse(host, status, html)
        r["origens"] = hosts[host]
        results.append(r)

    results.sort(key=lambda r: (ORDER.get(r["risk"], 9), r["host"]))

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return 0

    print(f"\n{len(results)} hosts varridos\n")
    print(f"{'risco':<7} {'host':<34} {'st':>3}  detalhe")
    print("-" * 104)
    for r in results:
        c = COLOR.get(r["risk"], "")
        detalhe = r["access_app"] and f'Access: "{r["access_app"]}"' or r["title"] or "-"
        if r["brands"]:
            detalhe += f'  [{", ".join(r["brands"])}]'
        print(f"{c}{r['risk']:<7}\033[0m {r['host']:<34} {r['status'] or '--':>3}  {detalhe[:58]}")

    graves = [r for r in results if r["risk"] in ("ALTO", "MEDIO")]
    if graves:
        por_dominio = {}
        for r in graves:
            por_dominio.setdefault(r["dominio"], []).append(r["host"])
        print(f"\n{len(graves)} host(s) para revisar, por domínio:")
        for d, hs in sorted(por_dominio.items()):
            print(f"  {d}: {len(hs)}  ({', '.join(h.split('.')[0] for h in hs)})")
        print("\nO alerta do Search Console é por propriedade — só os hosts do")
        print("domínio verificado afetam aquele aviso. Os demais valem corrigir")
        print("pelo Safe Browsing, que é global.\n")
        for r in graves:
            print(f"  {COLOR[r['risk']]}{r['risk']}\033[0m  {r['host']}")
            print(f"        motivo : {r['why']}")
            if r["access_app"]:
                print(f'        o login diz: "Log in to {r["access_app"]}"')
            print(f"        origem : {', '.join(r['origens'])}")
            if r["risk"] == "ALTO":
                print("        corrija: renomeie o app no Zero Trust → Access → Applications")
                print("                 e troque o hostname para um nome sem marca")
            print()
    else:
        print("\nnenhum host com o padrão de página enganosa.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
