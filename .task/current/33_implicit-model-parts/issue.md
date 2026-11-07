# Переменная `llm_routing_provider` для моделей субагентов

## Постановка (@NikolayXHD)

Выбор агрегатора (`openrouter`, `caila`) должен задаваться в одном месте.
Ввести переменную `llm_routing_provider` со значением `caila` и заменить в
спецификациях субагентов `openrouter/*` и `caila/*` на
`{{llm_routing_provider}}/*`.

## Сделано

- `template.json`: `llm_routing_provider` со списком значений
  `openrouter`/`caila`, `initial=caila` — выбор доступен в меню `/template` и в
  кольце `ctrl+r`.
- `agents/helper-cloud-slow.md` был plain-файлом без источника — расширение его
  не рендерит, поэтому он стал `agents/helper-cloud-slow.md.template`
  (`git mv`).
- Провайдер через переменную в `model:` источников `helper-cloud-slow`,
  `helper-flash-glm`, `helper-flash-luna`, `helper-flash-mimo`,
  `helper-flash-qwen38`. В `description:` имени агрегатора нет: описание
  называет модель без провайдера (`b0e54fe`). `deepseek/deepseek-flash`,
  `vllm/*`, `strata/*` оставлены как есть: это не агрегаторы.
- `helper-flash-qwen38.md.template` объявлял `name: helper-flash-deepseek` —
  две спецификации с одним именем. Исправлено на `helper-flash-qwen38`.
- `is_flash` переведён на `model_id`: адреса без провайдера. Зависит от правки
  pi-template (неявные `model_provider`/`model_id`) — та лежит в рабочем дереве
  пакета и ревьюится отдельной задачей. Если правка не примет вид, `is_flash`
  возвращаем на `in model` с полными адресами, иначе конфигурация не соберётся.
  Правка была потеряна при переборках истории (см. «Замечено вне задачи») и
  восстановлена `@pi-agent` отдельным коммитом в pi-template.
- `agents/_partials/helper-contract.md`: перенос строки по замечанию `rumdl`
  (MD013), текст не менялся.

Отдельная находка: цель рендеринга не должна лежать в git. Через
`git rm --cached` выведена `agents/helper-cloud-slow.md`, в `.gitignore`
добавлена строка `/agents/helper-cloud-slow.md` — по образцу уже игнорируемых
`/agents/helper-flash-*.md`. Пока цель отслеживалась, `git checkout` возвращал
в неё старый адрес провайдера независимо от источника.

## Проверено

- Разбор реальной `template.json` движком: `caila/z-ai/glm-5.3-flash` и
  `openrouter/z-ai/glm-5.3-flash` дают `is_flash=true`,
  `caila/xiaomi/mimo-v2.6-pro` — `false`, `strata/qwen3.8-flash-next` и
  `vllm/QUASAR-QAT/…` — `true`.
- Заголовки всех источников спецификаций раскрываются в валидный YAML при
  `llm_routing_provider` равном и `caila`, и `openrouter`; адрес собирается
  целиком (`caila/z-ai/glm-5.3-flash`).
- `git grep -E '(openrouter|caila)/'` по `agents`, `roles`, `prompts`,
  `skills`, `template.json` — совпадений нет.
- Цели на диске отрендерены с `caila/…`, `{{` в целях не осталось.

## Живая проверка

- Перезапуск pi для `is_flash` формально не требуется: вью строится, цели
  свежие. Остаётся посмотреть строки `model_provider`/`model_id` и значение
  `is_flash` в меню `/template` — это проверка глазами, не правка.
- Дочерний прогон `helper-cloud-slow` (модель из переменной) запустился и
  вернул `PI_PROVIDER=caila`, `PI_MODEL=xiaomi/mimo-v2.6-pro`: адрес из
  `{{llm_routing_provider}}` доходит до процесса помощника.
- Флэш-адреса есть в реестре pi под обоими агрегаторами
  (`pi --list-models <запрос>`): `z-ai/glm-5.3-flash`, `openai/gpt-6-luna`,
  `xiaomi/mimo-v2.6-flash`, `qwen/qwen3.8-flash`, `minimax/minimax-m3.1-flash`,
  `deepseek/deepseek-v4.1-flash-1017`. Каталог caila читается из реестра;
  `wellKnownUrl` из `wellknown.json` отвечает 404, но на доступность моделей
  это не влияет.

## Нашлось при проверке

Помощники `helper-flash-*` не запускались: в `tools:` они выбирали
`mcp:browser-mux`, а в `mcp.json` сервер называется `browser-mcp-mux` (записи
`mcp:yandex_search/…` совпадали — имена серверов приводятся к подчёркиваниям).
Ошибка возникала до разбора модели. Исправлено в пяти источниках
(`f8b2ae3`), и флэш-помощник прошёл живой прогон: `helper-flash-glm` вернул
`PI_PROVIDER=caila`, `PI_MODEL=z-ai/glm-5.3-flash`.

Прогон заодно показал: правка источника спецификации доходит до дочернего
запуска без ручного «rewrite files on disk» — на чтении файла спецификации из
чужого процесса цель перерендеривается, и в цели оказался исправленный
селектор. Перерендер случился уже после правки `is_flash` на `model_id`, то
есть вью в этой сессии строится и с новой переменной.

## Откатанные шаги

- Модель помощника ревью. Попытка @pi-agent перенести её из
  `subagents.agentOverrides.reviewer.model` в форк
  `agents/reviewer.md.template` отклонена @NikolayXHD: копирование агент-файла
  пакета — действие с ценой (промпт отстаёт от обновлений пакета,
  `subagent({action: "reset"})` удаляет цель, а расширение рендерит её обратно
  из источника) ради экономии одной строки при редкой смене агрегатора. Форк
  удалён, `settings.json` совпадает с дорабочим состоянием. Цена: при смене
  агрегатора `agentOverrides.reviewer.model` правится вручную — единственное
  место с адресом субагента вне переменной.
- `enabledModels` @pi-agent правил к маскам `*/id` и вернул как было: настройка
  задаёт список выбора и переключения моделей сессии (docs/settings.md), к
  моделям субагентов отношения не имеет — pi-subagents разбирает их по
  `ctx.modelRegistry.getAvailable()`. Плюс pi сама дописывает туда
  `provider/id` при переключении модели (`setEnabledModels`,
  `_addPersistedDefaultToNonEmptyScope`).
- Попытка @pi-agent добавить в `AGENTS.md.template` раздел про форк ресурсов
  пакета отклонена @NikolayXHD, файл восстановлен из HEAD.

## Замечено вне задачи

Рабочее дерево `~/.pi/agent` живёт под параллельными переборками истории:
коммиты этой сессии схлопывались в другие хеши (`3627ccc`+`34512ad` →
`b473650`), а между 23:45 и 00:11 правки `template.json` и спецификаций исчезли
с чистым `git status`. `origin/master` отстал и одновременно обгоняет локальную
ветку на один коммит. Стоит проверить, кто и чем здесь крутит rebase — иначе
правки будут и дальше исчезать без следа.
