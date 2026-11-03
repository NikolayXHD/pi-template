# R — как дочерняя сессия узнаёт имя агента, которым запущена

Исполнитель: helper-cloud-fast, 2026-10-14. Только чтение кода; отчёт.

Материалы: pi-subagents 0.78.0
(`/home/kolia/.pi/agent/npm/node_modules/pi-subagents`), pi-coding-agent 1.2.0
(`/home/kolia/.local/share/nvm/v26.2.0/lib/node_modules/@earendil-works/pi-coding-agent`),
pi-intercom 0.17.0 (для сверки одного соседского контракта). Метод:
`git grep -in` по репозиторию агента, точечный `grep -rn` по `src/`/`docs/` вне
git, чтение диапазонов. Каждое утверждение — по коду; ссылки — файл + символ,
без номеров строк и хешей.

## 1. Соответствие слов дизайна кодовым категориям

Слова «панели Herdr» и «демонные спавны» — не термины pi-subagents.
Сопоставление по коду:

- **«панели Herdr»** → pane-native запуски: `runs/shared/herdr-placed-run.js` →
  `createHerdrPiSession` / `HerdrPlacedRunOwner` +
  `extension/herdr-pi-bridge.js`. Процесс панели запускает сам Herdr
  (`workspace.create` / `tab.create` с env, затем `agent.start` с `pane_id`);
  pi-subagents только общается с ним по сокету и протоколу `HERDR_PI_PROTOCOL`
  (`runs/shared/herdr-pi-protocol.js`). Внешние CLI на машине —
  `runs/shared/herdr-external-adapters.js` (Herdr-панель, внутри — не pi).
- **«демонные спавны»** → отдельной сущности в коде pi-subagents нет:
  единственный «демоноподобный» отцепленный процесс пакета — фоновый раннер
  (`runs/background/async-execution.js` → `spawnRunner`, точки входа
  `subagent-runner.js` либо `binary-bootstrap.js`). Если design.md имел в виду
  демон Herdr, спавнящий процесс панели, — это тот же pane-native класс, что и
  «панели» (Herdr сам владеет процессом). Предложение для формулировки
  design.md: вместо «панели Herdr и демонные спавны» писать «pane-native
  запуски Herdr (`herdr-placed-run`, `herdr-pi-bridge`)» и отдельно
  «отцепленный фоновый раннер (`subagent-runner.js` / `binary-bootstrap.js`)».

## 2. Перечень каналов

### 2.1 Окружение процесса (`process.env`)

Что публикуется сегодня:

- `PI_SUBAGENT_CHILD=1` — ставит сам раннер при импорте модуля
  (`runs/background/subagent-runner.js`, верхнеуровневое присваивание
  `SUBAGENT_CHILD_ENV`). Это признак **процесса-хоста** детей, не сессии:
  у foreground-детей в процессе родителя его нет; у детей раннера он есть; в
  процессе родителя он же отсутствует, если родитель не сам является ребёнком.
- `PI_SUBAGENT_PARENT_SESSION` — `runs/background/async-execution.js` кладёт в
  `runnerEnv` при спавне раннера (значение `launchParentSessionId`); если
  значения нет — переменная удаляется. Только процесс раннера.
- `PI_SUBAGENT_EXTENSION_BINDINGS`, `MCP_DIRECT_TOOLS` — per-child окружение
  (`runs/shared/child-launch.js` → `childProcessEnv`), применяется
  `runs/shared/child-session.js` → `applyProcessEnv` в `open()`. Применяется
  только для `host === "runner"`: в конфиг сессии `processEnv` кладётся под
  условием `input.host === "runner"` в `buildInProcessChildLaunch`. Загрузка
  сессии и `session_start` сериализованы общим замком `loading` («от применения
  env до `session_start`»), но env процесса общий и не восстанавливается.
- `PI_SUBAGENT_RUNNER_CONFIG` — только bootstrap standalone-бинарника
  (`runs/background/binary-bootstrap.js`): читается и удаляется, файл конфига
  удаляется; у JS-раннера конфиг передаётся argv-файлом
  (`runs/background/subagent-runner-bootstrap.js`), файл тоже удаляется. До
  дочерних сессий конфиг с полем `agent` не доживает.
- `PI_SUBAGENTS_HERDR_BRIDGE` / `PI_SUBAGENTS_HERDR_RUN_ID` /
  `PI_SUBAGENTS_HERDR_RUNTIME_DIR` (`herdr-pi-protocol.js`, константы
  `HERDR_PI_MODE_ENV`, `HERDR_PI_RUN_ENV`, `HERDR_PI_RUNTIME_DIR_ENV`) — env
  панели Herdr; агента не несут. По `PI_SUBAGENTS_HERDR_BRIDGE` точка входа
  пакета (`index.js`) выбирает `herdr-pi-bridge.js`, а при
  `PI_SUBAGENT_CHILD=1` не регистрирует ничего.

**Имени агента нет ни в одной env-переменной.** Отдельно: pi-intercom 0.17.0
читает `PI_SUBAGENT_CHILD_AGENT` (и `PI_SUBAGENT_RUN_ID`,
`PI_SUBAGENT_CHILD_INDEX`, `PI_SUBAGENT_INTERCOM_SESSION_NAME`,
`PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR`) в `readChildOrchestratorMetadata`, но
писателя этих переменных в установленных пакетах нет — легаси-контракт без
реализации (проверено `grep -rn` по `npm/node_modules`: единственный файл —
`pi-intercom/index.ts` и его README).

API pi: `process.env` (фабрика расширения и `session_start`). Стабильность:
имена и семантика — внутренние конвенции pi-subagents; читать их стороннему
коду сегодня не на что, кроме `PI_SUBAGENT_CHILD`/`PI_SUBAGENT_PARENT_SESSION`
(док `docs/watchdog.md` у pi-subagents упоминает последнюю для environment-only
permission-расширений). Вывод: канал имени агента не даёт; это заготовка для
публикации (см. §4).

### 2.2 Системный промпт: `<active_agent name="…"/>`

Писатели:

- `runs/shared/child-launch.js` → `buildInProcessChildLaunch` строит
  `taggedPrompt` =
  `<active_agent name="${escapeXmlAttr(childAgentName)}"/>\n\n` + системный
  промпт; при `systemPromptMode === "replace"` он идёт в `systemPrompt`, иначе
  — в `appendSystemPrompt` (значит, при обоих режимах тег в итоговом промпте).
  Условие срабатывания — `input.systemPrompt` задан; и foreground
  (`execution.js` → `runSingleAttempt`, `systemPrompt` от
  `buildEffectiveSystemPrompt`), и фоновый раннер (`runner-child-launch.js` →
  `buildRunnerChildLaunch`, `step.systemPrompt ?? ""`) передают строку всегда.
- `extension/herdr-pi-bridge.js` → обработчик `before_agent_start` возвращает
  промпт с
  `\n\n<active_agent name=${JSON.stringify(resolvedContextPolicy.agent)}/>\n\n`
  — для pane-native сессий (агент приходит кадром `configure` от
  `herdr-placed-run.js` → `HerdrPlacedRunOwner.configure`).

API pi для чтения:

- `pi.on("before_agent_start", (event) => event.systemPrompt)` — публичное
  событие (`docs/extensions.md`, тип `BeforeAgentStartEvent`).
- `ExtensionContext.getSystemPrompt()` — публичный метод контекста
  (`dist/core/extensions/types.d.ts`, `ExtensionContext`). Для in-process детей
  тег доступен уже на `session_start`: загрузчик сессии создан с `systemPrompt`
  / `appendSystemPrompt` (`child-session.js`), а полный промпт собирается в
  конструкторе `AgentSession` (`dist/core/agent-session.js` →
  `_refreshToolRegistry` → `_setActiveTools` → `_rebuildSystemPrompt`;
  `dist/core/system-prompt.js` → `buildSystemPromptSections` кладёт
  `appendSystemPrompt` в секцию `addendum`, `buildSystemPrompt` рендерит
  текст). Для pane-native — только на/после `before_agent_start` (мост
  форсирует промпт).

Покрытие: foreground и фоновые in-process дети — всегда; pane-native (machine,
native pi) — если в панели вообще работает pi-расширение и мост получил
`configure`; внешние CLI — неприменимо (pi-сессии нет). Рекурсивные внуки
покрыты так же, как их хост-процесс (тот же конструктор запуска).

Стабильность: **внутренняя конвенция pi-subagents**, в `docs/` и README пакета
`active_agent` не упоминается (grep пуст); два независимых писателя используют
один и тот же тег и тот же логический `agent.name`/`step.agent`. Тег —
XML-атрибут, имя экранируется `escapeXmlAttr` (у моста — `JSON.stringify`).
Стрипперы промпта ребёнка (`subagent-prompt-runtime.js` →
`stripInheritedPromptText`, `appendChildBoundary`, `rewriteSubagentPrompt`) тег
не трогают. Риск: текст, а не API — смена формата/удаление тега не сломает
запуск, но лишит расширение идентичности; нужна самопроверка и предупреждение.

Вывод: **единственный существующий канал, дающий точное имя агента, без правок
pi-subagents и с самого раннего события (`session_start`) у in-process детей.**

### 2.3 Имя сессии (`session_info`)

Писатель: `runs/shared/subagent-prompt-runtime.js` — inline-хук ребёнка; на
`before_agent_start` вызывает `pi.setSessionName(childSessionName)`, где
`childSessionName` = `config.sessionName` (вычислен
`runs/shared/child-session-name.js` → `deriveChildSessionName` как
`agent: <выдержка задачи>` либо просто `agent`, обрезка до
`CHILD_SESSION_NAME_MAX_CHARS`) или intercom-имя
(`runs/intercom/intercom-bridge.js` → `resolveSubagentIntercomTarget`:
`subagent-<agent>-<runId>[-<index+1>]`, нижний регистр, санитизация), если
pi-intercom не «заклеймил» маршрут через `INTERCOM_SESSION_IDENTITY_EVENT`.

API pi для чтения (все публичные, `dist/core/extensions/types.d.ts`,
`dist/core/session-manager.d.ts`):

- `ctx.sessionManager.getSessionName()` / `pi.getSessionName()`;
- `ctx.sessionManager.getEntries()` / `getBranch()` — запись `session_info`
  (`SessionInfoEntry`, поле `name`);
- `pi.on("session_info_changed", (event) => event.name)` — эмитится из
  `AgentSession.setSessionName` (`dist/core/agent-session.js`).

Тайминг: на новом ребёнке имени на `session_start` ещё нет (запись появляется
на первом `before_agent_start`); порядок обработчиков — путь-расширения
грузятся раньше inline-хуков пакета (`dist/core/resource-loader.js` →
`loadFinalExtensionSet`: сначала `extensionPaths`, затем `extensionFactories`),
поэтому в собственном `before_agent_start` расширения имя ещё не установлено, а
`session_info_changed` приходит в том же событии. На resume (продолжение той же
дочерней сессии) имя уже лежит в файле и читается с `session_start`; на fork
ветка наследует историю родителя до точки ветвления (`SessionManager` →
`createBranchedSession`), поэтому унаследованное имя может быть именем
родительской сессии, пока prompt-runtime не перезапишет его на своём
`before_agent_start`.

Покрытие: foreground и фоновые in-process дети; pane-native и machine — нет
(мост `setSessionName` не вызывает); внешние CLI — нет.
Стабильность: pi API публичный, но содержимое имени — «display-only» метаданные
pi-subagents (комментарий `child-session-name.js`): пользователь может
переименовать сессию, intercom-форма зависит от pi-intercom, разбор строки —
эвристика. Вывод: запасной канал, не основной.

### 2.4 Путь файла сессии и файлы запуска

API: `ctx.sessionManager.getSessionFile()` / `getSessionDir()`.

Конвенции путей (внутренние): foreground — `getSubagentSessionRoot`
(`extension/index.js`, дубль в `extension/fanout-child.js`) даёт
`<каталог файла родителя>/<basename родителя>`, `subagent-executor.js` →
`sessionDirForIndex` (`run-N`) и `childSessionFileForTask` (`session.jsonl`);
фоновые — `async-execution.js` → `sessionDir = <sessionRoot>/async-<id>`. Имени
агента в пути сессии нет. Имя агента встречается в именах артефактов:
`shared/artifacts.js` → `getArtifactPaths` строит
`${runId}_${agent}${_index}_…` (`…_meta.json` и др.), а в сам metadata пишется
поле `agent` (`runs/foreground/execution.js` → `persistSingleResultMetadata`,
`runs/background/subagent-runner.js` → `persistStepArtifacts`). Но: артефакты
пишутся на detach/завершение попытки, отключаемы (`artifactConfig`), каталог
настраивается (`getArtifactsDir`: `session` / `project` / `temp`), привязка
требует сопоставления внутренних `runId`/индекса. У in-memory детей
(`sessionEnabled === false`) пути и артефактов нет.

Вывод: не канал идентификации; годится только как косвенная корреляция, и то
хрупко.

### 2.5 Записи сессии (`customType`)

На старте записи с именем агента нет. Существующие записи pi-subagents:

- `session_info` — см. 2.3;
- `subagent_watchdog_warning` (`watchdog/register-child.js` →
  `pi.appendEntry(SUBAGENT_WATCHDOG_WARNING_TYPE, childDetails)`, где
  `childWarningDetails` добавляет `agent` и `runId`) — только при
  предупреждении;
- ответы supervisor-канала (см. 2.6) — только при взаимодействиях.

API: `ctx.sessionManager.getEntries()` / `getBranch()`. Вывод: не канал
(факта на старте нет; ждать предупреждений нельзя).

### 2.6 Supervisor-канал

`runs/shared/child-runtime-config.js` → `childSupervisorMetadata` несёт
`agent`, `runId`, `childIndex`, `channelDir`, но читает его только inline-хук
`subagent-prompt-runtime.js`, который через
`intercom/native-supervisor-channel.js` → `registerNativeSupervisorClient`
регистрирует tool `contact_supervisor`. Каталог канала —
`runs/shared/child-tool-plan.js` → `supervisorChannelDir`:
`<TEMP_ROOT_DIR>/supervisor-channels/<runId>-<agent>-<childIndex>` — имя
каталога содержит агента, но публичного дескриптора для стороннего расширения
нет; в сессии видно лишь наличие tool `contact_supervisor` (при настроенном
orchestrator). Легаси-env `PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR` pi-intercom
читает, но никто не пишет. Вывод: не канал для сторонних расширений.

### 2.7 Шина `pi.events` и runtime-конфиг ребёнка

- `pi.events` — процесс-local; событий с идентичностью ребёнка нет.
  `subagent:acknowledge-extension` несёт только id расширения
  (`runs/shared/runtime-acknowledged-extensions.js`),
  `intercom:session-identity` — intercom-маршрут. `subagent:child-status`
  эмитится хостом, не ребёнком.
- `launch.runtime` (`ChildRuntimeConfig` с `agent`, `runId`, `childIndex`,
  `sessionName`, `supervisorChannelDir`, …) передаётся только inline-фабрикам
  pi-subagents (`runs/shared/child-hooks.js` → `createCapturedChildHooks`); в
  `createAgentSession` (`runs/shared/child-session.js`) он не входит — pi его
  не видит и расширению не отдаёт.

## 3. Матрица: что доступно каждому классу детей

Строки — по осям кода (host процесса, runner, placement); «+» — канал даёт имя,
«−» — нет.

Классы детей (ось — host процесса, runner, placement). Для каждого — что
доступно: env, тег `<active_agent>`, имя сессии, записи/файлы, supervisor,
грузится ли расширение.

**foreground, `host: "parent"` (native pi, процесс родителя).** Env —
нет (окружение родителя, `processEnv` не задаётся). Тег — да, с
`session_start`. Имя сессии — да, с `before_agent_start` (на resume — с
старта). Записи/файлы — нет (артефакты — после detach/финиша).
Supervisor — нет (внутренний дескриптор). Расширение: required и
configured грузятся, ambient — нет.

**фон, `host: "runner"` (отцепленный раннер: npm или standalone).** Env —
только маркеры процесса (`PI_SUBAGENT_CHILD`,
`PI_SUBAGENT_PARENT_SESSION`), имени нет. Тег — да, с `session_start`.
Имя сессии — да, с `before_agent_start`. Записи/файлы — нет.
Supervisor — нет. Расширение: required грузятся, ambient — если не
отключены агентом или потолком.

**machine / pane-native (native pi в Herdr-панели).** Env —
`PI_SUBAGENTS_HERDR_*`, имени нет. Тег — да, но только на
`before_agent_start` (мост). Имя сессии — нет. Записи/файлы — нет.
Supervisor — нет. Расширение: только ambient машины; локальные пути
расширений и required не переносятся (`serializeHerdrPiLaunch` бросает
при `extensionPaths`/`requiredExtensions`).

**внешние CLI, `runner.type: "external-cli"` (включая machine через
`herdr-external-adapters.js`).** Все каналы — нет; pi-сессии нет,
расширение не грузится.

Сценарии:

- **foreground**: то же, что первая строка; вложенные (внуки) — тот же набор,
  т.к. запуск идёт через тот же `buildInProcessChildLaunch` с собственным
  `childAgentName`. Env внуков в процессе родителя не помечает.
- **фоновый**: вторая строка; одна и та же для npm- и standalone-хоста
  (`subagent-runner.js` ставит `PI_SUBAGENT_CHILD=1`; `binary-bootstrap.js`
  лишь раньше читает/удаляет `PI_SUBAGENT_RUNNER_CONFIG`). Env — свойство
  процесса раннера, поэтому у нескольких детей одного раннера переменная одна и
  та же (имени агента в ней нет).
- **Herdr (панель, native pi)**: агент доезжает кадром `configure` до моста;
  расширение (если установлено на машине ambient) может прочитать тег только в
  `before_agent_start`. Required-расширения и локальные пути расширений
  pane-native переносить нельзя (`herdr-placed-run.js` →
  `serializeHerdrPiLaunch`; это не «тихо не развернулось», а отказ запуска при
  непустых `extensionPaths`/`requiredExtensions`). Для native-pi
  machine-запусков это значит: если у сессии-родителя зарегистрировано
  обязательное расширение, machine-запуск с `runner.type: "pi"` упадёт в
  `serializeHerdrPiLaunch`, а не останется без шаблонов.
- **machine (внешние CLI)**: четвёртая строка; идентификация расширению не
  нужна — его там нет; это граница применимости политики best effort design.md.
- **внешние job-провайдеры** (`runner.type: "external-job"`): как внешние CLI —
  pi-сессии нет, каналы неприменимы.

## 4. Что требуется, чтобы канал имени агента стал полным (публикация)

Если нужен явный контракт вместо чтения тега, точки правок такие:

- **env для детей раннера**: `runs/shared/child-launch.js` → `childProcessEnv`
  — единственное место per-child окружения; сюда по образцу
  `PI_SUBAGENT_PARENT_SESSION` кладётся переменная с именем агента. Готовое имя
  — `PI_SUBAGENT_CHILD_AGENT`: его уже читает pi-intercom 0.17.0
  (`readChildOrchestratorMetadata`), писателя нет. Покрывает детей, хостящихся
  в раннере.
- **env для foreground**: тот же `childProcessEnv`, но упирается в гейт
  `input.host === "runner"` в `buildInProcessChildLaunch`. Снятие гейта
  означает: `applyProcessEnv` (`child-session.js`) поменяет env общего процесса
  родителя без восстановления; читать значение можно только на старте запуска
  (фабрика / `session_start` — замок `loading` это гарантирует), позже env
  ненадёжен и «протухает». Это заметная цена и риск для процессов-родителей.
- **сессионная публикация для in-process детей**: в
  `runs/shared/subagent-prompt-runtime.js` (есть `config.agent` и runtime) на
  `session_start` — `pi.appendEntry(...)` с устойчивым `customType` или
  `pi.setSessionName`. Читается `getEntries()`/`getSessionName()`; покрывает
  foreground и фон одинаково, но требует согласованного имени записи (новый
  контракт в чужом коде) и правки pi-subagents.
- **pane-native/machine**: своя публикация в `extension/herdr-pi-bridge.js`
  (например, тот же `appendEntry`/`setSessionName`); сейчас мост публикует
  только тег. Локальные расширения и required в pane-native не переносятся
  (`serializeHerdrPiLaunch`), поэтому для шаблонного расширения класс остаётся
  вне гарантий.
- **внешние CLI**: публиковать некуда — pi-сессии нет.

Публичного места, куда можно приложить «payload к обязательному расширению»,
нет: `registerRequiredChildExtensions`
(`src/shared/required-child-extensions.js`) принимает только
`{ id, path }`/`requireForAllRunners` и не несёт данных о ребёнке.

## 5. Рекомендация

**Основной механизм — тег `<active_agent name="…"/>` из системного промпта.**
Расширение ребёнка читает:

- `ctx.getSystemPrompt()` в своём `session_start` (in-process дети: foreground
  и фоновые) — идентичность доступна до первого хода и до любых решений о view;
- `event.systemPrompt` в `before_agent_start` — для pane-native (там тег
  появляется только к этому событию) и как страховка для остальных.

Разбор: регулярное выражение по `<active_agent\s+name="([^"]*)"/>`; учесть, что
кавычки внутри имени экранируются писателями (`escapeXmlAttr` → `&quot;`, мост
→ `\"`), но имена агентов практически таким символам не подвержены. После
извлечения — сверка с `template.json`-доменом (имя агента — часть ключа
`@<имя>`); неизвестное имя — предупреждение, значение `@<имя>` не применяется,
значения `@` применяются. Покрытие классов: foreground — да; фон — да;
pane-native/machine — только best effort (как и политика design.md); внешние
CLI — неприменимо. Цена: **правок pi-subagents нет**; зависимость от внутренней
конвенции пакета — митигируется проверкой наличия тега и громким
предупреждением вместо тихого отката к машинным значениям.

**Запасной механизм — имя сессии.** `ctx.sessionManager.getSessionName()` (или
`pi.on("session_info_changed")`, или запись `session_info` через
`getEntries()`/`getBranch()`). Покрытие: foreground и фон; имя сессии строится
pi-subagents как `agent: <выдержка>` либо `subagent-<agent>-<runId>[-N]`,
поэтому имя агента извлекается эвристикой; на новом ребёнке канал приходит
позже (`before_agent_start`), на resume — сразу, на fork унаследованное имя
может быть именем родителя до первого `before_agent_start`. Цена: правок нет;
ограничения — display-only метаданные (переименование, intercom-форма), поэтому
только как запасной и для перекрёстной проверки основного.

**Если требуется жёсткий контракт** (а не чтение существующего факта) —
публикация имени агента в pi-subagents по §4: минимально
`PI_SUBAGENT_CHILD_AGENT` в `childProcessEnv` (имя уже ожидает pi-intercom)
плюс, при необходимости foreground, сессионная запись/имя из
`subagent-prompt-runtime.js`. Цена: правки в чужом коде и согласование с
пакетом; покрытие — in-process дети; pane-native и внешние CLI не закрываются в
любом случае. Для текущей итерации достаточно основного + запасного: оба
работают в тех классах, где шаблоны обязаны разворачиваться (in-process дети).

Порядок применения в реализации: тег → имя сессии → предупреждение «агент не
определён», значение субагента не применено (согласуется с «Провал рендера»:
молчаливой подмены нет).

## 6. Сверено и совпало

- `runs/shared/child-launch.js` → `buildInProcessChildLaunch` кладёт
  `agent: childAgentName` в конфиг запуска ребёнка (поле `config.agent` уходит
  в `session.runtime`), `sessionName`, а в lineage (`nestedParent.path`) —
  запись `{ runId, stepIndex, agent }`.
- Системный промпт ребёнка префиксуется `<active_agent name="…"/>`
  (`taggedPrompt`; при `replace` — в `systemPrompt`, иначе — в
  `appendSystemPrompt`); herdr-мост делает то же для панелей.
- `childSupervisorMetadata` несёт `agent`; `supervisorChannelDir` строится
  `supervisorChannelDir(runId, agent, childIndex)`.
- Env-публикация `PI_SUBAGENT_CHILD` / `PI_SUBAGENT_PARENT_SESSION` существует
  как прецедент; `applyProcessEnv` — механизм применения per-child env, замок
  `loading` сериализует «env → session_start».
- Имя сессии: `deriveChildSessionName` + `pi.setSessionName` на
  `before_agent_start` в `subagent-prompt-runtime.js`; запись `session_info`
  читается публичным `ReadonlySessionManager.getSessionName()`.
- Обязательные расширения: `registerRequiredChildExtensions` регистрирует
  `{ id, path }` на `sessionId`, грузится в ребёнке как обычный путь расширения
  (`additionalExtensionPaths`), путь-расширения загружаются раньше inline-хуков
  пакета.

## 7. Расхождения с ожиданиями спеки

1. **`applyProcessEnv` «даже для детей внутри процесса родителя»** — неточно.
   `applyProcessEnv` вызывается в `open()` и в процессе родителя тоже, но для
   foreground-детей `launch.processEnv` не задаётся вовсе: в
   `buildInProcessChildLaunch` поле `processEnv` кладётся под условием
   `input.host === "runner"`. Per-child env у foreground-детей отсутствует;
   «применяется даже в процессе родителя» верно лишь как описание того, где
   исполнялся бы код, если бы env был задан. Тот же вывод подтверждает
   `docs/watchdog.md` самого пакета: root и in-process foreground-хосты не
   публикуют общую parent-идентичность, «потому что несколько Pi-сессий могут
   делить один хост».
2. **`PI_SUBAGENT_RUNNER_CONFIG` «несёт конфиг раннера в фоновых детях»** —
   только для standalone-бинарника и только на bootstrap: переменная и файл
   конфига уничтожаются до старта дочерних сессий (`binary-bootstrap.js`); у
   JS-раннера конфиг идёт argv-файлом (`subagent-runner-bootstrap.js`) и тоже
   удаляется. Дочерние сессии этот конфиг не видят.
3. **`<active_agent>` «в одном из режимов»** — тег присутствует при обоих
   режимах (`replace` и `append`): меняется лишь то, в какой параметр
   загрузчика он попадает (`systemPrompt` против `appendSystemPrompt`),
   итоговый промпт содержит тег всегда. У Herdr-моста формат чуть иной
   (`name=` + `JSON.stringify`), но тот же атрибут.
4. **Имени агента нет ни в одной env-переменной**; `PI_SUBAGENT_CHILD_AGENT`
   существует только как ожидание pi-intercom без писателя.
5. **Публикация через обязательные расширения невозможна**:
   `registerRequiredChildExtensions` не несёт никакого payload, кроме
   `{ id, path }`.
6. **Machine-запуски native pi с обязательным расширением не «остаются без
   шаблонов», а падают**: `serializeHerdrPiLaunch` бросает при непустых
   `extensionPaths`/`requiredExtensions`. «Не валится» из design.md верно для
   внешних CLI (пи-сессии нет) и для случая, когда путей расширений у запуска
   нет.
7. **Слова «демонные спавны»** не находят отдельной сущности в коде (см. §1);
   предложение по формулировке design.md — там же.
