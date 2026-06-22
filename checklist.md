# Checklist KNotaçõesG — Userscript Tampermonkey

> Guia de execução do [`plano.md`](plano.md). Ordem pensada para **minimizar retrabalho**: fundação → utilitários críticos → UI → integração → testes.

---

## Decisões de ferramentas e abordagem

| Área | Escolha | Por quê |
|------|---------|---------|
| **Runtime** | Tampermonkey (Chrome/Firefox) | `@grant` nativo, menu por site, storage cross-origin sem extensão completa |
| **Formato** | Um único `knotacoes.user.js` (~400–550 linhas) | Instalação 1-clique, sem build step, fácil de versionar no GitHub |
| **Persistência** | `GM_setValue` / `GM_getValue` | Storage global entre sites; não depende de `localStorage` (bloqueado em alguns contextos) |
| **Reencontro de elemento** | CSS selector (`anchor.selector`) | Única estratégia que sobrevive a reload; `data-kng-id` só na sessão |
| **UI** | FAB + modais + CSS prefixado `.kng-*` | Impacto visual mínimo; sem Shadow DOM (overhead desnecessário para userscript) |
| **SPA / YouTube** | `hashchange` + `popstate` + wrap de `pushState`/`replaceState` | Cobre navegação sem reload; retry com backoff para DOM tardio |
| **Vídeo** | `<video>` nativo same-origin apenas | Same-Origin Policy impede iframe (YouTube em blog externo) — documentar, não lutar |
| **IDs** | `crypto.randomUUID()` (fallback manual se indisponível) | Padrão moderno, sem dependência externa |
| **Distribuição** | GitHub raw + `@updateURL` / `@downloadURL` | Atualização automática no Tampermonkey |
| **Dev / debug** | DevTools + `console.log` condicional (`DEBUG = false`) | Userscript não tem hot reload; flag de debug evita poluir produção |
| **Testes** | Manual estruturado (abaixo) | Sem bundler = sem Jest; testes E2E reais em sites variados valem mais |

**O que NÃO usar (e por quê):**

- ❌ Extensão Chrome completa — escopo maior, review da store, manifest v3
- ❌ `localStorage` / `indexedDB` — fragmentado por origin; anotações globais ficariam presas por site
- ❌ XPath — menos legível, pior suporte em SPAs dinâmicas
- ❌ Shadow DOM — complica injeção e seletores da página host
- ❌ Framework (React/Vue) — peso e build para ~500 linhas de UI simples

---

## Fase 0 — Preparação (antes de codar)

- [ ] **0.1** Instalar [Tampermonkey](https://www.tampermonkey.net/) no navegador principal *(manual)*
- [ ] **0.2** Criar repositório Git (opcional mas recomendado) para hospedar `knotacoes.user.js` e URLs de update
- [x] **0.3** Definir `@namespace`, `@author`, `@updateURL` e `@downloadURL` com URLs reais (placeholder quebra auto-update) — *placeholder em `knotacoes.user.js`; trocar na fase 12*
- [ ] **0.4** Abrir DevTools → aba **Sources** → localizar script injetado (para debug durante desenvolvimento) *(manual após instalar)*
- [ ] **0.5** Preparar **3 sites de teste** fixos:
  - Site estático simples (ex.: Wikipedia, MDN)
  - Site com `<video>` nativo (ex.: página HTML5 de demo ou site de curso)
  - SPA com URL dinâmica (ex.: YouTube)

---

## Fase 1 — Esqueleto e metadados

> Base que o Tampermonkey valida na instalação. Sem isso, nada roda.

- [x] **1.1** Criar `knotacoes.user.js` com bloco `==UserScript==` completo:
  - `@name`, `@namespace`, `@version`, `@description`, `@author`
  - `@match *://*/*`
  - `@grant GM_setValue`, `GM_getValue`, `GM_registerMenuCommand`
  - `@updateURL`, `@downloadURL`
- [x] **1.2** IIFE ou `'use strict'` no topo — evitar vazamento de variáveis para `window`
- [x] **1.3** Constantes globais do script:
  ```javascript
  const STORAGE_KEYS = { ANNOTATIONS: 'kng_annotations', SITE_ENABLED: 'kng_site_enabled' };
  const HASH_PREFIX = 'kng=';
  const DEBUG = false;
  ```
- [ ] **1.4** Instalar no Tampermonkey e confirmar que o script **aparece ativo** sem erros no console *(manual)*
- [x] **1.5** Função `log(...args)` que só imprime se `DEBUG === true`

**Critério de done:** script instalado, zero erros no console, grants aceitos pelo Tampermonkey.

---

## Fase 2 — Camada de storage

> Toda feature depende disso. Implementar e testar isoladamente antes de UI.

- [x] **2.1** `loadAnnotations()` → `GM_getValue(STORAGE_KEYS.ANNOTATIONS, [])`
- [x] **2.2** `saveAnnotations(list)` → `GM_setValue(...)` + retorno da lista salva
- [x] **2.3** `createAnnotation(payload)` → gera `id` (UUID), `createdAt`, `hostname`, `url` a partir de `location`
- [x] **2.4** `deleteAnnotation(id)` — opcional v1, mas útil para testes
- [x] **2.5** `isSiteEnabled(hostname = location.hostname)` → lê `kng_site_enabled[hostname]`, default `true`
- [x] **2.6** `setSiteEnabled(hostname, enabled)` → merge no record e persiste
- [ ] **2.7** Validar no console (temporariamente `DEBUG = true`):
  - Criar anotação fake → recarregar página → dado persiste
  - Desativar site → recarregar → flag persiste

**Critério de done:** CRUD mínimo funciona; dados sobrevivem reload; toggle por hostname persiste.

---

## Fase 3 — Utilitários de seletor (coração do projeto)

> **Implementar ANTES da UI de clique.** Seletor ruim = feature inteira inútil após reload.

- [x] **3.1** `validateSelector(sel, targetEl)` → `document.querySelectorAll(sel).length === 1` **e** nó === `targetEl`
- [x] **3.2** `generateSelector(el)` — estratégias em ordem:
  1. `#id` se único e estável (ignorar IDs gerados tipo `ember123`, `react-aria-*` — heurística: IDs com dígitos longos ou prefixos de framework)
  2. `[data-*]` nativos da página (excluir `data-kng-id`)
  3. `tag.class1.class2` se único no documento
  4. Subir árvore com `:nth-of-type()` / `:nth-child()` até `body`
  5. Fallback: caminho completo mesmo longo
- [x] **3.3** A cada candidato, chamar `validateSelector` antes de aceitar
- [x] **3.4** `injectEphemeralMarker(el, id)` → `el.setAttribute('data-kng-id', id)` — **somente sessão atual**
- [ ] **3.5** Testes manuais no console (antes de UI):
  - Clicar em `<h1>`, `<p>`, botão, item de lista → seletor resolve após reload
  - Elemento dentro de `#main` ou `[data-testid]` → preferir atributo nativo
  - Elemento profundo (5+ níveis) → caminho nth-child ainda único

**Critério de done:** em 5 elementos variados de um site real, reload + `querySelector(savedSel) === el` original.

---

## Fase 4 — Utilitários de vídeo

- [x] **4.1** `findNativeVideo()`:
  - Prioridade: vídeo em `document.activeElement` ou com `.paused === false`
  - Senão: primeiro `<video>` visível (`offsetParent !== null`, dimensões > 0)
  - Ignorar vídeos em iframe cross-origin
- [x] **4.2** `formatTimestamp(seconds)` → `"MM:SS"` (ou `"H:MM:SS"` se > 1h)
- [x] **4.3** `seekVideo(video, seconds)` → `currentTime = seconds`, `play().catch(() => {})`
- [ ] **4.4** Testar em página com `<video>` nativo: captura e formatação corretas *(manual)*

---

## Fase 5 — Estilos base (CSS injetado)

> Fazer cedo evita retrabalho visual. Prefixo `.kng-*` em tudo.

- [x] **5.1** Função `injectStyles()` — um `<style id="kng-styles">` no `<head>`
- [x] **5.2** Classes mínimas:
  - `.kng-fab` — botão flutuante (canto inferior direito, `z-index: 2147483646`)
  - `.kng-overlay` — semi-transparente, `cursor: crosshair`
  - `.kng-hover-target` — outline no hover durante modo clique
  - `.kng-modal`, `.kng-modal-backdrop`, `.kng-panel`
  - `.kng-pulse` + `@keyframes kng-pulse` (outline dourado, 3 ciclos ~3s)
  - `.kng-toast` — mensagens discretas de erro
- [x] **5.3** `!important` onde estilos host sobrescrevem (outline, z-index, position)
- [ ] **5.4** Verificar FAB visível sobre site escuro e claro (GitHub, Wikipedia) *(manual)*

---

## Fase 6 — UI builders

### 6A — FAB e menu de ações

- [x] **6.1** `createFAB()` — botão fixo, ícone ou texto "📝"
- [x] **6.2** Menu/popover do FAB com duas ações:
  - "Nova anotação (clique)"
  - "Ver anotações"
- [x] **6.3** `stopPropagation` / `preventDefault` em cliques do FAB e modais

### 6B — Modo clique (overlay)

- [x] **6.4** `enterClickMode()` — injeta overlay, listeners `mouseover` / `mouseout` / `click`
- [x] **6.5** Hover: aplicar `.kng-hover-target` no elemento sob cursor (ignorar nós `.kng-*`)
- [x] **6.6** Click: ignorar cliques em elementos do próprio script
- [x] **6.7** `exitClickMode()` — remove overlay e listeners (ESC para cancelar)
- [x] **6.8** `handleElementClick(el)` → `generateSelector` + `injectEphemeralMarker` → abre modal

### 6C — Modal de criação

- [x] **6.9** Campos: Título (required), Descrição, Tag (optional)
- [x] **6.10** Se `findNativeVideo()` retornar vídeo: preview "Timestamp: MM:SS"
- [x] **6.11** Botões Salvar / Cancelar
- [x] **6.12** Salvar → `createAnnotation` + `saveAnnotations` → toast de sucesso → `exitClickMode`

### 6D — Painel global

- [x] **6.13** `createPanel()` — modal lateral ou central grande
- [x] **6.14** Lista ordenada por `createdAt` desc
- [x] **6.15** Filtros:
  - Site (dropdown hostnames únicos)
  - Tag (dropdown + opção "Sem tag")
  - Checkbox "Somente com timestamp de vídeo"
- [x] **6.16** Cada item: título, hostname, tag, data formatada, timestamp se houver
- [x] **6.17** Click no item → `window.location.href = url + '#kng=' + id`

**Critério de done:** fluxo completo criar → ver no painel → filtrar funciona.

---

## Fase 7 — Highlight e navegação

> Integrar por último entre features — depende de storage, seletores e UI.

- [x] **7.1** `parseHashId()` → extrair id de `#kng={uuid}`
- [x] **7.2** `findAnnotationById(id)` → busca em `loadAnnotations()`
- [x] **7.3** `highlightElement(el)` → scroll suave + classe `.kng-pulse` removida após animação
- [x] **7.4** `tryHighlightFromHash()`:
  1. Parse hash
  2. Buscar anotação
  3. Resolver elemento: `querySelector(anchor.selector)` (principal)
  4. Atalho sessão: `[data-kng-id="{id}"]` se existir
  5. Se não achar → toast "Elemento não encontrado..."
  6. Se `videoTimestamp` → `seekVideo`
  7. `highlightElement`
- [x] **7.5** `retryWithBackoff(fn, delays = [500, 1000, 2000])` — para SPAs lentas
- [x] **7.6** Registrar gatilhos:
  - Execução imediata no init
  - `hashchange`
  - `popstate`
  - Wrap `history.pushState` e `history.replaceState` → chamar `tryHighlightFromHash` após cada call
- [ ] **7.7** Testar:
  - Reload com `#kng=id` na URL → destaque via **selector**, não `data-kng-id`
  - YouTube: navegar via painel sem full reload → destaque após retry *(manual)*

**Critério de done:** clicar anotação no painel leva ao elemento correto com animação; vídeo seek funciona quando aplicável.

---

## Fase 8 — Toggle por site (menu Tampermonkey)

- [x] **8.1** `registerToggleCommand()` via `GM_registerMenuCommand`
- [x] **8.2** Label dinâmico: "Desativar Anotações neste site" / "Ativar..."
- [x] **8.3** Ao desativar: `teardownUI()` — remove FAB, painel, overlay, styles (opcional manter styles)
- [x] **8.4** Ao ativar: `setupUI()` — reinjeta tudo
- [x] **8.5** **Não** apagar `kng_annotations` ao desativar
- [x] **8.6** Init: se site desabilitado → não injetar UI; ainda registrar menu command

**Critério de done:** desativar → FAB some → reload → continua off → reativar → FAB volta → anotações intactas.

---

## Fase 9 — Bootstrap (init)

- [x] **9.1** Ordem de init:
  1. `registerToggleCommand()`
  2. Se `!isSiteEnabled()` → return early
  3. `injectStyles()`
  4. `createFAB()` + append ao body
  5. Registrar URL watchers
  6. `tryHighlightFromHash()` (com retry)
- [x] **9.2** Guard contra double-init (flag `kngInitialized` ou checar `#kng-fab` existente)
- [x] **9.3** Comentário no topo do arquivo documentando limitações conhecidas (do plano)

---

## Fase 10 — Polimento e robustez

- [x] **10.1** Tratar edge cases:
  - Clique em `html` / `body` → ignorar ou avisar
  - Modal aberto + segundo clique no FAB → não duplicar modais
  - Navegação para URL de outro site via painel → init roda na nova página normalmente
- [x] **10.2** Acessibilidade mínima: `aria-label` no FAB, foco trap básico no modal (Tab não vaza para página)
- [x] **10.3** Remover logs de debug; `DEBUG = false`
- [x] **10.4** Revisar z-index: FAB < modal < toast
- [x] **10.5** Contagem de linhas ~400–550 — se passar muito, extrair blocos com comentários de seção (não criar arquivos extras) — *~1220 linhas; CSS inline; seções comentadas no arquivo*

---

## Fase 11 — Testes manuais (matriz completa)

| # | Cenário | Passos | Esperado | ✓ |
|---|---------|--------|----------|---|
| T1 | Instalação | Instalar script | Grants OK, sem erro console | ☐ |
| T2 | FAB visível | Abrir site qualquer | FAB canto inferior direito | ☐ |
| T3 | Criar anotação | FAB → clique → elemento → form → salvar | Salva, toast OK | ☐ |
| T4 | Painel lista | FAB → Ver anotações | Item aparece com metadados | ☐ |
| T5 | Filtro site | Filtrar por hostname | Só anotações daquele site | ☐ |
| T6 | Filtro tag | Filtrar tag + "Sem tag" | Filtragem correta | ☐ |
| T7 | Filtro vídeo | Checkbox timestamp | Só anotações com vídeo | ☐ |
| T8 | Navegar + highlight | Click item no painel | Redirect + scroll + pulse | ☐ |
| T9 | Reload + hash | URL com `#kng=id` → F5 | Elemento encontrado via **selector** | ☐ |
| T10 | Vídeo nativo | Anotar com `<video>` na página | Timestamp salvo e exibido | ☐ |
| T11 | Vídeo iframe | Blog com embed YouTube | Timestamp **não** capturado (OK) | ☐ |
| T12 | Seek vídeo | T8 em anotação com timestamp | Vídeo pula para momento | ☐ |
| T13 | SPA YouTube | Criar + navegar via painel | Highlight sem full reload | ☐ |
| T14 | Elemento removido | Anotar → mudar DOM → navegar | Toast "Elemento não encontrado" | ☐ |
| T15 | Toggle off | Menu TM → desativar | FAB some, dados persistem | ☐ |
| T16 | Toggle on | Reativar | FAB volta | ☐ |
| T17 | Cross-site | Anotar site A, ver painel em site B | Painel mostra todas globalmente | ☐ |

---

## Fase 12 — Publicação

- [ ] **12.1** Commit `knotacoes.user.js` no repositório
- [ ] **12.2** URL raw do GitHub funcional (`raw.githubusercontent.com/...`)
- [ ] **12.3** Atualizar `@updateURL` e `@downloadURL` no script
- [x] **12.4** Bump `@version` seguindo semver (`1.0.0` → `1.0.1` para fixes) — *versão `1.0.0` release inicial*
- [ ] **12.5** Instalar via URL no Tampermonkey de uma máquina limpa — smoke test T1–T3 *(manual)*

---

## Ordem de implementação recomendada (resumo)

```
Metadados → Storage → generateSelector → Video utils → CSS
    → FAB → Overlay/click mode → Modal criar → Painel
    → tryHighlightFromHash + URL watchers → Menu toggle → Init → Polimento → Testes
```

**Dependências críticas:**

- UI de clique **depende** de `generateSelector` + storage
- Painel **depende** de storage
- Highlight **depende** de seletores + storage + (opcional) video utils
- Toggle **depende** de teardown/setup da UI — implementar por último

---

## Riscos e mitigações

| Risco | Mitigação |
|-------|-----------|
| Seletor quebra após redesign | `generateSelector` multi-estratégia + `validateSelector`; toast honesto ao falhar |
| SPA renderiza DOM tarde | Retry 500ms / 1s / 2s antes de desistir |
| YouTube recria nós | Seletor baseado em estrutura estável (`#content`, `#description`); aceitar imperfeição |
| Autoplay bloqueado no seek | `play().catch(() => {})` — seek ainda funciona, usuário dá play manual |
| IDs dinâmicos de framework | Heurística para ignorar IDs instáveis; preferir `data-*` nativos |
| CSP do site | Tampermonkey injeta em contexto privilegiado — raramente problema; documentar exceção |
| Script roda 2x | Guard `kngInitialized` no init |

---

## Definition of Done (projeto completo)

- [x] Um arquivo `knotacoes.user.js` autocontido instalável
- [x] Todas as fases 1–11 concluídas *(código; testes manuais T1–T17 pendentes)*
- [ ] Matriz de testes T1–T17 com ✓ *(manual)*
- [x] Limitações documentadas no código
- [ ] `@updateURL` apontando para URL real (fase 12)
