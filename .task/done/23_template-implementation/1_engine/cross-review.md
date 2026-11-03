# Кросс-ревью зоны A — движок `vars`/`render`

Кросс-ревью: helper-cloud-fast, 2026-10-15. Предмет — коммит `d48cecb`
в `/home/kolia/git/pi-template` (`vars.ts`, `render.ts`, `probe.mjs`,
`Makefile`; удалены `index.ts`, `config.ts`, `materialize.ts`), спека
зоны A (`1_engine/spec.md`), design.md задачи 23 (включая обновлённые
«Термины») и interview.md (В8), spec-a-engine задачи 22, форк
`/home/kolia/git/pi` (ветка `templating`) и pi-subagents.

Формат — только чтение и отчёт: `node probe.mjs` не запускался,
проверка статическая (см. «Остаточные риски»). Состояние: рабочая копия
пакета чиста и совпадает с `d48cecb`, ничего не застейджено; форк
`/home/kolia/git/pi` — на `main`, чистый; `package.json`,
`package-lock.json`, `TESTING.md` не тронуты.

## Находки

**critical и major — нет.** Ниже minor/nit; ни одна находка не ломает
критерии приёмки зоны.

### minor

1. **BOM не снимается при делении агентского файла** —
   `render.ts:120–125` (`splitAgentSource`). Комментарий ссылается на
   конвенцию pi, но pi перед проверкой `startsWith("---")` делает
   `stripBom` и `normalizeNewlines`
   (`packages/coding-agent/src/utils/frontmatter.ts`), а порт — нет.
   Файл агента с BOM получает `header === ""`: весь текст уходит в тело,
   `model@`/`level@` во frontmatter линтуются как тело (легальны), этап 1
   отдаёт пустую шапку. Последствие — молчаливо неверный двухэтапный
   рендер на входе, валидном для pi. Зафиксировано в отчёте исполнителя
   как остаточный риск; правка дешёвая (снять BOM или переиспользовать
   нормализацию pi).

2. **Предупреждение о поздней вычисляемой переменной не учитывает
   `@`-замещение** — `vars.ts:443–471`, решающая строка `vars.ts:464`
   (`isShellCommand(referencedSpec.initial)`). В сессии субагента
   переменная с `@`-ключом не вычисляется, и её значение уже лежит в
   окружении команды (первый проход кладёт его в `known`), а
   предупреждение утверждает «её значения не будет в окружении». Проверка
   должна опираться на `isComputedVariable(referencedSpec, agentName)`.
   Это шум предупреждений, не ошибка рендера. Зафиксировано в отчёте
   исполнителя.

3. **Таймаут убивает только сам шелл** — `vars.ts:297–313`:
   `child.kill("SIGKILL")` для процесса `sh -c` / `cmd.exe /c`. Если шелл
   не сделал exec последней команды (`cmd1; long_cmd`), внуки переживают
   таймаут и работают после того, как движок уже отдал «переменная без
   значения»; спекой и design это не оговорено. Унаследовано из форка;
   цена скрытая, в отчёте исполнителя не названа (там отмечено только,
   что POSIX-ветка и реальный таймаут проверены).

### nit

4. **Мёртвая константа** — `vars.ts:51`: `VARIABLE_SPEC_KEYS` нигде не
   используется (ключи обрабатываются ветками `parseVariableSpec`).
   Удалить.

5. **`name in implicit` вместо `Object.hasOwn`** —
   `vars.ts:217, 224, 228, 238`. Для имени, совпадающего со свойством
   `Object.prototype`, `in` даёт `true` без собственного ключа: статический
   `initial` или `@`-значение молча пропускается (`continue`), переменная
   остаётся пустой из финального заполнения. Сейчас недостижимо:
   `variableNameProblem` попутно отвергает такие имена (проверка коллизии с
   env ловит и унаследованные свойства), т.е. защита случайная. Рядом в
   `render.ts:147, 447` используется корректный `Object.hasOwn` —
   единообразие лучше.

6. **Молчаливый `catch`** — `render.ts:185–188`
   (`collectQualifiedNames`): `catch { return names; }`. После успешного
   линта путь недостижим, но это маскировка ошибки, противоречащая
   fail-loud-гарантии соседнего `requireSubagentValues`; лучше пробросить.

7. **Эвристика подсказки `[var@]`** — `render.ts:218–220`:
   `hasRawQualifier` матчит `x@` внутри любого тега, поэтому к посторонней
   parse-error может приклеиться подсказка про квалификатор (например, на
   литерале-почте). Влияет только на текст подсказки; зафиксировано
   исполнителем.

8. **Одно поле `partials` с двумя разными смыслами** — `render.ts:52, 77,
   88`: в `LintContext` это путь источника (нужно лишь существование), в
   `RenderContext`/`AgentRenderContext` — текст. Задокументировано в
   интерфейсах, но имя не коммуницирует разницу; при передаче контекстов
   в зонах B–D легко перепутать.

9. **Пустой успешный список делает динамический линт вырожденным** —
   `vars.ts:275` (`values[name] = parseShellLines(...)` может дать `[]`),
   `render.ts:587–591` (проверка только `=== undefined`),
   `render.ts:602–617` (`resolveConcatNames` по пустому списку даёт ноль
   имён, цикл проверки не срабатывает). Линт пропускает
   `{{> (concat "roles/" role ".md")}}`, а рендер позже либо бросает
   `партиал "" не определён`, либо рендерит имя, не покрытое статической
   проверкой. Спека случай не оговаривает; решение — приравнять `[]` к
   «без списка значений» в динамическом линте либо явно зафиксировать
   вырожденную семантику.

10. **`assertEqual` через `JSON.stringify`** — `probe.mjs:53–57`:
    значение `undefined` и отсутствующий ключ неразличимы (частично
    компенсировано явной проверкой `Object.keys` в
    `when_values_report_then_key_for_every_declared`); порядок ключей
    маскируется намеренно. Для проверок вида `report.values.bad_values`
    точнее `Object.hasOwn` / `deepStrictEqual`.

11. **`makeExecutor` по умолчанию «успех с пустым stdout»** —
    `probe.mjs:79–90`: команда, не описанная в таблице (например,
    опечатка в имени), не падает, а даёт пустой вывод; сценарий ловит это
    только через проверку значения. Строже — бросать на незнакомую
    команду.

12. **Точечные дыры покрытия** — `probe.mjs`: `[var@]` внутри
    динамического партиала проверен только линтом (рендер-сценария нет,
    хотя `partialName` резолвит ключ `role@`); переименованный ключ
    `current` не занесён в таблицу отказов отдельно (покрыт generic-
    случаем «неизвестный ключ»); не проверяются кавычечные формы `../` и
    абсолютного партиала; нет многострочного stdout для `firstShellLine`.
    Остальные пункты критериев приёмки покрыты (см. ниже).

## Сверено и совпало

Дельты к спеке A задачи 22 (по `1_engine/spec.md`):

1. Конфиг — `template.json` (`vars.ts:43`); `handlebars.json` и
   `roles.json` в движке не встречаются.
2. `current` → `initial`; формы строка / `{"shell"}` / `{"env"}` —
   `parseVariableSpec` (`vars.ts:361+`), сценарий
   `when_template_json_valid_then_all_fields_parsed`; лишние ключи в
   `{"shell"}`/`{"env"}` — ошибка.
3. Ключи `@`/`@<имя>` — только строки; `subagentValue` даёт цепочку
   `@<имя>` → `@` → (без ключей) `initial`/вычисление; замещают и
   машинное, и вычисленное (shell-команда субагентом не запускается);
   сценарии `when_subagent_value_resolved_then_name_over_any_over_initial`,
   `when_subagent_key_replaces_computed_then_no_shell_run`.
4. Неявные — только `model`/`level` (`vars.ts:49`); `PI_SUBAGENT_CHILD`
   и детекции дочерней сессии нет (grep чист); объявление `model`/`level`
   — ошибка конфига (`variableNameProblem`, таблица отказов).
5. Квалификатор `@`: запись `{{[var@]}}` / `{{[var@foo]}}` согласована
   (interview.md В8, внесена в design.md «Термины», подсказка в
   parse-error); линт `parseReference`/`checkQualifier`
   (`render.ts:392, 426`): вне `agents/**` — ошибка, в `agents/foo.md`
   только `var@`/`var@foo`, `model@`/`level@` и формы с именем — ошибка
   в шапке, легальны в теле; сценарии `when_legal_forms_then_lint_passes`,
   `when_rejected_forms_then_problem_reported`,
   `when_raw_qualifier_then_parse_hint`.
6. Двухэтапный рендер — шов `renderAgentHeader`/`renderAgentBody`
   (`render.ts:99, 108`), `agentView` (`render.ts:132`) кладёт `@`-ключи
   (`vllm@`, `vllm@foo`) поверх view родителя; `requireSubagentValues`
   (`render.ts:145`) бросает на пропуск значения субагента; YAML-разбор
   вне зоны A; сценарий
   `when_agent_file_two_stage_then_header_then_model_level_then_body` и
   `when_agent_subagent_value_missing_then_throws`.
7. Каноническая сериализация — `canonicalJson` (`vars.ts:346`), сценарий
   `when_canonical_json_then_stable_key_order`.
8. Значение субагента для вычисляемой переменной — замещает строкой и
   снимает read-only (`isComputedVariable` с `agentName`,
   `vars.ts:89`); без ключей субагент видит своё вычисление (сценарий
   `when_subagent_key_replaces_computed_then_no_shell_run`).

Критерии приёмки спеки — покрытие сценариями:

- разбор конфига (строгие ключи, формы `initial`, `@`-ключи, `cwd`,
  запрет `model`/`level`, коллизия с env) —
  `when_template_json_missing_then_empty_config`,
  `when_template_json_file_then_loaded`,
  `when_template_json_valid_then_all_fields_parsed`,
  `when_template_json_rejected_then_problem_reported` (15 явных случаев);
- shell-контракт: stdout/trim/дубликаты, exit, реальный таймаут с
  проверкой убийства (`~5 с`), окружение с view и порядок объявления,
  cwd-зоны, приоритеты и read-only —
  `when_shell_stdout_then_lines_trimmed_deduped`,
  `when_view_computed_then_initial_env_and_shell_values`,
  `when_command_starts_then_env_has_known_view_in_declaration_order`,
  `when_cwd_zones_then_command_runs_in_declared_dir`,
  `when_static_initial_overridden_then_override_wins_in_view_and_env`,
  `when_override_of_computed_then_problem_and_computed_value`,
  `when_shell_exit_nonzero_then_problem_and_no_value`,
  `when_shell_timeout_then_problem`,
  `when_commands_mention_later_computed_then_warning`;
- таблица отказов линта: `@` вне агентских, чужое имя агента, чужой
  квалификатор, `model@`/`level@` в шапке, динамические партиалы (чужой
  хелпер, необъявленный сегмент, без списка значений, отсутствие имени
  для значения, без сегментов), партиалы обоих корней (`..`, абсолютный,
  бэкслэш, ненайденный, кавычки) — `when_rejected_forms_then_problem_reported`;
- двухэтапный рендер, детерминированность
  (`when_render_repeated_then_same_text`), исключение на отсутствующем партиале
  (`when_partial_missing_or_lint_broken_then_render_throws`), каноническая
  сериализация — одноимённые сценарии;
- `report.md` на месте и содержит файлы, поведение, команды, вопросы
  (В1–В3) и риски. Проверяемое из В1–В3: форма `@` внесена в design.md и
  interview.md В8; regex имени агента совпадает с pi-subagents
  (`docs/configuration.md:250`, `src/extension/herdr-pi-bridge.js`:
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`); `package.json` не тронут.

Ловушки спеки:

- «`@` в идентификаторе» — прогон парсера и ask выполнены (В1/В8),
  незастёгнутая форма отвергается с подсказкой; форма не изобретена молча.
- Партиалы — два корня как разные пространства имён в одном реестре
  (имя уникально по построению), статическая форма путь/кавычки, запрет
  `..`/абсолютных/обратных слэшей, динамический — конечный список и
  существование имени для каждого значения.
- Хелперы — `eq` строгое (`left === right`), `in` с вырезанием options
  (`stringArgs`), собственный environment, `knownHelpersOnly`,
  `noEscape: true`, отсутствие партиала — исключение и на пре-проверке,
  и в рантайме Handlebars.
- Shell-контракт — системный шелл платформы, таймаут 5 с
  (`SHELL_TIMEOUT_MS`), stdout построчно, окружение процесса + view
  (неявные, `@`, статические `initial`, env, вычисленные ранее;
  независимо от позиции), имя переменной = env-имя, коллизия — ошибка,
  подстановки значений в текст нет, порядок объявления, повторных
  вычислений нет.
- Стиль — erasable TS (нет `enum`/`namespace`/parameter properties),
  нет `any`, локальные импорты с `.ts`; grep чист.
- Тесты — все 28 имён в форме `when_..._then_...`, варианты одного
  сценария — параметризованные таблицы внутри сценария, данные заданы
  явно; каркас `scenario`/`ok —`/`FAIL —` сохранён.
- Коммиты исполнитель не делал (по отчёту; `d48cecb` — ведущего),
  в рабочей копии не осталось ссылок на удалённые модули, кроме
  `TESTING.md` (см. ниже) и `package.json` (санкционировано В3).

Сверки против кода pi/pi-subagents:

- `THINKING_LEVELS` (`render.ts:43`) совпадает с `VALID_THINKING_LEVELS`
  pi (`cli/args.ts:61`, `virtual-models.ts:41`).
- Деление шапки (`startsWith("---")`, `indexOf("\n---", 3)`) повторяет
  конвенцию pi — кроме снятия BOM (находка 1).
- Исправление относительно форка: запрещённое read-only-переопределение
  удаляется из `known`/`view` и не просачивается в окружение следующих
  команд (`vars.ts:226–241`), есть регрессионный сценарий.
- Словарь публичных имён движка не выходит за design.md (переменная,
  машинное/вычисляемое значение, значение субагента, view, read-only,
  партиал/динамический партиал, квалификатор `@`, шапка/тело, уровень
  мышления); `template.json`/`values`/`initial`/`cwd`/`@` — из design.md;
  новых терминов не введено. `Makefile`: цель `materialize` и её
  переменные удалены, остался `deps` — как требует спека.

## Остаточные риски и известные состояния

- **Прогон `node probe.mjs` не подтверждён независимо**: формат
  кросс-ревью — только чтение, тесты не запускались. Статический разбор
  всех 28 сценариев расхождений не выявил, но «зелёность» остаётся на
  отчёте исполнителя (ALL OK, 28 сценариев, дважды).
- `package.json` указывает `pi.extensions` на удалённый `./index.ts` —
  решение В3 (оставить как есть), точка входа появится в зонах B/D.
- `TESTING.md` описывает старую ролевую механику (в т.ч. 31 сценарий и
  `make materialize`) — тема зоны D; до тех пор документ вводит в
  заблуждение.
- Типы не проверены компилятором (в пакете нет tsconfig/tsc) — по отчёту
  исполнителя; корректность подтверждена исполнением под Node.
- win32-ветка `cmd.exe /c` тестами не исполнялась; shell-сценарии
  probe (`sleep`, `false`, `ls`, `basename`) POSIX-специфичны — на win32
  probe не пройдёт.
- `handlebars` в `package.json` — `^4.7.10`, в lockfile — 4.7.10;
  выбранная форма `[var@]` опирается на поведение парсера 4.7.10.
- Рабочая копия пакета и форк чисты, коммит `d48cecb` — reviewers'
  baseline; ничего не застейджено.
