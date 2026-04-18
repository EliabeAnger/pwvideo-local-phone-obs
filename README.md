# PWVD

Sistema local para transmitir a câmera traseira do celular (qualquer navegador moderno) para o **OBS Studio** no PC, via rede local, usando **WebRTC/WHIP** para latência mínima. **Vídeo apenas**, sem áudio.

## Arquitetura

```
[Celular / navegador]  --WHIP (HTTPS)-->  [Node Fastify]  --proxy-->  [MediaMTX]
                                                                      |--WHEP-->  OBS (plugin WebRTC)
                                                                      |--RTSP-->  OBS (Media Source)
```

- `server/` — Fastify HTTPS, proxy WHIP/WHEP, painel, QR, gerador de URLs.
- `media/mediamtx.yml` — servidor de mídia (WHIP in / WHEP + RTSP + RTMP out).
- `web/` — página de captura do celular e painel do operador.
- `scripts/` — geração de certificados e inicialização.

## Requisitos

- **Node.js 20+**
- **MediaMTX** (binário): baixe em https://github.com/bluenviron/mediamtx/releases e coloque em `bin/mediamtx.exe` (Windows) ou `bin/mediamtx` (Linux/macOS). Ou aponte `MEDIAMTX_PATH` no `.env` para onde estiver.
- **mkcert** (recomendado) para certificado local confiável no celular: https://github.com/FiloSottile/mkcert
- OBS com o plugin **OBS WebRTC Source** (para WHEP, caminho de menor latência). Em último caso, use a fonte **Media Source** com RTSP.

## Instalação rápida (Windows)

```powershell
# 1. Instalar dependências
npm install

# 2. Gerar .env e certificados locais
Copy-Item .env.example .env
npm run certs

# 3. (Opcional) instalar a root CA do mkcert no celular
# Envie o arquivo retornado por `mkcert -CAROOT` (rootCA.pem) ao celular e instale-o.

# 4. Baixe o MediaMTX e deixe em bin\mediamtx.exe (ou ajuste MEDIAMTX_PATH no .env)

# 5. Iniciar
npm start
```

O console exibirá:

```
Phone (scan QR or open)   : https://192.168.0.10:8443/
Operator dashboard        : https://192.168.0.10:8443/op.html
OBS WHEP URL              : https://192.168.0.10:8443/whep/live
OBS RTSP URL              : rtsp://192.168.0.10:8554/live
```

Um QR code é impresso no terminal — aponte a câmera do celular.

## Uso

1. No celular, abra o link HTTPS (aceite o certificado se necessário).
2. Toque em **Iniciar captura**. Ajuste resolução, FPS, bitrate e codec.
3. No OBS, adicione uma fonte WebRTC (WHEP) colando a `OBS WHEP URL`. Para RTSP, use a fonte Media Source.
4. O painel do operador (`/op.html`) mostra bitrate, FPS, RTT, jitter e perda de pacotes em tempo real.

## Portas

| Porta | Serviço                               |
|-------|----------------------------------------|
| 8443  | HTTPS — UI + WHIP/WHEP (proxy)         |
| 8554  | RTSP (OBS Media Source)                |
| 8889  | MediaMTX WebRTC (WHIP/WHEP direto)     |
| 8189  | UDP/TCP ICE do MediaMTX                |
| 1935  | RTMP (fallback, opcional)              |

Libere-as no firewall do Windows (para redes privadas).

## Rede recomendada

1. **Melhor**: celular com adaptador USB-Ethernet no mesmo switch do PC.
2. **Boa**: celular e PC no mesmo AP Wi-Fi 6 (5 GHz), sem hops de mesh.
3. **Aceitável**: celular em 5G com tethering USB para o PC.

## Solução de problemas

- **Câmera não abre**: abra via HTTPS; iOS exige interação do usuário antes de `getUserMedia`; verifique permissões do navegador.
- **Firefox no Android**: mantém compatibilidade WHIP; se falhar, troque o codec preferido para VP9 ou VP8.
- **iOS Safari e H.264**: funciona nativamente; AV1/VP9 podem não estar disponíveis — o painel expõe apenas os codecs aceitos.
- **OBS não conecta no WHEP**: use o link “WHEP direto” (`http://<ip>:8889/live/whep`) que vai direto ao MediaMTX sem TLS.
- **Latência alta**: use preset **Latência mínima**, reduza FPS para 30, confirme que o transporte ICE é host-candidate (mesma sub-rede).

## Segurança

- HTTPS é obrigatório; o servidor não inicia sem `certs/cert.pem` e `certs/key.pem`.
- Por padrão o MediaMTX aceita publicações anônimas na rede local. Para redes compartilhadas, defina `publishUser`/`publishPass` em `media/mediamtx.yml`.
- Nunca commite `.env` nem o conteúdo de `certs/`.
