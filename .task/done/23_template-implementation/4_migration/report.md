# Отчёт зоны D — миграция живого окружения и документация

Исполнитель: helper-cloud-fast. Зоны записи — пакет
`/home/kolia/git/pi-template` и мигрируемые файлы `/home/kolia/.pi/agent`
(только по списку спеки); отчёт и бэкап — в директории задачи. Коммиты не
делались, ничего не застейджено; push не делался — остановка на «готово»
(D.3 за ведущим).

## D.0. Бэкап

Каталог `.task/current/23_template-implementation/4_migration/backup/`,
структура живого каталога сохранена (`cp -a --parents` из
`/home/kolia/.pi/agent`):

- `roles.json`, `AGENTS.md`, `.gitignore`;
- `roles/*.md` (7 файлов ролей — их правит миграция партиалов);
- `roles/materialized/**` (13 файлов — удаляемый каталог);
- `skills/{forgejo-review,gantt,tuicr}/SKILL.md`;
- `prompts/*.md` (6);
- `agents/*.md` (3).

Проверка полноты: `cmp` по всем 22 плоским файлам — расхождений нет;
`diff -r roles/materialized backup/roles/materialized` — идентично.

## D.1. Миграция источников

Перечень миграций (файл → файл; зеркало генерируется):

- `roles.json` → `template.json`: новый контент — `role.values.shell` =
  `basename -s .md roles/*.md`, `initial` = `preflight`; `default` и
  `cycle` ушли;
- `AGENTS.md` → `AGENTS.md.template`: в конец добавлена строка
  `{{> (concat "roles/" role ".md")}}` (роль — в конце промпта, как
  дописывала прежняя механика);
- `SYSTEM.md`, `APPEND_SYSTEM.md` → не мигрировали: файлов в каталоге нет
  (и в истории git не было) — по решению ведущего миграция пропущена,
  файлы не создавались;
- `skills/*/SKILL.md` → `skills/*/SKILL.md.template`: 3 скила, содержимое
  не менялось;
- `prompts/*.md` → `prompts/*.md.template`: 6 промптов, содержимое не
  менялось;
- `agents/*.md` → `agents/*.md.template`: 3 агента, содержимое поправлено
  (см. ниже);
- `roles/materialized/**` → удалён (13 файлов);
- `.gitignore` → `.gitignore`: добавлены зеркала, убрана строка
  `/roles/materialized/`;
- `roles/design.md`, `develop.md`, `discuss.md`, `preflight.md` — те же
  файлы: 11 статических партиалов переписаны на пути от корня
  (`{{> interview_discipline.md}}` →
  `{{> roles/snippets/interview_discipline.md}}` и т.п.).

`settings.json` не правился: он уже указывает на
`git:github.com/NikolayXHD/pi-template`.

### Роли и партиалы (решение ведущего)

Спека говорила «`roles/**` не трогать», но короткие имена партиалов новый
движок не резолвит (имена — путь от корня; проверено запуском:
`партиал "interview_discipline.md" не найден`, зеркало `AGENTS.md` не
рендерилось). По подтверждению ведущего переписаны имена 11 ссылок в 4
файлах ролей (design ×3, develop ×3, discuss ×1, preflight ×4); сами
файлы и остальное содержимое не трогались.

### Строгий YAML источников (решение ведущего)

Первый рендер упал на всех трёх агентских файлах: `description: Помощник
на … модели: выполняет задачи …` — «: » внутри значения, строгий
`parseFrontmatter` pi даёт `Nested mappings are not allowed in compact
mappings`; `renderAgentFile` извлекает `model`/`level` через тот же
строгий парсер, поэтому зеркала агентов не генерировались. По
подтверждению ведущего `description` взят в кавычки в трёх файлах
(по одной строке):

```text
description: "Помощник на быстрой облачной модели: выполняет задачи teamlead по спеке"
```

Лояльный парсер pi-subagents (`npm/pi-subagents/src/agents/frontmatter.js`)
снимает окружающие кавычки — описание для потребителя не меняется; строгий
`parseFrontmatter` после правки читает `name`/`model`/`thinking`. Общее
правило миграции (зафиксировано ведущим): источники приводятся к строгому
YAML — контракт валидации из design.md; проверены все источники со
frontmatter: скилы (3), промпты (6) — валидны без правок, роли
frontmatter не имеют.

### `.gitignore`

Добавлены зеркала (с якорями, в стиле файла):

```text
/AGENTS.md
/SYSTEM.md
/APPEND_SYSTEM.md
/skills/*/SKILL.md
/prompts/*.md
/agents/*.md
```

Убрана мёртвая строка `/roles/materialized/` (каталог удалён этой же
миграцией) — решение ведущего.

### Первый рендер зеркал

Одноразовый скрипт `/tmp/d-render-mirrors.mjs` (в пакет не включён):
`loadVarsConfig` → `computeView` → `discoverSources`/`discoverPartials` →
`renderSources`/`renderSource` тем же кодом пакета, что и сессия;
`parseHeader` — `parseFrontmatter` pi; view — дефолты живого
`settings.json` (`deepseek/deepseek-flash` + `max`); projectDir —
пустой временный каталог; обрабатываются только источники под каталогом
агента. Запись — атомарная (`*.tmp` + rename), только при расхождении.

Сгенерировано 13 зеркал: `AGENTS.md` (роль `preflight` в конце, роль
рендерится с `roles/snippets/**`), `agents/*.md` (3), `prompts/*.md` (6),
`skills/*/SKILL.md` (3). Проверки:

- сырых тегов `{{` в зеркалах нет (grep по всем зеркалам — пусто);
- YAML шапок валиден: строгий `parseFrontmatter` разбирает все шапки,
  `name` скилов/агентов и `description` непусты;
- повторный dry-run даёт `unchanged=13` — зеркала равны свежему рендеру;
- `AGENTS.md` = прежний файл + пустая строка + отрендеренная роль
  `preflight`; `prompts/**`, `skills/**` побитово совпадают с прежними
  файлами; `agents/**` отличаются только кавычками `description`.

## D.2. Пакет

- **`package.json`**: имя `roles` → `pi-template`; manifest для discovery
  (`pi.extensions: ["./index.ts"]`) проверен — точка входа существует.
  `private: true`, зависимости и `type` не менялись. Имя в
  `package-lock.json` приведено к тому же (2 места).
- **`README.md`** (новый): что это за расширение; `template.json` с полями
  `values`/`initial`/`@`/`@<имя>`/`cwd`; синтаксис шаблонов (словарь
  `if`/`unless`+`eq`/`in`, интерполяция, комментарии, партиалы статические
  и динамические, `{{[var@]}}`/`{{[var@foo]}}`, двухэтапный рендер
  агентского файла); `/template` и пункты меню; статусная строка; версии
  контекста; установка; субагенты и ограничения вне процесса pi.
- **`TESTING.md`** (переписан под новый механизм): `node probe.mjs` (82
  сценария), живые скрипты `live/*.mjs` с ожидаемым выводом, проверка
  типов, ручные сценарии (старт, `/reload`, смена и применение
  переменной, пересчёт, resume, битый конфиг, read скила под локом,
  спавн, каталог advertised) и известные ограничения.
- **Живые скрипты зон B и C перенесены в `live/`** (7 штук):
  `smoke.mjs`, `prompt.mjs`, `delivery.mjs`, `first-run.mjs`,
  `derived.mjs`, `registration.mjs`, `ux.mjs`. Изменения при переносе:
  убраны машинные абсолютные пути; `live/sdk.mjs` вычисляет точку входа
  расширения от файла и SDK pi от `process.execPath` (глобальные
  node_modules установки, чьим `node` запущен скрипт) с понятной ошибкой
  при отсутствии; содержимое сценариев не менялось. Добавлен
  `live/typecheck.mjs` (по решению ведущего, вместо статичного tsconfig):
  сам вычисляет пути к `dist/index.d.ts` pi и типам node, генерирует
  `tsconfig.json` во временном каталоге и запускает `tsc` из `PATH`.

## D.3. Готовность к публикации

Push и синхронизация чекаута
`~/.pi/agent/git/github.com/NikolayXHD/pi-template` — за ведущим.
Исполнитель остановился на «готово».

## Результаты проверок

- `node probe.mjs` — **ALL OK**, 82 сценария, 0 FAIL.
- Проверка критериев (`/tmp/d-check-config.mjs`): `template.json`
  разбирается движком; `role` получает список
  `annotate, datascience, design, develop, discuss, plan, preflight`;
  `initial` = `preflight`; 13 зеркал без сырых тегов; YAML шапок валиден
  (`проверки D: OK — ролей 7, зеркал 13, реестр партиалов 132`).
- Первый рендер: dry-run `written=0 unchanged=13` (зеркала свежие).
- Живые скрипты пакета (все зелёные):
  - `node live/smoke.mjs` — `SMOKE OK`, `extension errors: []`;
  - `node live/prompt.mjs` — `SMOKE OK`;
  - `node live/delivery.mjs`, `node live/first-run.mjs` — `DELIVERY SMOKE OK`,
    `project_context fresh: true`, `skills fresh: true`, `preamble`/`addendum`
    наши;
  - `node live/derived.mjs` — `DERIVED TEXT SMOKE OK` (производный промпт
    ребёнка не переписан);
  - `node live/registration.mjs` — `REGISTRATION SMOKE OK`
    (`id: "pi-template"`, путь `index.ts`);
  - `node live/ux.mjs` — `LIVE UX OK`, 48 проверок, 0 FAIL;
  - `node live/typecheck.mjs` — `TYPECHECK OK` (tsc 6.0.3).
- Чистовые зеркала пишутся только кодом движка; после генерации старый
  файл `AGENTS.md` перезаписан зеркалом (прежнее содержимое — в бэкапе).

## Rollback

1. **Живой каталог.** Удалить созданные миграцией файлы, которых не было:
   `template.json`, `AGENTS.md.template`, `agents/*.md.template`,
   `prompts/*.md.template`, `skills/*/SKILL.md.template`. Вернуть прежние файлы
   из бэкапа:
   `cp -a .task/current/23_template-implementation/4_migration/backup/. /home/kolia/.pi/agent/`
   — восстановит `roles.json`, `AGENTS.md`, `.gitignore`, `roles/*.md`,
   `roles/materialized/**`, `skills/*/SKILL.md`, `prompts/*.md`, `agents/*.md`
   (зеркала сгенерированные перезапишутся прежними файлами). После отката
   старый движок roles вновь найдёт `roles.json` и `roles/materialized`.
2. **Пакет.** Коммитов нет: `git restore TESTING.md package.json
   package-lock.json`; удалить новые `README.md` и `live/`
   (`rm -rf README.md live/`). `probe.mjs` и модули движка не менялись.
3. **Незакоммиченное состояние живого репозитория** восстанавливается и
   штатным `git restore` из индекса HEAD: `roles.json`, `AGENTS.md`,
   `roles/*.md`, `.gitignore`, `agents/*.md`; `roles/materialized`
   в .gitignore и в HEAD отсутствует — его возвращает только бэкап.

## Вопросы и решения (supervisor)

1. **Партиалы ролей.** «roles/** не трогать» конфликтовало с design.md
   («статические партиалы — имена путями от корня») и с рендером (короткие
   имена не резолвятся). Решение: переписать 11 ссылок на полные пути —
   выполнено; формулировка спеки признана неполной.
2. **SYSTEM.md/APPEND_SYSTEM.md** в живом каталоге отсутствуют. Решение:
   не заводить, миграцию пропустить — выполнено, отмечено выше.
3. **Строка `/roles/materialized/` в `.gitignore`.** Решение: убрать как
   часть миграции — выполнено.
4. **Скрипты и tsconfig.** Решение: 7 скриптов в `live/` с путями от файла
   и `process.execPath`; вместо статичного tsconfig — скрипт проверки
   типов — выполнено.
5. **Строгий YAML агентских `description`.** Решение: взять в кавычки три
   файла, общее правило миграции — приводить источники к строгому YAML —
   выполнено, перечень проверенных источников выше.

## Остаточные риски и известные состояния

- **`roles.json` воскресает, пока жив старый движок.** Старое расширение
  roles, загруженное в текущих сессиях, на `before_agent_start` при
  изменившихся входах вызывает `syncSelection`, а тот создаёт
  `roles.json`, если файла нет (наблюдалось: файл воссоздан в 04:14 после
  удаления и удалён повторно). До публикации и синхронизации чекаута файл
  может появиться снова (содержимое — `cycle` из имён ролей); ведущий
  удаляет его при синхронизации (D.3). Это ожидаемый переходный эффект,
  новые зеркала от него не зависят.
- **Зеркала остаются отслеживаемыми в git живого каталога.** `.gitignore`
  добавлен, но файлы уже в индексе: `AGENTS.md`, `agents/*.md`
  (модифицированы зеркалами), `prompts/*.md`, `skills/*/SKILL.md`
  (содержимое зеркал совпадает с прежними файлами). Коммит должен
  снять их с отслеживания (`git rm --cached` по списку) — решение за
  ведущим; исполнитель индекс не трогал (в обоих репозиториях ничего не
  застейджено).
- **Переходное окно:** правка партиалов и `description` ломает рендер
  ролей старого движка в текущей сессии (он оставляет текст прошлого
  успеха и предупреждение) — принято ведущим, окно закрывается
  публикацией и `/reload`.
- Старый `Makefile` живого каталога (`format`) и `PORTING.md` не входят в
  список миграции и не трогались.
