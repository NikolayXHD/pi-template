# R — детекция дочерней субагентской сессии существующими механизмами

Материалы и метод: пакет pi-subagents `npm/node_modules/pi-subagents`
(исходники `src/`, точка входа `index.js`, `docs/` — вспомогательно), форк pi
`/home/kolia/git/pi` (`packages/coding-agent/src/core/**`, `src/modes/**`).
Утверждения сверены с кодом (`git grep`, чтение диапазонов). Ниже — пути и
символы, без номеров строк и хешей.

Оговорка о форке: рабочее дерево форка содержит незакоммиченную правку
(`sdk.ts`, `agent-session.ts`, `resource-loader.ts`,
`agent-session-services.ts`, `main.ts`: `prepareContextDir`,
`contextIsMainSession`, `isMainSession`, `refreshContextDir`, `setVariable`,
каталог `src/core/templates/`). Это материал закрытого эксперимента, а не
механизм pi; отчёт на него не опирается. Все цитируемые ниже символы ядра — вне
этой правки (`bindExtensions`, `SessionManager`, `ExtensionContext`,
`DefaultResourceLoader`, режимы).

## 1. Как pi-subagents создаёт foreground-детей

Что значит «foreground-ребёнок»: pi `AgentSession`, созданная внутри процесса,
который владеет родителем; для foreground — в процессе родителя, для фоновых —
в процессе отцепленного раннера
(`npm/node_modules/pi-subagents/src/runs/shared/child-session.js`, заголовок
модуля и `createDefaultChildSessionFactory`).

Цепочка создания:

- `npm/node_modules/pi-subagents/src/extension/index.js` →
  `registerSubagentExtension` (в `index.js` пакета — выбор точки входа:
  `HERDR_PI_MODE_ENV` → herdr-мост, `PI_SUBAGENT_CHILD === "1"` → ничего, иначе
  — основной модуль расширения);
- `src/runs/foreground/subagent-executor.js` → executor →
  `src/runs/foreground/execution.js` → `runSingleAttempt` →
  `buildInProcessChildLaunch({ …, host: "parent" })`; фоновый раннер:
  `src/runs/background/runner-child-launch.js` → `buildRunnerChildLaunch` → тот
  же `buildInProcessChildLaunch({ …, host: "runner" })`;
- общий конструктор: `src/runs/shared/child-launch.js` →
  `buildInProcessChildLaunch`;
- создание сессии: `src/runs/shared/child-session.js` →
  `createDefaultChildSessionFactory().create`: `loadHostPiCodingAgent` →
  `new pi.DefaultResourceLoader(...)` → `loader.reload()` →
  `pi.createAgentSession(...)` (SDK, `packages/coding-agent/src/core/sdk.ts`,
  `createAgentSession`) → `session.bindExtensions({ mode: "print", onError })`.

Что получает дочерняя сессия:

- **launch-конфиг** (объект `session` из `buildInProcessChildLaunch`): `cwd`,
  `storage` (см. ниже), `model`, `tools`/`excludeTools`, `builtinMcpTools`,
  `extensionPaths`, `requiredExtensions`, `ambientExtensions`, `hooks`,
  `processEnv` (только для `host === "runner"`), `runtime` (типизированный
  `ChildRuntimeConfig`), `noSkills`, `noContextFiles`, `systemPrompt` /
  `appendSystemPrompt`;
- **runtime-конфиг** (`ChildRuntimeConfig` → `launch.runtime`, попадает только
  во внутренние inline-хуки и в планировщик инструментов): `cwd`, `runId`,
  `agent`, `childIndex`, `fanoutChild`, `sessionName`, `intercomSessionName`,
  `orchestratorTarget`, `orchestratorSessionId` и `parentSessionId` (оба из
  `input.parentSessionId`), `supervisorChannelDir`, `nestedRoute`,
  `nestedParent`, `runFanoutBudget`, `depth`, `maxDepth`, `capabilityCeiling`,
  `thinkingCeiling`, `requiredExtensions`, `inheritProjectContext`,
  `inheritGlobalContext`, `inheritSkills`, `forkCacheKey`, `permissions`,
  `toolBudget`, `childWatchdog`, `watchdogStatus`, `waitTool`,
  `structuredOutput`, `requiredTools`, `mcpDirectTools`, `fast`;
- **inline-хуки** (`src/runs/shared/child-hooks.js` →
  `createCapturedChildHooks`, `childHooks`): фабрики
  `pi-subagents:prompt-runtime`, `pi-subagents:fast-mode`,
  `pi-subagents:fanout-child`; им доступен `runtime`-конфиг, но это внутренние
  хуки pi-subagents, не публичный API для сторонних расширений;
- **id**: своего id сессии pi-subagents не передаёт; id генерирует pi
  (`packages/coding-agent/src/core/session-manager.ts` →
  `SessionManager.create` → конструктор → `newSession` → `createSessionId`),
  либо он берётся из существующего файла (`SessionManager.open`, resume/retry).
  Наружу в конфиге ребёнка лежат только `runId`, `childIndex`, `agent`,
  `sessionName`, `parentSessionId`;
- **переменные окружения**: для `host === "parent"` — никакие (env процесса не
  меняется; `applyProcessEnv` вызывается, но `launch.processEnv` не определён);
  для `host === "runner"` — `childProcessEnv` кладёт
  `PI_SUBAGENT_EXTENSION_BINDINGS` (`src/runs/shared/extension-bindings.js`) и
  `MCP_DIRECT_TOOLS` (константа `MCP_DIRECT_TOOLS_ENV`, `child-launch.js`),
  `child-session.js` → `applyProcessEnv` применяет их в процессе раннера перед
  загрузкой сессии (единый мьютекс `loading` — от применения env до
  `session_start`);
- **storage / каталог сессии** (`child-session.js` → `childStorage`): `file` —
  `SessionManager.open(launch.storage.sessionFile, undefined, launch.cwd)`;
  `dir` — `SessionManager.create(launch.cwd, launch.storage.sessionDir)`;
  `memory`; `default` — `SessionManager.create(launch.cwd)`. Пути
  foreground-детей: `getSubagentSessionRoot` (`src/extension/index.js`, дубль в
  `src/extension/fanout-child.js`) даёт
  `<каталог файла сессии родителя>/<basename файла родителя>`, далее
  `subagent-executor.js` → `sessionRoot = …/<runId>`,
  `sessionDirForIndex(idx) = <sessionRoot>/run-<idx>`,
  `childSessionFileForTask` = `…/run-<idx>/session.jsonl` (кроме fork —
  `src/shared/fork-context.js`, каталог `<…>/forks`); фоновые —
  `async-execution.js`: `sessionDir = <sessionRoot>/async-<id>`; при явных
  `sessionDir`/`defaultSessionDir` конвенция другая; `share !== true` и
  отсутствие файла/каталога дают `memory` (`execution.js` → `sessionEnabled`);
- **ambient-расширения**:
  `ambientExtensions = host === "runner" && !disableAmbientExtensions`;
  foreground-дети ambient-расширения не грузят вообще (`noExtensions: true` в
  `DefaultResourceLoader`), грузятся только `extensionPaths`
  (configured/tool/required);
- **свежесть модулей расширения**: `child-session.js` →
  `resetExtensionCacheOnReload` (пишет приватное поле `loaded` загрузчика)
  заставляет первый `reload()` ребёнка вызвать `clearExtensionCache`
  (`packages/coding-agent/src/core/extensions/loader.ts`), поэтому дочерний
  экземпляр расширения получает своё состояние модуля; `globalThis` при этом
  общий для процесса;
- **системный промпт**: `buildInProcessChildLaunch` → `taggedPrompt` добавляет
  `<active_agent name="…"/>` (при `systemPromptMode: "replace"` — в системный
  промпт, при `append` — в append-часть).

## 2. Существующие сигналы

### 2.1 env `PI_SUBAGENT_CHILD`

- константа: `src/runs/shared/child-runtime-config.js` → `SUBAGENT_CHILD_ENV`;
- устанавливает: `src/runs/background/subagent-runner.js` (верхнеуровневое
  `process.env[SUBAGENT_CHILD_ENV] = "1"`). Это свойство **процесса раннера**,
  а не сессии;
- читают: `index.js` пакета (при `"1"` расширение не регистрируется — «ambient
  копия pi-subagents в дочерней сессии остаётся инертной»),
  `src/extension/doctor.js` (диагностика «subagent process»),
  `src/extension/index.js` (при `session_start` рутового хоста: если процесс не
  child — удаляет `PI_SUBAGENT_PARENT_SESSION`);
- истинность: `1` — в процессе фонового раннера (в т.ч. в его дочерних
  сессиях); **отсутствует** в процессе родителя, значит отсутствует и у
  foreground-детей, и у внуков, запущенных из foreground-ребёнка. Обратный
  случай: раннер, запущенный как бинарный pi в `--mode rpc`
  (`async-execution.js`, `binary-bootstrap.js`), тоже несёт
  `PI_SUBAGENT_CHILD=1`, хотя это хост-процесс.

### 2.2 env `PI_SUBAGENT_PARENT_SESSION`

- константа: `src/runs/shared/child-runtime-config.js` →
  `SUBAGENT_PARENT_SESSION_ENV`;
- устанавливает: `src/runs/background/async-execution.js` в окружении спавна
  раннера (`runnerEnv`), значение
  `launchParentSessionId = ctx.parentSessionId ?? ctx.currentSessionId`; если
  значения нет — переменная удаляется; у рутовых хостов расширение её стирает
  (`src/extension/index.js`, `session_start`);
- читают: `src/extension/doctor.js`; доки `docs/watchdog.md` описывают её как
  адрес для environment-only permission extensions (forwarding `ask`); «root
  сессии значение игнорируют»;
- истинность: только у процесса фонового раннера; в foreground-процессах не
  выставляется. Одна переменная на процесс: у шага раннера и env, и
  `parentSessionId` в runtime-конфиге указывают на сессию-инициатора запуска
  раннера; у внука, запущенного из шага раннера, env по-прежнему указывает на
  инициатора, тогда как `parentSessionId` в его конфиге — на сессию-шаг
  (прямого родителя).

### 2.3 `childSupervisorMetadata`

- определение: `src/runs/shared/child-runtime-config.js` →
  `childSupervisorMetadata(config)`; поля: `channelDir`, `runId`, `agent`,
  `childIndex`, опционально `orchestratorTarget`, `orchestratorSessionId`,
  `childTarget`; возвращает `undefined`, если нет `supervisorChannelDir`,
  `runId`, `agent`, `orchestratorSessionId` или `childIndex`;
- читает только `src/runs/shared/subagent-prompt-runtime.js` (inline-хук
  ребёнка) → `src/intercom/native-supervisor-channel.js` →
  `registerNativeSupervisorClient` (регистрирует в ребёнке tool
  `contact_supervisor` и обменивается запросами через каталог
  `supervisorChannelDir`; каталоги `requests`/`replies` создаёт
  `child-launch.js`);
- стороннему расширению это поле не видно: конфиг передаётся только
  inline-фабрикам. Косвенно: наличие tool `contact_supervisor` в сессии
  означает настроенный канал (регистрируется только при metadata).

### 2.4 Прочие env-находки

- `PI_SUBAGENT_EXTENSION_BINDINGS` (`src/runs/shared/extension-bindings.js`):
  пишется в `childProcessEnv`, т.е. в окружение процесса раннера; читают
  внешние «contract binding»-расширения; foreground-детям не выставляется;
- `MCP_DIRECT_TOOLS` (`MCP_DIRECT_TOOLS_ENV`, `child-launch.js`): там же,
  раннер-only;
- `PI_SUBAGENTS_HERDR_BRIDGE`, `PI_SUBAGENTS_HERDR_RUN_ID`,
  `PI_SUBAGENTS_HERDR_RUNTIME_DIR` (`src/runs/shared/herdr-pi-protocol.js`) —
  herdr-ветка, вне итерации;
- семейство `PI_SUBAGENT_ORCHESTRATOR_TARGET`,
  `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID`, `PI_SUBAGENT_RUN_ID`,
  `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_CHILD_INDEX`,
  `PI_SUBAGENT_INTERCOM_SESSION_NAME`, `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR`:
  **читаются** пакетом `npm/node_modules/pi-intercom`
  (`readChildOrchestratorMetadata`, `nativeSupervisorChannelAvailable`), но
  записывающего кода в установленных пакетах не найдено; README pi-intercom
  описывает их как выставляемые pi-subagents — коду это противоречит (текущая
  передача метаданных ребёнку идёт через runtime-конфиг и файловый канал, см.
  2.3). Имя `PI_SUBAGENT_CHILD_AGENT` — не `PI_SUBAGENT_CHILD`;
- `PI_CODING_AGENT_PACKAGE_ROOT_ENV`, `JITI_ALIAS_ENV`,
  `PI_ASYNC_NATIVE_RUNNER`, `PI_SUBAGENT_RUNNER_CONFIG`, `PI_PACKAGE_DIR` —
  окружение спавна раннера, к детекции сессии отношения не имеют.

### 2.5 Наблюдаемые в ребёнке не-env следы (не поля pi)

- **имя сессии**: `src/shared/child-session-name.js` →
  `deriveChildSessionName`; `subagent-prompt-runtime.js` вызывает
  `pi.setSessionName` на `before_agent_start`; в записи сессии появляется
  `session_info` (`session-manager.ts` → `appendSessionInfo`/`getSessionName`);
  читается `ctx.sessionManager.getSessionName()`. Формат «agent: excerpt»,
  отображательный, зависит от конфига;
- **системный промпт**: `<active_agent name="…"/>` (см. §1); читается
  `ctx.getSystemPrompt()`;
- **путь файла сессии**: конвенция `getSubagentSessionRoot` + `runId`/`run-N`/
  `async-<id>`/`forks`; читается
  `ctx.sessionManager.getSessionFile()/getSessionDir()`;
- **записи сессии** (`customType`): `subagent_watchdog_warning`
  (`src/watchdog/register-child.js` → `pi.appendEntry`, запись в сессии
  ребёнка), `subagent_supervisor_reply` (`src/intercom/supervisor-ui.js` +
  `native-supervisor-channel.js`), `session_info` (имя). Появляются только при
  соответствующих взаимодействиях, не на старте;
- **файл обязательства**: `required-child-extensions.json` в `asyncDir`
  (`writeRetainedRequiredChildExtensions`/`readRetainedRequiredChildExtensions`)
  — запись о том, что запуск требует расширений; не про конкретную сессию.

## 3. `registerRequiredChildExtensions`: механика биндинга

Публичная поверхность (`package.json` → `exports`):
`./required-child-extensions` отдаёт только `registerRequiredChildExtensions` и
типы; `./preflight` принимает `parentSessionId` для проверок. Внутренний
`resolveRequiredChildExtensions` наружу не экспортируется.

Регистрация (`src/shared/required-child-extensions.js`):

- вход: `{ sessionId, extensions: [{ id, path }], requireForAllRunners? }`;
  `sessionId` — id родительской сессии; `id` ограничен шаблоном, `path` обязан
  быть существующим файлом и канонизируется (`realpathSync`), записей ≤ 32;
- снимок хранится в реестре процесса:
  `globalThis[Symbol.for("pi-subagents.required-child-extensions.v1")]` →
  `{ version: 1, bySession: Map }`; одна регистрация на `sessionId` (повтор —
  ошибка), `dispose()` удаляет; `requireForAllRunners: true` проставляется в
  снимок;
- публичного чтения для расширения-ребёнка нет: чтобы узнать, что сессия —
  «required child», стороннему коду пришлось бы обращаться к внутреннему
  реестру (`Symbol.for(...)`) или вести собственный учёт по `sessionId`.

Как снимок доходит до ребёнка:

- foreground: `subagent-executor.js` →
  `resolveRequiredChildExtensions(parentPiSessionId)` (id вызывающей сессии)
  либо `deps.childRuntime?.requiredExtensions`;
- фон: `async-execution.js` →
  `params.requiredExtensions ?? ctx.childRuntime?.requiredExtensions ?? resolveRequiredChildExtensions(launchParentSessionId)`;
  сериализуется в конфиг раннера/шаг (реестр в процессе раннера не
  спрашивается);
- `child-launch.js` → `resolvePiLaunchToolPlan`
  (`src/runs/shared/child-tool-plan.js`): пути required-расширений дописываются
  в `extensionArgs` **последними** (не вытесняются ни `extensions: []`, ни
  дефолтами агента), при `capabilityCeiling.denyExtensions` — ошибка запуска;
- `assertRequiredChildExtensionsAdmitted` отклоняет внешние runner-типы и
  machine-размещение, если есть `requireForAllRunners`; `src/api/preflight.js`
  отклоняет такой предпросмотр заранее (`parentSessionId` во входе);
  обязательный снимок пишется в `asyncDir/required-child-extensions.json` и
  учитывается при append/resume (`subagent-executor.js` →
  `readRetainedRequiredChildExtensions`);
- в ребёнке: `child-session.js` фильтрует runtime-пути
  (`isSubagentRuntimeExtensionPath`) и кладёт остальные `extensionPaths` в
  `additionalExtensionPaths` загрузчика; required-пути грузятся как
  **обычные файлы расширений** (при `noExtensions: true` у foreground-детей —
  только они и configured/tool-пути); после `reload()` проверяются ошибки
  загрузки именно required-путей; `bindExtensions` собирает ошибки их
  `session_start`; при ошибке загрузки/старта/регистрации провайдера ребёнок
  диспозится и запуск отклоняется.

Что получает экземпляр расширения при биндинге:

- фабрика вызывается как `factory(pi)` — только стандартный `ExtensionAPI`
  (`packages/coding-agent/src/core/extensions/loader.ts` →
  `createExtensionAPI`, `initializeExtension`): регистрация
  обработчиков/инструментов и действия; ни пути расширения, ни id сессии, ни
  конфига на этом этапе нет;
- контекст появляется в событиях (`ExtensionContext`,
  `packages/coding-agent/src/core/extensions/types.ts` → `ExtensionContext`,
  `createContext` в `extensions/runner.ts`): `ui`, `mode` (у детей —
  `"print"`), `hasUI` (у детей `false`), `cwd`, `sessionManager` (см. §4),
  `modelRegistry`, `model`, `scopedModels`, `thinkingLevel`, `isIdle()`,
  `isProjectTrusted()`, `signal`, `abort()`, `hasPendingMessages()`,
  `shutdown()`, `getContextUsage()`, `compact()`, `getSystemPrompt()`;
- ничего из этого не сообщает «ты загружен как required child extension»: факт
  загрузки по требуемому пути виден только хосту (`resolvePiLaunchToolPlan`,
  `projectLaunchResolvedChildExtensions` → `launchResolvedExtensions.required`,
  evidence статуса). Расширение в ребёнке может опереться только на сравнимость
  `ctx.sessionManager.getSessionId()`/`getSessionFile()` с собственным знанием
  о родителе, на env процесса или на внешние признаки из §2.5.

## 4. Что фиксирует pi о происхождении сессии

- **заголовок файла сессии**
  (`packages/coding-agent/src/core/session-manager.ts` → `SessionHeader`):
  `type`, `version`, `id`, `timestamp`, `cwd`, `parentSession?`;
- `parentSession` заполняется только при создании «ветки» от другой сессии:
  `newSession({ parentSession })`, `forkFrom`, `createBranchedSession`. У
  pi-subagents-детей заголовок пишется `SessionManager.create`/`open` без
  `parentSession` (обычный ребёнок), кроме fork-контекста (`fork-context.js` →
  `createBranchedSession`) и открытия сессии по `/new` с `parentSession` —
  тогда в заголовке остаётся путь исходной сессии;
- **состояние сессии** (`AgentSession`, `agent-session.ts`): `sessionManager`,
  `sessionId`, `sessionFile`, `cwd`, модель/уровень мышления; поля «основная»/
  «дочерняя»/«родитель» нет; у SDK-сессии (`createAgentSession`, `sdk.ts`) —
  те же поля, плюс опция `sessionStartEvent`, которая только задаёт событие
  `session_start` и нигде не персистится;
- **записи сессии**: pi ядро при создании новой сессии пишет `model_change` и
  `thinking_level_change` (`sdk.ts`); расширения пишут `customType`-записи и
  `session_info` (имя). pi-subagents не пишет записи, означающей «эта сессия —
  ребёнок»: его записи — `session_info` (имя, `subagent-prompt-runtime.js`),
  `subagent_watchdog_warning` (`watchdog/register-child.js`),
  `subagent_supervisor_reply` (`intercom/supervisor-ui.js`), причём только при
  соответствующих событиях;
- **каталог сессии**: default — `~/.pi/agent/sessions/<кодированный cwd>`
  (`getDefaultSessionDirPath`); `ReadonlySessionManager` (то, что видит
  расширение) отдаёт `getCwd`, `getSessionDir`, `getSessionId`,
  `getSessionFile`, `getLeafId`, `getLeafEntry`, `getEntry`, `getLabel`,
  `getBranch`, `buildContextEntries`, `getHeader`, `getEntries`, `getTree`,
  `getSessionName`. Метод `usesDefaultSessionDir()` в этот набор не входит.
  Каталоги pi-subagents-детей — конвенция пакета (см. §1), а не поле pi;
- **событие `session_start`** (`SessionStartEvent`): `reason` — `"startup"` |
  `"reload"` | `"new"` | `"resume"` | `"fork"`, плюс `previousSessionFile?`.
  Дети биндятся явным
  `sessionStartEvent: { type: "session_start", reason: "startup" }`
  (`child-session.js`); `"startup"` же — у первичного старта любой основной
  сессии (TUI/print/rpc, включая `-c`); `"new"`/`"resume"`/`"fork"` ставятся
  только сменой сессии внутри процесса (`agent-session-runtime.ts`);
- **`session_shutdown`**: `"quit"` при диспозиции ребёнка (`child-session.js` →
  `shutdownSession`), `"new"/"resume"/"fork"` — при смене сессии в процессе
  (`agent-session-runtime.ts` → `teardownCurrent`), `"quit"` — при выходе.

## 5. События и каналы

- шина событий pi создаётся на `DefaultResourceLoader`
  (`createEventBus`, `event-bus.ts`); дочерний загрузчик создаётся без
  `eventBus`, значит у каждой сессии своя шина (`api.events` в ребёнке —
  подписчики этой сессии, включая её inline-хуки);
- `subagent:child-status` (`SUBAGENT_CHILD_STATUS_EVENT`,
  `src/shared/types.js`): эмитится в **хостовом** процессе —
  `subagent-executor.js` (`deps.pi.events.emit`), `async-job-tracker.js`
  (читает файл событий раннера и переэмитит на шину родителя),
  `extension/rpc.js` (`options.events.emit`). Подписчиков внутри пакета нет —
  канал наружу (RPC-клиенты/интеграции). В ребёнке эти события не появляются;
- каналы, видимые ребёнку: `subagent:acknowledge-extension`
  (`runtime-acknowledged-extensions.js`; ребёнок эмитит `{ id }` на своей шине,
  слушает его inline-хук pi-subagents; доки `docs/observability.md` —
  «cooperating child extensions»), `intercom:session-identity`
  (`subagent-prompt-runtime.js` слушает в ребёнке, эмитит pi-intercom),
  `subagent:async-started` — локально в ребёнке про его собственные вложенные
  запуски (`fanout-child.js`);
- статус ребёнка идёт наружу не событиями, а прямыми вызовами/файлами:
  `childWatchdog.config.watchdogStatus` — колбэк в конфиге ребёнка
  (`child-hooks.js` → `registerChildWatchdog`), файловый канал supervisor
  (`native-supervisor-channel.js`, каталог `supervisorChannelDir`), файлы
  `async-*` у раннера;
- итог: из событий расширение в дочерней сессии **не может** узнать свой статус
  как ребёнка; ему доступны только его собственная шина (в т.ч. для
  `subagent:acknowledge-extension`) и события pi уровня сессии.

## Итог: сигналы по типам сессий

### foreground-ребёнок (в процессе родителя)

- env `PI_SUBAGENT_CHILD`: нет.
- env `PI_SUBAGENT_PARENT_SESSION`: нет.
- runtime-конфиг ребёнка: есть, но виден только inline-хукам pi-subagents.
- `ctx.mode` / `ctx.hasUI`: `print` / `false`.
- `session_start.reason`: `startup`.
- файл/каталог сессии: конвенция
  `<каталог файла родителя>/<basename родителя>/<runId>/run-N/session.jsonl`;
  возможны `memory`, `dir`, явный `sessionDir`.
- прочее: required-расширения грузятся, ambient — нет; `<active_agent>` в
  системном промпте; имя `session_info` к первому ходу; watchdog/supervisor
  записи — при событиях.

### фоновый раннер (отдельный процесс)

- env `PI_SUBAGENT_CHILD`: да (`1`, ставит сам раннер).
- env `PI_SUBAGENT_PARENT_SESSION`: да (сессия-инициатор раннера).
- runtime-конфиг ребёнка: есть; `requiredExtensions` сериализованы в конфиг
  раннера/шаг.
- `ctx.mode` / `ctx.hasUI`: `print` / `false`.
- `session_start.reason`: `startup`.
- файл/каталог сессии: `<sessionRoot>/async-<id>` (или
  `sessionFile`/`sessionDir` шага).
- прочее: грузятся и ambient-расширения, и required; env
  `PI_SUBAGENT_EXTENSION_BINDINGS`, `MCP_DIRECT_TOOLS` применяются в процессе
  раннера.

### вложенный спавн (внучатые)

- env `PI_SUBAGENT_CHILD`: как у процесса-хозяина (в процессе родителя — нет;
  в раннере — да).
- env `PI_SUBAGENT_PARENT_SESSION`: как у процесса (нет / инициатор раннера).
- runtime-конфиг ребёнка: есть; required наследуются через
  `inherited.requiredExtensions`; `parentSessionId` — сессия-родитель.
- `ctx.mode` / `ctx.hasUI`: `print` / `false`.
- `session_start.reason`: `startup`.
- файл/каталог сессии: по конвенции вложенного `runId`.
- прочее: в ребёнке живёт `fanout-child` со своим executor;
  `subagent:async-started` — локальная шина ребёнка.

### TUI `/new`, `/resume` (тот же процесс)

- env `PI_SUBAGENT_CHILD`: не меняется (значение процесса).
- env `PI_SUBAGENT_PARENT_SESSION`: не меняется.
- runtime-конфиг ребёнка: нет.
- `ctx.mode` / `ctx.hasUI`: `tui`.
- `session_start.reason`: `new` / `resume`, `previousSessionFile`; у старой —
  `session_shutdown` `new`/`resume`.
- файл/каталог сессии: новый файл в каталоге сессий; `parentSession` в
  заголовке — только если `newSession` передан `parentSession`.
- прочее: новый resource loader и новые экземпляры расширений; кеш фабрик
  расширений процесса может переиспользоваться.

### print/rpc-сессия (основная)

- env `PI_SUBAGENT_CHILD`: как у процесса.
- env `PI_SUBAGENT_PARENT_SESSION`: как у процесса.
- runtime-конфиг ребёнка: нет.
- `ctx.mode` / `ctx.hasUI`: `print`/`json` (`hasUI=false`), `rpc`
  (`hasUI=true`).
- `session_start.reason`: `startup` (в т.ч. `-c`).
- файл/каталог сессии: default каталог сессий.

### herdr-сессия

Статус: вне итерации. Отдельная точка входа `herdr-pi-bridge`; env
`PI_SUBAGENTS_HERDR_*`; перенос локальных required-расширений в pane-native
remote Pi невозможен.

Ключевые несовпадения с интуицией:

- любые дети (все три вида) биндятся с `mode: "print"`, `hasUI: false` — то же
  самое, что у основной print-сессии;
- `reason: "startup"` — и у ребёнка, и у первичного старта основной сессии;
- env-признаки описывают **процесс**, а не сессию: `PI_SUBAGENT_CHILD=1` верно
  для фонового раннера и неверно для foreground-ребёнка; при нескольких сессиях
  в процессе (переключение TUI) env не меняется; в процессе родителя
  `PI_SUBAGENT_PARENT_SESSION` принудительно стирается.

## Непокрытые случаи

- **Повторное открытие файла дочерней сессии как основной**
  (TUI/`-c`/`--resume` файла ребёнка): процесс новый, env-пометок нет,
  `mode: "tui"`, `reason: "startup"`, `parentSession` в заголовке — только у
  fork-веток; по сессии как таковой происхождение не видно (кроме конвенции
  пути и записей вроде `session_info`).
- **In-memory ребёнок** (`sessionEnabled === false`): нет файла и каталога
  сессии; остаются только runtime-конфиг и признаки процесса.
- **Явные `sessionDir`/`defaultSessionDir`, fork-сессии** (`<…>/forks`):
  конвенция пути «`<…>/<runId>/run-N`» не действует.
- **Момент установки имени сессии** — `before_agent_start`, не `session_start`:
  на первом же событии расширения имени может ещё не быть.
- **`registerRequiredChildExtensions` для сторонних потребителей**: публичного
  чтения «эта сессия — required-ребёнок» нет; реестр — внутренний (Symbol.for).
- **Статус из событий**: `subagent:child-status` (и контрол-события) доступны
  только хосту; ребёнку доступен лишь канал `subagent:acknowledge-extension`
  (эмиссия «я загрузился») и локальные события его собственных вложенных
  запусков.
- **Внуки в процессе родителя**: env не отличает их от основной сессии; связь с
  родителем существует только в runtime-конфиге (недоступном стороннему коду).
- **Бинарный раннер** — это pi-процесс в `--mode rpc` с `PI_SUBAGENT_CHILD=1`;
  rpc-режим и child-процесс совпадают в одном процессе.
- **herdr** — вне итерации (принято в дизайне); глубина не исследовалась.

## Вопросы к ведущему

1. Какой из существующих признаков (или их комбинация) считается для
   шаблонизатора фактом «сессия — дочерняя субагентская»: env
   `PI_SUBAGENT_CHILD` (процесс), «сессия не основная» (ведёт само расширение),
   видимость required-загрузки, путь/записи сессии? У каждого неполное покрытие
   (см. таблицу и «Непокрытые случаи»); нужен выбор семантики, а не имени.
2. Считать ли «детьми» внуков, запущенных из foreground-ребёнка (env нет), и
   сессии, открытые пользователем из файла дочерней сессии (происхождение не
   записано)? Решение о границе факта.
3. `registerRequiredChildExtensions` даёт ребёнку только загрузку файла; чтения
   «я загружен как required» нет. Достаточно ли вести учёт на стороне
   расширения по `sessionId` родителя и его собственным каналам
   (globalThis/файл/env), или требуется контракт в pi-subagents? Это изменение
   чужого публичного API — вне текущей зоны.
4. Нужно ли шаблонизатору повторять поведение pi-subagents «становиться
   инертным при `PI_SUBAGENT_CHILD=1`» (см. `index.js` пакета и комментарий в
   `child-runtime-config.js`), или в ребёнке он обязан работать? Это решение о
   поведении, а не деталь детекции.
5. Любой механизм, требующий нового имени (env, поле конфига, файл-метка,
   событие), остаётся за рамками отчёта: здесь только существующие имена и
   механики.
