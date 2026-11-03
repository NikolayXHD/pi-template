# Исследование: точки потребления и жизненный цикл pi

Вход для спеки зоны B. Чтение кода pi (`@earendil-works/pi-coding-agent` dist)
и pi-subagents (`src/`). Места указаны как файл + символ/функция, без номеров
строк. Символы pi-subagents в скомпилированном `dist`-виде; `*.map` в расчёт не
брался.

Исходники:

- pi: `dist/core/resource-loader.{js,d.ts}`, `dist/core/agent-session.js`,
  `dist/core/agent-session-runtime.js`,
  `dist/core/extensions/{types.d.ts,runner.js,loader.js}`,
  `dist/core/skills.js`, `dist/core/prompt-templates.js`,
  `dist/core/system-prompt.d.ts`, `dist/core/tools/bash.js`,
  `dist/core/nested-tool-calls.js`,
  `dist/modes/interactive/interactive-mode.js`, `dist/modes/rpc/rpc-mode.js`,
  `docs/*`; плюс `@earendil-works/pi-agent-core`
  `dist/{agent.js,agent-loop.js}` (зависимость pi, где живёт цикл хода и
  `runToolCall` — без неё вопрос 2 не закрывается).
- pi-subagents: `src/agents/agents.js`,
  `src/runs/shared/{effective-system-prompt.js,child-launch.js, child-session.js,subagent-prompt-runtime.js,nested-events.js}`,
  `src/runs/foreground/{execution.js,subagent-executor.js}`,
  `src/runs/background/{async-execution.js,subagent-runner.js}`,
  `src/extension/{index.js,fanout-child.js,public-execution.js}`,
  `src/shared/required-child-extensions.js`, `src/api/preflight.js`,
  `src/workflows/scripted-workflow.js`.

---

## Вопрос 1. Перечитывание ресурсов через `reload`

Механика: `AgentSession.reload()` (`agent-session.js`, метод `reload`) →
`ResourceLoader.reload()` (`resource-loader.js`, метод `reload`
`DefaultResourceLoader`). Последовательность:

1. `session_shutdown` с причиной `reload` шлётся старому рантайму
   (`emitSessionShutdownEvent`, `extensions/runner.js`), затем старый
   `ExtensionRunner` инвалидируется (`oldRunner.invalidate()`).
2. `settingsManager.reload()`.
3. `ResourceLoader.reload()`:
   - `clearExtensionCache()` (`extensions/loader.js`) — сброс jiti-кэша: модули
     расширений переимпортируются заново (новые экземпляры модулей, в-памяти
     состояние расширения утрачено);
   - `packageManager.resolve()` — разрешение пакетных ресурсов (git/npm);
   - расширения, скилы, промпты, темы перечитываются по разрешённым путям
     (`updateSkillsFromPaths`, `updatePromptsFromPaths`,
     `updateThemesFromPaths`);
   - контекстная цепочка, `SYSTEM.md`, `APPEND_SYSTEM.md` перечитываются
     (`loadProjectContextFiles`, `discoverSystemPromptFile`,
     `discoverAppendSystemPromptFile`, `resolvePromptInput`).
4. `_buildRuntime()` → новый `ExtensionRunner`, `_refreshToolRegistry()` →
   `_setActiveTools()` → `_rebuildSystemPrompt()` (`agent-session.js`) — из
   свежеперечитанных ресурсов собирается `_baseSystemPromptOptions`
   (contextFiles, skills, customPrompt, appendSystemPrompt, инструменты).
5. `session_start` с причиной `reload` шлётся новому рантайму (вызывается при
   наличии host-биндингов; в interactive и RPC-режимах
   `commandContextActions`/`shutdownHandler` связаны, включая `reload` —
   `interactive-mode.js` `handleReloadCommand`, `rpc-mode.js` `rebindSession`).
6. `extendResourcesFromExtensions("reload")` → событие `resources_discover`
   с причиной `reload` (только если есть обработчики) — расширение добавляет
   пути скилов/промптов/тем; при не-empty результате — ещё один
   `_rebuildSystemPrompt`.

События, которые расширение видит вокруг reload: `session_shutdown` (reason
`reload`), `session_start` (reason `reload`), `resources_discover` (reason
`reload`). Другого «ресурсы перечитаны»-события нет. `previousSessionFile`
для reload не несётся (только `new`/`resume`/`fork`).

Загруженные расширения: рантайм заменяется целиком (см. шаг 1, 4): старые
контексты ctx помечаются stale (сообщение об инвалидации в `dispose`/
`reload`), все инструменты/команды/обработчики регистрируются заново; MCP-
серверы перечитываются и переподключаются при старте сессии (docs/mcp.md:
«Pi connects every enabled server in the background when a session starts»).
Инструменты, новые в `defaultTools`, активируются (docs/slash-commands.md,
docs/settings.md). Цена перезагрузки: полный реимпорт расширений (jiti),
релод настроек, разрешение пакетных ресурсов, переподключение MCP, новый
`ModelRegistry`; TUI блокируется на время (индикатор «Reloading…»);
`/reload` доступно только вне стриминга и компакции
(`interactive-mode.js` `handleReloadCommand`: проверки `isStreaming`/
`isCompacting`). Для зоны B это важно: reload не может совпасть с ходом под
локом.

Доставка перечитанного содержимого в память pi: не мгновенная. На каждом
следующем ходе `_prepareRun` → `_preparePromptAndToolLoadout`
(`agent-session.js`) считает дельту секций системного сообщения
(`diffSystemPromptSections`, `buildSystemPromptSections` в `system-prompt.js`)
и вставляет в транскрипт системное сообщение с изменёнными секциями — так
provider видит новый текст. Момент чтения выбирает pi, как и предполагал
design.

### По каждому виду ресурса design.md

**Контекстные файлы** (цепочка `AGENTS.md`/`CLAUDE.md`, включая предков
cwd; в коде pi — `agentsFiles`): `loadProjectContextFiles`: кандидаты
`AGENTS.override.md`,
`AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` в каталоге агента и по
цепочке вверх от cwd (с правилом тенения worktree,
`findShadowedContextFile`); файлы читаются целиком. Попадают в промпт как
секция `contextFiles`; в транскрипт — дельтой секций на следующем ходе.

**`SYSTEM.md`.** `discoverSystemPromptFile`: `<cwd>/.pi/SYSTEM.md` (только
если проект trusted), иначе `<agentDir>/SYSTEM.md` (agentDir — `~/.pi/agent`,
`CONFIG_DIR_NAME` = `.pi`, `config.js`). Читается целиком
(`resolvePromptInput`). Явно заданный источник (опция `systemPrompt` в
конструкторе `DefaultResourceLoader` — так запускаются дети pi-subagents)
сохраняется в `systemPromptSource` и переживает reload (перерезолвится
заново, но из той же строки/пути).

**`APPEND_SYSTEM.md`.** Аналогично (`discoverAppendSystemPromptFile`); это
список источников, склеивается `\n\n`.

**Промпт-шаблоны** (кастомные промпты): `loadPromptTemplates`
(`prompt-templates.js`):
`.md`-файлы каталогов `<agentDir>/prompts` и `<cwd>/.pi/prompts` (+ пути,
добавленные расширениями). Содержимое читается целиком в память при
загрузке/reload; в системный промпт НЕ входит — расширяется при вызове
(`expandPromptTemplate`, `agent-session.js`) и в списке slash-команд. Зеркало
промпта видно pi только после reload (или `resources_discover`).

**Скилы (описания):** `loadSkills` (`skills.js`): корень определяется по
`SKILL.md`;
парсится frontmatter; в память попадают `name`, `description`, `filePath`,
`baseDir`, `disableModelInvocation` — **тело скила при загрузке не
читается**; в промпт идёт XML-список `<available_skills>`
(name/description/location) через `formatSkillsForPrompt`.

**Скилы (тела):** Читаются не при загрузке, а в середине хода инструментом
read
(модель читает файл по `location`). Reload тел не перечитывает — только
описания/список.

**`agents/*.md`** (промпты агентов pi-subagents): **Не ресурс pi**:
`reload` их не читает. В pi
`agentsFiles` — это цепочка `AGENTS.md`, не каталог `agents/`. Читает только
pi-subagents — см. вопрос 3.

**Расширения.** Полная замена рантайма (см. выше).

### Иной путь доставить содержимое без `reload`

Есть — и это расхождение с design.md («Лок-протокол»: «перечитывание —
единственный путь доставить содержимое в память pi»):

- Обработчик `before_agent_start` получает мутируемое
  `event.systemPromptOptions` (`NormalizedBuildSystemPromptOptions`:
  `contextFiles`, `skills`, `customPrompt`, `appendSystemPrompt`, `sections`,
  `selectedTools`, … — `extensions/types.d.ts` `BeforeAgentStartEventBase`,
  `system-prompt.d.ts` `BuildSystemPromptOptions`) и может вернуть полное
  `systemPrompt` на ход (форсированный промпт,
  `_installAgentForcedPromptProjection`) плюс custom-сообщение. Изменения
  применяются через дельту секций того же хода
  (`_preparePromptAndToolLoadout`). Это нативный путь походовой доставки: не
  требует reload, не меняет рантайм расширений. pi-subagents сам им пользуется
  каждый ход: секции `advertised_subagents` и `active_subagents`
  (`extension/index.js` `pi.on("before_agent_start")`).
- Ограничения этого пути: доставка привязана к началу хода (вне хода не
  действует); не обновляет потребителей вне промпта (slash-команды промпт-
  шаблонов, `/skill:`-список строятся из памяти загрузчика — туда только
  reload). Для зоны B: рендер + запись зеркал может сопровождаться
  походовой доставкой через `before_agent_start` вместо reload (дешевле);
  reload остаётся способом синхронизации потребителей вне промпта и
  перерегистрации расширений.

---

## Вопрос 2. Снятие лока при прерывании хода

Цепь исполнения инструмента (`pi-agent-core` `agent-loop.js` + хуки
`agent-session.js` `_installAgentToolHooks`):

- `prepareToolCall` → `validateToolArguments` → `beforeToolCall` (событие
  `tool_call` в расширения; блок/бросок → «immediate»-результат, инструмент
  не выполняется) → `executePreparedToolCall`:
  **`tool.execute(id, args, signal, onUpdate)` получает AbortSignal; таймаута
  исполнения нет** — await идёт до завершения `execute` (бросок ловится и
  превращается в error-результат).
- После завершения `execute` (и при «immediate»-путях не идёт дальше) —
  `finalizeExecutedToolCall` → `afterToolCall` → **событие `tool_result`**
  (`agent-session.js` `_afterToolCall`); затем цикл всегда эмитит
  **`tool_execution_end`** и toolResult-сообщение (`emitToolExecutionEnd`,
  `emitToolResultMessage`) — для всех финализаций, включая «Operation aborted»
  (abort в окне между `tool_call` и `execute`), блокировки, ошибки валидации,
  усечённые ответы (`failToolCallsFromTruncatedMessage`).
- Встроенные инструменты реагируют на сигнал: `bash` при abort убивает
  процессное дерево (`tools/bash.js` `exec`:
  `signal.addEventListener("abort", …)`); `read`/`edit`/`write` завершаются
  сами (быстрые).
- `abort()` сессии/агента просто спускает `AbortController` текущего run
  (`agent.js` `abort()`, `agent-session.js` `abort()`); цикл ждёт, пока
  выполняющиеся инструменты завершатся, следующий `streamAssistantResponse`
  сразу возвращает aborted-сообщение, run завершается, затем эмитится
  `agent_settled` с `aborted: true` (`agent-session.js` `_emitAgentSettled`).
- Сам pi опирается на эту механику: при замене сессии
  (`agent-session-runtime.js` `teardownCurrent`) «Settle any active response
  first so the aborted turn (including tool results) is persisted» —
  `session.abort()` и ожидание.

**Вывод (однозначный): точка снятия есть — событие `tool_result` (и шире —
`tool_execution_end`) шлются обработчикам расширений и для прерванного хода,
но только если `execute` инструмента завершился.** Для встроенных read/edit/
write/bash это гарантировано (они реагируют на сигнал). Гарантии, что
события придут «в любом случае», нет: если `execute` не завершится (инструмент
игнорирует сигнал), ни `tool_result`, ни `tool_execution_end`, ни
`agent_settled` не придут — цикл ждёт вешело, таймаута исполнения в pi нет;
остаются только собственные механизмы расширения (таймаут владения, маркер
владельца со сбросом протухших — по design).

Для зоны B — практические последствия:

- `tool_result` не шлётся на «immediate»-путях (инструмент не выполнялся: блок
  `tool_call`, бросок в `tool_call`-обработчике, abort в окне до `execute`).
  `tool_execution_end` шлётся на всех финализациях. Если скобка «лок на
  `tool_call`, снятие на `tool_result`» не снимает лок на этих путях, точка
  снятия лучше ставить на `tool_execution_end` (или на оба события). Вложенные
  `ctx.executeTool` проходят те же перехваты и эмитят `tool_execution_*` с
  `parentToolCallId` (`nested-tool-calls.js` — подтверждает design).
- Дополнительные точки снятия/контроля: `agent_settled` (на каждом конце хода,
  включая прерванные — sweep протухших лока), `session_shutdown` (reason
  `reload`/`quit`/`new`/`resume`/`fork` — до разбора рантайма), `reload`
  только при idle (не пересекается с локом хода).

---

## Вопрос 3. Точки чтения агентских файлов при спавне

Единая точка чтения: `discoverAgents`/`discoverAgentSnapshot`
(`pi-subagents` `src/agents/agents.js`): `readAgentDefinitionFiles`
(`fs.readFileSync` по `agents/**.md`) → `loadAgentsFromDefinitionFiles`
(frontmatter: name/description/… ; тело → `agent.systemPrompt`; плюс
`agent.filePath`). В памяти процесса — `agentDiscoveryCache` (ключ
cwd/provider/globalNpmRoot/projectTrusted; отпечаток — size/mtime подписи
watch-путь, `discoveryFingerprint`/`watchPathSignature`). Перезапись зеркала
(atomic write меняет mtime/size) даёт промах кэша; `refreshAdvertisedAgents`
явно вызывает `clearAgentDiscoveryCache()` на каждом `session_start`.

Построение промпта: `buildEffectiveSystemPrompt`
(`src/runs/shared/effective-system-prompt.js`) = `agent.systemPrompt` +
скил-инъекция + memory-инъекция + refinement-оверлей. Все вызовы — в процессе
спавняющего:

- `src/runs/foreground/execution.js` `runSyncCompletionInner` — фокусные
  синхронные запуски (одиночный агент, цепочки, параллельные шаги);
- `src/runs/background/async-execution.js` — async-single
  (`executeAsyncSingle`) и async-chain (пошагово,
  `executeAsyncChain`/`buildAsyncRunnerSteps`);
- `src/api/preflight.js` — preflight (считает effective-промпт и
  launch-контракт).

Готовая строка передаётся в конфиг запуска: `child-launch.js`
`buildInProcessChildLaunch` оборачивает промпт тегом
`<active_agent name="…"/>` (подтверждает конвенцию design) и кладёт в
`systemPrompt`/`appendSystemPrompt` сессии; `child-session.js` передаёт их
прямо в `new pi.DefaultResourceLoader({ systemPrompt, appendSystemPrompt })`
— в ребёнке это явные `systemPromptSource`/`appendSystemPromptSource`
(не нативное обнаружение, переживают reload ребёнка). На стороне ребёнка —
`subagent-prompt-runtime.js` (`registerSubagentPromptBoundary`:
`before_agent_start` форсирует финальный systemPrompt с границей ребёнка;
`filterChildPromptOptions` — урезание унаследованного контекста).
У детей pi: `noPromptTemplates: true`, `noThemes: true`, `noContextFiles`/
`noSkills` — по флагам унаследования.

### Полный перечень форм спавна и точки чтения агентского файла

Все формы читают файл через `discoverAgents` в процессе сессии-спавнера (кэш с
отпечатком mtime/size); построение промпта — `buildEffectiveSystemPrompt` там
же. Ни одна форма не перечитывает файл в процессе runner:

1. **Одиночный фокусный агент** (`subagent` tool, `agent`+`task`, sync):
   executor `subagent-executor.js` `execute` → `runSync`
   (`execution.js`) → `buildEffectiveSystemPrompt` в `runSyncCompletionInner`.
2. **Фокусная цепочка** (`.chain.md`, `chain`-параметр): шаги `step.agent`
   резолвятся `deps.discoverAgents` (`subagent-executor.js`, lookup по имени
   шага), последовательное исполнение тем же путём `runSync`.
3. **Параллельные шаги и динамический fanout** (статические `parallel`-группы,
   `step.expand`/`materializeDynamicParallelStep`): каждый материализованный
   резолвится `discoverAgents`; исполнение — параллельно в одном процессе,
   тот же путь.
4. **Workflow-скрипты** (`workflow`: именованный ресурс, путь к скрипту,
   inline-reply-блок, структурированные `tasks`/`chain`):
   `scripted-workflow.js` `runWorkflowScript` работает в процессе родителя;
   агенты шагов — `discoverWorkflowAgents` → `deps.discoverAgents`
   (`subagent-executor.js`), запуск шагов — через те же одиночный/async пути.
5. **Async (background) одиночный и цепочка** (`executeAsyncSingle` /
   `executeAsyncChain`): определения агентов резолвятся в родителе при старте
   (`agents.find` по `discoverAgents`), `systemPrompt` строится в родителе по
   каждому шагу; runner-процесс (`subagent-runner.js`) потребляет
   сериализованное `step.systemPrompt`/`step.systemPromptMode` (восстановление
   после abort — `planAbortRecovery` — тоже по сериализованным данным).
6. **Append к работающей async-цепочке** (`chain-append`): новые шаги через
   `buildAsyncRunnerSteps` в родителе (lookup `step.agent` —
   `subagent-executor.js`) — та же точка чтения.
7. **Вложенные вызовы (дети, у которых есть `subagent` tool)**:
   `fanout-child.js` `registerFanoutChildSubagentExtension` регистрирует tool
   в сессии-ребёнке; ребёнок резолвит `discoverAgents` своим процессом
   (свой кэш, свои зеркала-чтения) — те же пути 1–4 в дочернем процессе.
8. **Делегирование через supervisor-канал** (`executeDelegated`): исполняется
   в executor владельца в процессе владелицы — пути 1–4.
9. **Планируемые запуски** (`executeScheduled`, calendar): отдельный executor
   на владельца — пути 1–4.
10. **Внешние раннеры** (`runner.type` external-cli/external-job):
    `buildExternalCliPrompt(step.systemPrompt ?? "", task)` — сериализованная
    строка, новое чтение файла нет.
11. **Herdr: machine / pane-native**: агенты резолвятся при сериализации
    запуска (`herdr-pi-bridge.js` `discoverAgents`); ребёнок получает
    сериализованный конфиг; обязательные расширения с `requireForAllRunners`
    такие запуски не допускают (`required-child-extensions.js`
    `assertRequiredChildExtensionsAdmitted`) — подтверждает известное
    ограничение design.
12. **Каталог advertised-агентов в сессии-родителе** (особый потребитель —
    frontmatter, не тело): `extension/index.js` — на `session_start`
    `beginAdvertisement` → `refreshAdvertisedAgents`
    (`clearAgentDiscoveryCache` + `discoverAgents`, `advertise: true`);
    каждый ход `before_agent_start` кладёт каталог в секцию
    `systemPromptOptions.sections.advertised_subagents`. Т.е. агентские файлы
    читаются в родительской сессии не только на спавне: кэш-сверка frontmatter
    — на `session_start`, содержимое секции — на каждом ходе. Для зоны B:
    скобка рендера `agents/**` должна покрывать и этот потребитель (перезапись
    зеркала между `session_start`-ами не видна родителю до следующего
    `session_start` — срез кэша advertised зафиксирован на `session_start`).

---

## Сверено и совпало

- design («Лок-протокол»): перечитывание через `reload` перечитывает цепочку
  контекстных файлов, `SYSTEM.md`, `APPEND_SYSTEM.md`, описания скилов,
  промпт-шаблоны; момент входа в промпт выбирает pi (дельта секций на
  следующем ходе) — совпало.
- design: «reload заменяет рантайм расширений» — совпало (invalidation
  старого рантайма, `session_shutdown`, реимпорт jiti, новый
  `ExtensionRunner`).
- design: скобка `tool_call`/`tool_result`, вложенные `executeTool` проходят
  те же перехваты — совпало (`nested-tool-calls.js`, docs/extensions.md).
- design («Субагенты»): промпт ребёнка строится в процессе спавняющего
  (`buildEffectiveSystemPrompt`) и передаётся готовой строкой в конфиге
  запуска — совпало, места указаны выше (child-launch.js →
  `DefaultResourceLoader` опции в child-session.js).
- design: имя агента публикуется тегом `<active_agent name="…"/>` в системном
  промпте ребёнка — совпало (тег проставляется в `buildInProcessChildLaunch`).
- review.md: `registerRequiredChildExtensions` на `sessionId`,
  `requireForAllRunners` необязательное — совпало
  (`shared/required-child-extensions.js`).
- `/reload` при active session после правки скила — подтверждено
  (docs/skills.md; reload перечитывает `SKILL.md`-описания).
- reload только при idle — подтверждено (`handleReloadCommand`).

## Расхождения с ожиданиями

- **design.md: «перечитывание — единственный путь доставить содержимое в
  память pi» — неверно в буквальном виде.** Нативный походовой путь:
  обработчик `before_agent_start` мутирует `systemPromptOptions` (включая
  `contextFiles`, `skills`, `customPrompt`, `appendSystemPrompt`, секции) и
  возвращает форсированный `systemPrompt`; дельта секций уходит в промпт и
  транскрипт того же хода. pi-subagents этим уже пользуется каждый ход
  (секции `advertised_subagents`/`active_subagents`). Для зоны B: рендер +
  запись зеркал может доставляться этим путём вместо/наряду с reload (reload
  нужен для потребителей вне промпта: промпт-шаблоны как slash-команды,
  список `/skill:`, перерегистрация расширений).
- **design.md («Что pi читает само», «Лок-протокол»): `agents/*.md` —
  «нативное обнаружение» pi — неверно.** pi нативно читает `agentsFiles` =
  цепочку `AGENTS.md`/`CLAUDE.md` (в коде pi так и называется); каталог
  `agents/` pi не обнаруживает. Потребители `agents/*.md` — только
  pi-subagents: спавн (все формы, вопрос 3) и каталог advertised (frontmatter)
  в родительской сессии. Скобка лока на «агентский файл» ставится вокруг
  чтения pi-subagents (спавняющий процесс), а не вокруг перечитывания pi.
- **Скобка «лок на `tool_call`, снятие на `tool_result`» (design,
  «Лок-протокол») не закрывает «immediate»-пути:** при блокировке вызова
  обработчиком, ошибке обработчика `tool_call` и abort в окне между
  `tool_call` и `execute` — `tool_result` не шлётся, а `tool_execution_end` —
  да. Точка снятия должна покрывать `tool_execution_end` (вопрос 2).
- **design («Частота пересчёта view»): «агентские файлы в пересчёт на ходу не
  входят: единственный потребитель и точка рендера — спавн» — неполно.**
  Второй потребитель — advertised-каталог: респан в родительской сессии на
  `session_start`, секция обновляется на каждом ходе из зафиксированного
  среза. Перерисовка зеркала `agents/**` в середине сессии родитель не увидит
  до следующего `session_start` (если расширение само не обновит срез).

## Не проверено (явно)

- `packageManager.resolve()` — не читался; сеть/длительность разрешения
  пакетных ресурсов (git/npm) при reload не оценена количественно.
- Привязки `hasBindings` на reload проверены в interactive и RPC-режимах;
  print/json-режимы не проверялись (влияние: может ли `session_start(reload)`
  не прийти в узком host-режиме).
- `async-resume.js` не читался: предположение, что resume использует
  сериализованные шаги (без перечитывания файлов), подтверждено по
  `subagent-runner.js` (`step.systemPrompt`), а не по resume-модулю.
- Поведение pi при reload ребёнка с явным `systemPrompt`-источником (инлайн-
  строка): `resolvePromptInput` возвращает строку как есть; что происходит с
  длинной инлайн-строкой при перерезолве — не прослеживалось глубже
  (строка хранится в опциях загрузчика и переживает reload — по коду
  `reload`: `systemPromptSource` не перечитывается с диска).
- Встроенный `read`-инструмент при чтении зеркала проходит обычный файловый
  IO — сам по себе не читался (несущественно: для лока это точка `tool_call`/
  `tool_result` перехватов, уже покрыта вопросом 2).
