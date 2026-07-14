# Задача: Cleanup Agent Config (skills/plugins)

## Контекст

В репозитории `codebase-memory-plus` есть дашборд Agent Config (`/api/agent-config`), который сканирует MCP, skills и plugins для Claude, Cursor и Codex через `src/agent-config-scanner.ts`.

**Что уже сделано (вне репо, на машине пользователя):**
- MCP выровнены: 7 общих серверов во всех 3 агентах (`codebase-memory-mcp`, `refero`, `playwright`, `chrome-devtools`, `cavemem`, `serena`, `pencil`)
- Skills синхронизированы агрессивным symlink из всех plugin cache → `~/.claude/skills/`, `~/.codex/skills/`, `~/.cursor/skills-cursor/`
- В Codex добавлен plugin `caveman@caveman`

**Проблема:** после синхронизации **~109–130 unique skills** вместо ожидаемых **~25–35**. Дашборд показывает `130 Skills / 10 MCP / 14 Plugins = 154 items`. Это шум от plugin cache, а не реальный набор skills пользователя.

---

## Цель

1. **Очистить user skills** на машине пользователя до curated набора (~30–40 skills)
2. **Улучшить scanner/дашборд**, чтобы не считать plugin-internal skills как user skills
3. **Зафиксировать политику синхронизации** — что копируется между агентами, а что остаётся в plugin runtime

---

## Текущее состояние (проверить в начале)

```bash
cd /Users/oleksandrzabolotnyi/Documents/Project/codebase-memory-plus
npm run build
node -e "
import { scanAgentConfig } from './dist/agent-config-scanner.js';
import { homedir } from 'os'; import { join } from 'path';
const e = scanAgentConfig([join(homedir(),'Documents/Project')]);
const uniq = (type) => new Set(e.filter(x=>x.type===type).map(x=>x.name)).size;
console.log({ total: e.length, mcp: uniq('mcp'), skills: uniq('skill'), plugins: uniq('plugin') });
"
```

Ожидаемо сейчас: **skills ≈ 109–130**, **mcp ≈ 9–10**, **plugins ≈ 14**.

Директории skills:
- `~/.claude/skills/` — 109 symlink dirs
- `~/.codex/skills/` — 109 symlink dirs
- `~/.cursor/skills-cursor/` — 109 symlink dirs
- `~/.cursor/skills/` — legacy mirror

---

## Задача 1: Cleanup user skills (на машине пользователя)

### 1.1 Удалить ВСЕ symlink skills из трёх каталогов

Не трогать реальные директории в plugin cache — только `~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills-cursor`, `~/.cursor/skills`.

```bash
# Для каждого каталога: удалить только symlinks, сохранить real dirs если есть
```

### 1.2 Восстановить curated набор

**Канонический источник:** `~/.claude/skills/` (real dirs, не из plugin cache).

#### KEEP — Core design/dev (14)
```
adapt, audit, codebase-memory, critique, design-system-marswalk,
distill, frontend-design-process, gsap-marswalk, impeccable,
new-section-marswalk, nextjs-marswalk, playwright, refero-design,
web-design-guidelines
```

#### KEEP — Cursor workflow (19) — symlink из `~/.cursor/skills-cursor/` (real dirs)
```
automate, babysit, canvas, create-hook, create-rule, create-skill,
create-subagent, loop, migrate-to-skills, onboard, review,
review-bugbot, review-security, sdk, shell, split-to-prs,
statusline, update-cli-config, update-cursor-settings
```

#### KEEP — frontend-design (1)
Канонический путь:
`~/.claude/plugins/cache/claude-plugins-official/frontend-design/unknown/skills/frontend-design/`

#### KEEP — Plugin skills, только если реально используются (опционально, ~10)
```
ponytail, ponytail-review, ponytail-help,
caveman, caveman-review, cavecrew,
nextjs, vercel-cli, ai-sdk, shadcn
```

#### REMOVE — всё остальное (~70+), включая:
- `artifact-template-*` (20+ штук из Codex presentations plugin)
- `benchmark-*`, `plugin-audit`, `release` (dev skills Vercel plugin)
- `latex-compile`, `latex-doctor`, `texlive-runtime-installer`
- `Presentations`, `Spreadsheets`, `documents`, `pdf`, `visualize` (Codex runtime — доступны через plugin, не как user skill)
- `control-chrome`, `control-in-app-browser`, `computer-use`
- `setup` (claude-tokens — plugin-specific)
- Дубли upstream: `next-forge`, `next-upgrade`, `next-cache-components` если не нужны
- Все `artifact-template-*`

### 1.3 Синхронизация между агентами

После cleanup:
- **Claude** = curated real dirs + symlinks для cursor-only
- **Codex** = symlink на Claude canonical
- **Cursor skills-cursor** = symlink на Claude canonical + real cursor-only dirs

**Не symlink'ить** из `plugins/cache/**` напрямую в user skills.

### 1.4 Критерий успеха Task 1

```bash
# После cleanup:
# unique skill names ≈ 30–45 (не 109–130)
# Все 3 агента имеют одинаковый набор core skills
# Нет symlink на plugin cache paths в source_path
```

---

## Задача 2: Улучшить scanner (в репозитории)

Файл: `src/agent-config-scanner.ts`

### 2.1 Разделить источники skills

Добавить поле `origin` в `AgentConfigEntry`:
```typescript
origin: "user" | "plugin" | "managed"
```

Логика:
| Путь | origin |
|---|---|
| `~/.claude/skills/` | `user` |
| `~/.cursor/skills-cursor/` | `user` (или `managed` для cursor-built-in) |
| `~/.codex/skills/` | `user` |
| `**/plugins/cache/**/skills/**` | `plugin` |
| `~/.cursor/skills/` | `user` (legacy) |

**Не сканировать** plugin cache как user skills — только если явно включён флаг `includePluginSkills=true`.

### 2.2 Фильтр в API

```
GET /api/agent-config?origin=user     # только user skills
GET /api/agent-config?origin=plugin   # только plugin skills
```

### 2.3 Дашборд

Файлы: `dashboard/src/agent-config.ts`, `dashboard/index.html`, `dashboard/styles.css`

- По умолчанию показывать **только `origin=user`**
- Toggle: «Include plugin skills»
- В карточке skill показывать badge `plugin` / `managed` / `user`
- Stats chips считать отдельно: `Skills (user)` vs `Skills (plugin)`

### 2.4 Защита от symlink loop

Уже частично сделано в `listDirs()` — `statSync` в try/catch. Добавить:
- Детект circular symlink → skip + log warning
- `source_path` не должен указывать на `plugins/cache` если skill лежит в user dir через symlink (resolve real path)

### 2.5 Критерий успеха Task 2

- Дашборд по умолчанию: **~30–45 skills**, не 130
- Plugin skills видны только по toggle
- `npm run build && npm run typecheck:dashboard` проходит

---

## Задача 3: Политика plugins (документация + опциональный sync script)

Создать `docs/agent-config-sync.md` с таблицей:

| Component | Claude | Cursor | Codex | Sync strategy |
|---|---|---|---|---|
| MCP (7 core) | ✓ | ✓ | ✓ | Same in mcp.json / claude.json / config.toml |
| ponytail plugin | ✓ | skills only | ✓ | Native plugin claude+codex |
| caveman plugin | ✓ | skills only | ✓ | Native plugin claude+codex |
| vercel | plugin | MCP | plugin | Platform-specific, skills optional |
| codex bundled | — | — | ✓ | Never sync to claude |
| claude official | ✓ | — | — | Never sync to codex |

Опционально: `scripts/sync-agent-skills.mjs` — curated whitelist, не «всё подряд».

---

## Задача 4: Верификация

### Checklist
- [ ] `scanAgentConfig` → user skills ≈ 30–45
- [ ] Dashboard: `X of Y items` где Y ≈ 50–60 (не 154)
- [ ] MCP matrix: 7 ON во всех 3 агентах
- [ ] Нет circular symlinks в skills dirs
- [ ] `playwright` skill и `playwright` MCP — разные типы, не дубликат в UI (группировка по `type::name` уже есть)
- [ ] Reload Cursor / Claude / Codex — skills подхватываются

### Команды верификации
```bash
# Broken symlinks
find ~/.claude/skills ~/.codex/skills ~/.cursor/skills-cursor -type l ! -exec test -e {} \; -print

# Skills pointing into plugin cache (should be 0 after cleanup)
node -e "
import { scanAgentConfig } from './dist/agent-config-scanner.js';
const e = scanAgentConfig([]);
const bad = e.filter(x=>x.type==='skill'&&x.source_path.includes('plugins/cache'));
console.log('plugin-cache user skills:', bad.length);
"

# Dashboard
npm run dashboard
# Open http://127.0.0.1:5178 → Agent Config
```

---

## Файлы репозитория (scope)

| Файл | Действие |
|---|---|
| `src/agent-config-scanner.ts` | origin field, plugin cache filter |
| `src/dashboard-server.ts` | API filter `?origin=` |
| `dashboard/src/agent-config.ts` | UI toggle, stats split |
| `dashboard/src/types.ts` | `origin` type |
| `dashboard/index.html` | toggle button |
| `dashboard/styles.css` | origin badges |
| `docs/agent-config-sync.md` | NEW — политика синхронизации |
| `scripts/sync-agent-skills.mjs` | NEW (optional) — whitelist sync |

## Вне репозитория (на машине пользователя)

| Путь | Действие |
|---|---|
| `~/.claude/skills/` | cleanup + restore curated |
| `~/.codex/skills/` | cleanup + symlink from claude |
| `~/.cursor/skills-cursor/` | cleanup + symlink from claude |
| `~/.cursor/skills/` | legacy mirror, symlink to skills-cursor |
| `~/.cursor/mcp.json` | не трогать (уже выровнен) |
| `~/.claude.json` | не трогать |
| `~/.codex/config.toml` | не трогать |

---

## Не делать

- Не коммитить `.serena/`
- Не удалять plugin cache directories
- Не отключать MCP без явного запроса
- Не symlink'ить всё из `plugins/cache` снова
- Не трогать `computer-use` (OFF в Codex — ок)

---

## Приоритет выполнения

1. **P0** — Cleanup user skills на машине (Task 1)
2. **P1** — Scanner origin filter (Task 2)
3. **P2** — Dashboard UI toggle (Task 2)
4. **P3** — docs + sync script (Task 3)
