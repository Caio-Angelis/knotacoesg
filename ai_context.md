# AI Context — KNotaçõesG

> Documento vivo para IAs (e humanos) entenderem o projeto rapidamente. **Atualizar sempre que a estrutura ou o escopo mudar.**

**Última atualização:** 2026-06-21 — v1.7.0 (Shadow DOM, coordenadas, YouTube/Trusted Types).

---

## O que é

**KNotaçõesG** é um **userscript Tampermonkey** autocontido que permite:

- Anotar qualquer página web **clicando em qualquer ponto** (coordenadas normalizadas)
- Persistir anotações **globalmente** (entre sites) via `GM_setValue`
- **Pins dourados** fixos na posição clicada (arrastáveis após criação)
- Várias anotações **simultâneas** na mesma página (pins e detalhes independentes)
- Painel filtrável com **data/hora**, **excluir** e navegação (`#kng={uuid}`)
- Seek de vídeo nativo same-origin ao navegar para anotação (incl. player YouTube)
- Toggle por site via menu Tampermonkey (desativa UI, mantém dados)
- Compatibilidade com **YouTube** (Trusted Types, SPA, `pageKey` por vídeo)

**Não é** uma extensão Chrome completa — é um único arquivo `.user.js` instalado no Tampermonkey.

---

## Estrutura de pastas / arquivos

```
Extensao KNotaçõesG/
├── knotacoes.user.js      ← CÓDIGO PRINCIPAL (~2050 linhas)
├── ai_context.md          ← Este arquivo (contexto para IAs)
├── plano.md               ← Especificação técnica original (parcialmente desatualizada)
├── checklist.md           ← Guia de execução + progresso + matriz de testes
└── .git/                  ← Repo publicado: Caio-Angelis/knotacoesg
```

| Arquivo | Função |
|---------|--------|
| `knotacoes.user.js` | Artefato executável completo: storage, UI, pins, highlight, toggle, init. |
| `ai_context.md` | Mapa do projeto para continuidade entre sessões de IA. |
| `plano.md` | Especificação inicial (modo clique-em-elemento foi substituído por coordenadas). |
| `checklist.md` | Ordem de implementação, critérios de done, testes T1–T17. |

**Não há** `package.json`, bundler, ou múltiplos módulos.

---

## Estado atual da implementação

| Fase | Escopo | Status |
|------|--------|--------|
| 1–6 | Fundação, storage, seletor, vídeo, CSS, UI | ✅ Feito |
| 7 | Highlight + navegação hash/SPA | ✅ Feito |
| 8 | Toggle Tampermonkey menu | ✅ Feito |
| 9 | Bootstrap init completo | ✅ Feito |
| 10 | Polimento e robustez | ✅ Feito |
| 11 | Testes manuais T1–T17 | ⏳ Manual |
| 12 | Publicação GitHub + URLs reais | ✅ Feito |
| 13 | Modo coordenada (clique livre) | ✅ Feito |
| 14 | Pins arrastáveis + múltiplos abertos | ✅ Feito |
| 15 | Painel: excluir + data/hora | ✅ Feito |
| 16 | YouTube: Trusted Types + Shadow DOM | ✅ Feito |
| 17 | Bootstrap resiliente (heartbeat, SPA hooks) | ✅ Feito |

**Versão atual:** `1.7.0` (`SCRIPT_VERSION` no código).

---

## Arquitetura interna de `knotacoes.user.js`

```
METADATA block          → @grant GM_* + GM_addStyle, @run-at document-end
CONSTANTS + LOGGING     → SCRIPT_VERSION, STORAGE_KEYS
STORAGE                 → CRUD + toggle por hostname + updateAnnotationAnchor
SELECTOR UTILS          → generateSelector (legado, anotações antigas por elemento)
VIDEO UTILS             → findNativeVideo (prioriza .html5-main-video no YouTube)
UI STATE                → objeto `ui`, shadowRoot, flags de lifecycle
UI HELPERS              → ensureUiShadow, appendUi, queryKng, createLabel/Heading (sem innerHTML)
COORDINATE UTILS        → pageToNormalized, normalizedToViewport, pageIdentity
STYLES                  → injectStyles() via GM_addStyle
FAB / CLICK MODE        → overlay bloqueia página inteira; clique captura coordenada
CREATE MODAL / PANEL    → DOM puro; painel com excluir + data/hora
PAGE MARKERS            → pins dourados, drag via Pointer Events, toggle detalhe
HIGHLIGHT               → tryHighlightFromHash, highlightPoint, retryWithBackoff
URL / SPA WATCHERS      → hashchange, popstate, pushState, yt-navigate-finish
BOOTSTRAP               → ensureBootstrap, heartbeat 3s, MutationObserver, visibilitychange
TOGGLE / TEARDOWN       → registerToggleCommand, setupUI, teardownUI
INIT                    → init() + load + visibilitychange
```

### Isolamento de UI (YouTube / Trusted Types)

- **Shadow DOM:** host `#kng-shadow-host` com `attachShadow({ mode: 'open' })`
- **CSS:** `GM_addStyle()` — não injeta `<style>` no DOM da página
- **DOM:** zero `innerHTML` — só `createElement` + `textContent` + `appendChild`
- **pointer-events:** host `none`; filhos interativos (FAB, overlay, modal, pins) `auto`

---

## Fluxo completo

```
init()
  → verifica GM_getValue (Tampermonkey instalado?)
  → console.info `[KNotaçõesG] v1.7.0 carregado`
  → registerToggleCommand() [sempre]
  → se site desabilitado: toast + para
  → ensureBootstrap()
      → injectStyles (GM_addStyle)
      → ensureUiShadow + setupUI (FAB 📝)
      → registerUrlWatchers + registerSPAHooks (YouTube)
      → watchForDOMChanges + startHeartbeat (3s)
      → scheduleRenderPageMarkers + tryHighlightFromHash

FAB → Nova anotação
  → overlay bloqueia cliques na página (vídeo não pausa)
  → clique captura coordenada normalizada
  → modal (título, descrição, tag, timestamp vídeo se houver)
  → salvar → addSingleMarker (não recria todos os pins)

FAB → Ver anotações
  → painel + filtros (site, tag, vídeo)
  → clique item → navega + highlight
  → botão Excluir por item

Pin dourado
  → clique rápido: toggle detalhe (vários abertos ao mesmo tempo)
  → arrastar: reposiciona e persiste anchor.x/y

Menu TM → Desativar → teardownUI() (dados intactos)
Menu TM → Ativar → ensureBootstrap()
```

---

## Modelo de dados (GM_setValue)

| Chave | Tipo | Descrição |
|-------|------|-----------|
| `kng_annotations` | `Annotation[]` | Todas as anotações globais |
| `kng_site_enabled` | `Record<hostname, boolean>` | Toggle por site (default `true`) |
| `kng_welcome_shown` | `boolean` | Toast de boas-vindas já exibido |

```javascript
{
  id: "uuid-v4",
  title, description, tag,
  url,              // normalizePageUrl (sem hash)
  pageKey,          // identidade estável (ex.: youtube:watch:VIDEO_ID)
  hostname, createdAt,
  videoTimestamp: number | null,
  anchor: {
    type: 'point',  // modo atual
    x: 0.0–1.0,     // coordenada normalizada na largura do documento
    y: 0.0–1.0,     // coordenada normalizada na altura do documento
    selector: '',   // legado (anotações antigas por elemento HTML)
    markerId: ''    // legado (data-kng-id efêmero)
  }
}
```

### Identidade de página (`pageIdentity`)

- URLs normais: URL base sem hash
- YouTube watch: `youtube:watch:{videoId}`
- YouTube shorts: `youtube:shorts:{id}`
- youtu.be: `youtube:watch:{id}`

Usado em `matchesCurrentPage()` para pins persistirem ao trocar query params (`&t=`, `&list=`).

---

## Grants Tampermonkey

- `GM_setValue` / `GM_getValue`
- `GM_addStyle`
- `GM_registerMenuCommand` / `GM_unregisterMenuCommand`

---

## API interna (referência rápida)

| Área | Funções principais |
|------|-------------------|
| Storage | `loadAnnotations`, `saveAnnotations`, `createAnnotation`, `updateAnnotationAnchor`, `deleteAnnotation`, `isSiteEnabled`, `setSiteEnabled` |
| Coordenadas | `pageToNormalized`, `normalizedToViewport`, `pageIdentity`, `matchesCurrentPage`, `isPointAnchor` |
| Seletor (legado) | `generateSelector`, `validateSelector`, `resolveAnnotationElement` |
| Vídeo | `findNativeVideo`, `formatTimestamp`, `seekVideo` |
| UI shell | `ensureUiShadow`, `appendUi`, `queryKng`, `queryKngAll`, `createLabel`, `createHeading`, `clearNode` |
| UI fluxo | `createFAB`, `enterClickMode`, `exitClickMode`, `openCreateModal`, `openPanel`, `showToast` |
| Pins | `createPinElement`, `setupPinDrag`, `addSingleMarker`, `togglePinDetail`, `renderPageMarkers` |
| Navegação | `parseHashId`, `tryHighlightFromHash`, `highlightPoint`, `retryWithBackoff`, `navigateToAnnotation` |
| Lifecycle | `ensureBootstrap`, `teardownUI`, `setupUI`, `startHeartbeat`, `registerSPAHooks`, `init` |

---

## Limitações conhecidas

1. **Tampermonkey obrigatório** — baixar `.user.js` sem instalar na extensão não funciona
2. **Modo dev** pode ser necessário no Tampermonkey (configuração do usuário)
3. Coordenadas normalizadas podem deslocar levemente se layout da página mudar drasticamente (resize responsivo extremo)
4. Anotações legadas por `anchor.selector` ainda funcionam parcialmente; novas usam `type: 'point'`
5. Timestamp só em `<video>` same-origin (não iframe cross-origin)
6. SPAs lentas: retry 500ms / 1s / 2s antes de toast de falha no highlight
7. `plano.md` descreve modo clique-em-elemento — **obsoleto**; preferir este documento

---

## Instalação (dev / distribuição)

1. Instalar [Tampermonkey](https://www.tampermonkey.net/) (Chrome/Firefox/Edge)
2. Dashboard → Create Script → colar conteúdo completo de `knotacoes.user.js`
3. Salvar (Ctrl+S) → recarregar a página alvo (F5)
4. Confirmar no F12: `[KNotaçõesG] v1.7.0 carregado`
5. FAB 📝 no canto inferior direito

**Importante:** após atualizar o arquivo, é preciso **substituir todo o script** no Tampermonkey e salvar — não basta baixar o arquivo localmente.

---

## URLs de distribuição

```
@namespace    https://github.com/Caio-Angelis/knotacoesg
@updateURL    https://raw.githubusercontent.com/Caio-Angelis/knotacoesg/main/knotacoes.user.js
@downloadURL  https://raw.githubusercontent.com/Caio-Angelis/knotacoesg/main/knotacoes.user.js
@version      1.7.0
```

Instalação 1-clique: colar `@downloadURL` no Tampermonkey ou importar do GitHub.

---

## Troubleshooting rápido

| Sintoma | Causa provável | Ação |
|---------|----------------|------|
| FAB não aparece | Script não instalado / desativado | Tampermonkey dashboard → toggle verde; recarregar |
| FAB não aparece | Site desativado | Menu TM → "Ativar Anotações neste site" |
| YouTube: clique não abre modal | Versão antiga com `innerHTML` | Atualizar para v1.7.0; verificar console |
| Erro `TrustedHTML` | Versão < 1.6.1 | Atualizar script completo |
| Pins somem ao criar novo | Versão < 1.4.0 | `addSingleMarker` corrige isso |
| Amigo não vê FAB | Só baixou arquivo | Instalar via Tampermonkey + modo dev se necessário |

---

## Próximos passos (opcional)

1. Atualizar `plano.md` para refletir modo coordenada e Shadow DOM
2. Rodar matriz de testes T1–T17 em `checklist.md` (incl. YouTube)
3. Publicar release v1.7.0 no GitHub se ainda não publicado
