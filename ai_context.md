# AI Context — KNotaçõesG

> Documento vivo para IAs (e humanos) entenderem o projeto rapidamente. **Atualizar sempre que a estrutura ou o escopo mudar.**

**Última atualização:** 2025-06-21 — Projeto completo publicado em GitHub (`Caio-Angelis/knotacoesg`).

---

## O que é

**KNotaçõesG** é um **userscript Tampermonkey** autocontido que permite:

- Anotar qualquer página web clicando em elementos
- Persistir anotações **globalmente** (entre sites) via `GM_setValue`
- Reencontrar elementos após reload via **CSS selector** robusto
- **Pins dourados na tela** sobre cada elemento anotado (página atual)
- Painel filtrável com navegação e destaque visual (`#kng={uuid}`)
- Seek de vídeo nativo same-origin ao navegar para anotação
- Toggle por site via menu Tampermonkey (desativa UI, mantém dados)

**Não é** uma extensão Chrome completa — é um único arquivo `.user.js` instalado no Tampermonkey.

---

## Estrutura de pastas / arquivos

```
Extensao KNotaçõesG/
├── knotacoes.user.js      ← CÓDIGO PRINCIPAL (~1220 linhas)
├── ai_context.md          ← Este arquivo (contexto para IAs)
├── plano.md               ← Especificação técnica e arquitetura
├── checklist.md           ← Guia de execução + progresso + matriz de testes
└── userscript_knotaçõesg_27e3e1bf.plan.md  ← Cópia/export do plano (Cursor)
```

| Arquivo | Função |
|---------|--------|
| `knotacoes.user.js` | Artefato executável completo: storage, seletor, vídeo, CSS, UI, highlight, toggle, init. |
| `ai_context.md` | Mapa do projeto para continuidade entre sessões de IA. |
| `plano.md` | Fonte de verdade: modelo de dados, fluxos, limitações. |
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

---

## Arquitetura interna de `knotacoes.user.js`

```
METADATA block          → @grant GM_* incl. unregisterMenuCommand
CONSTANTS + LOGGING
STORAGE                 → CRUD + toggle por hostname
SELECTOR UTILS          → generateSelector, validateSelector, injectEphemeralMarker
VIDEO UTILS             → findNativeVideo, formatTimestamp, seekVideo
UI STATE                → objeto `ui`, flags kngInitialized, urlWatchersRegistered
UI HELPERS              → isKngNode, showToast, trapFocus, navigateToAnnotation
STYLES                  → injectStyles()
FAB / CLICK MODE        → createFAB, enterClickMode, handleElementClick
CREATE MODAL / PANEL    → openCreateModal, openPanel + filtros
HIGHLIGHT               → parseHashId, tryHighlightFromHash, highlightElement, retryWithBackoff
URL WATCHERS            → hashchange, popstate, pushState/replaceState wrap
TOGGLE / TEARDOWN       → registerToggleCommand, setupUI, teardownUI
INIT                    → init() no DOMContentLoaded
```

---

## Fluxo completo

```
init()
  → registerToggleCommand() [sempre]
  → se site desabilitado: para aqui
  → setupUI() → injectStyles + FAB
  → registerUrlWatchers()
  → retryWithBackoff(tryHighlightFromHash)

FAB → Nova anotação → clique elemento → modal → salvar → GM_setValue
FAB → Ver anotações → painel + filtros → clique → url#kng=id → highlight + seek vídeo

Menu TM → Desativar → teardownUI() (dados intactos)
Menu TM → Ativar → setupUI() + watchers + highlight
```

---

## Modelo de dados (GM_setValue)

| Chave | Tipo | Descrição |
|-------|------|-----------|
| `kng_annotations` | `Annotation[]` | Todas as anotações globais |
| `kng_site_enabled` | `Record<hostname, boolean>` | Toggle por site (default `true`) |

```javascript
{
  id: "uuid-v4",           // mesmo id usado em data-kng-id na sessão
  title, description, tag,
  url, hostname, createdAt,
  videoTimestamp: number | null,
  anchor: { selector, markerId }
}
```

---

## Grants Tampermonkey

- `GM_setValue` / `GM_getValue`
- `GM_registerMenuCommand` / `GM_unregisterMenuCommand`

---

## API interna (referência rápida)

| Área | Funções principais |
|------|-------------------|
| Storage | `loadAnnotations`, `saveAnnotations`, `createAnnotation`, `deleteAnnotation`, `isSiteEnabled`, `setSiteEnabled` |
| Seletor | `generateSelector`, `validateSelector`, `injectEphemeralMarker` |
| Vídeo | `findNativeVideo`, `formatTimestamp`, `seekVideo` |
| UI | `createFAB`, `enterClickMode`, `exitClickMode`, `openCreateModal`, `openPanel`, `showToast`, `trapFocus` |
| Navegação | `parseHashId`, `findAnnotationById`, `resolveAnnotationElement`, `tryHighlightFromHash`, `retryWithBackoff`, `navigateToAnnotation` |
| Lifecycle | `setupUI`, `teardownUI`, `registerToggleCommand`, `registerUrlWatchers`, `init` |

---

## Limitações conhecidas

1. Seletores CSS podem quebrar após redesign do site
2. `data-kng-id` não persiste após F5 — reencontro via `anchor.selector`
3. Timestamp só em `<video>` same-origin (não iframe cross-origin)
4. SPAs lentas: retry 500ms / 1s / 2s antes de toast de falha
5. `@updateURL` / `@downloadURL` ainda com placeholder GitHub

---

## Instalação (dev)

1. Instalar [Tampermonkey](https://www.tampermonkey.net/)
2. Criar novo script → colar conteúdo de `knotacoes.user.js`
3. Salvar → abrir qualquer site → FAB 📝 canto inferior direito

---

## Próximos passos (humano)

1. Rodar matriz de testes T1–T17 em `checklist.md`
2. Criar repo GitHub, substituir URLs em `@updateURL` / `@downloadURL` / `@namespace`
3. Commit + smoke test via URL raw (fase 12)

---

## URLs de distribuição

```
@namespace    https://github.com/Caio-Angelis/knotacoesg
@updateURL    https://raw.githubusercontent.com/Caio-Angelis/knotacoesg/main/knotacoes.user.js
@downloadURL  https://raw.githubusercontent.com/Caio-Angelis/knotacoesg/main/knotacoes.user.js
@version      1.1.0
```

Instalação 1-clique no Tampermonkey: colar a URL `@downloadURL` ou importar do GitHub.
