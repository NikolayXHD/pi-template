# Хелферы частей frontmatter: `frontmatterKeys` и `bodyAfterFrontmatter`

## Постановка

`@NikolayXHD`: расширение `pi-subagents` читает `timeoutMs` только из
frontmatter файла агента (`src/agents/agents.js` → `defaultTimeoutMs`,
расходуется в `src/runs/background/async-execution.js`), а `agentOverrides` в
настройках этого поля не знает. Поднять дедлайн одному агенту можно, только
владея файлом агента. Владельцем оказался файл пакета
(`npm/node_modules/pi-subagents/agents/reviewer.md`): правка через симлинок
`~/.pi/agent/agents/reviewer.md` легла в пакет и умрёт при обновлении.

Копировать промпт чужого агента в свой `.template` — дублирование. Нужен
механизм, который берёт из чужого файла куски, а синтаксическую обёртку
`---` пишет сам шаблон:

```md
---
{{frontmatterKeys "npm/node_modules/pi-subagents/agents/reviewer.md"}}
timeoutMs: 3600000
---
{{bodyAfterFrontmatter "npm/node_modules/pi-subagents/agents/reviewer.md"}}
```

Имя — от корня агент-директории: резолвер включений за корень не пускает
(`includePair` в `sources.ts`, `staticPartialNameProblem` в `render.ts`).

Из рук — только строка `timeoutMs`.

## Почему не подходят другие пути

- `agentOverrides` в `subagents`: перечень переопределяемых полей
  (`BUILTIN_OVERRIDE_FIELDS` в `src/agents/agents.js`) не включает `timeoutMs`;
- хелпер «тело без frontmatter»: ключи (`tools`, `thinking`, `acceptanceRole`)
  всё равно пришлось бы переписывать руками;
- дубликат ключа в frontmatter: работает (последнее значение побеждает), но
  парсер pi-subagents обрывает блок на первом `\n---`, поэтому второй
  frontmatter-блок в тело не склеивается с первым, а остаётся текстом промпта;
- `eject` из `pi-subagents`: сгенерированная копия, но её актуальность — на
  повторном eject, и промпт чужого агента живёт у нас в репозитории.

## Связь с существующим механизмом включений

Чтение чужого файла — то же самое, что делает `{{> name}}`: имя резолвится на
диске в момент рендера (`createPartialResolver` в `sources.ts`), каталогов
заранее не обходим. Отсюда требования к новым хелферам: та же лексика имени
(путь без ведущей точки, кавычки, `concat` из литералов и переменных —
`expr.ts`), то же участие в отчёте о прочитанных включениях и в `render-set`.
