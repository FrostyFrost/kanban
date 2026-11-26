# Развёртывание и синхронизация

Рабочее окружение: Windows + WSL (или нативная Linux-машина).
Все команды ниже запускаются **на компьютере пользователя** (с доступом к GitHub),
потому что в среде агента сетевые обращения к github.com заблокированы.

---

## Шаг 0. Что должно быть готово

- Git установлен: `git --version`
- Аккаунт на GitHub (`FrostyFrost`)
- SSH-ключ настроен для GitHub (`ssh -T git@github.com` — приветствие)
  либо HTTPS с GitHub Personal Access Token (PAT)
- Два репозитория: `FrostyFrost/kanban` (UI) и `FrostyFrost/kanban-data` (данные) —
  уже созданы, см. ниже

---

## Шаг 1. Первый компьютер — залить проект в GitHub

### 1.1 UI-репозиторий

```bash
cd /path/to/kanban              # /artifacts/kanban (или путь на ПК)
git remote -v                    # убедитесь, что origin -> git@github.com:FrostyFrost/kanban.git
git status                       # должно быть чисто
git push -u origin main
```

Проверка: https://github.com/FrostyFrost/kanban — должны быть видны README.md, app.js, index.html, styles.css.

### 1.2 Репозиторий данных

```bash
cd /path/to/kanban-data         # /artifacts/kanban-data
git remote -v                    # origin -> git@github.com:FrostyFrost/kanban-data.git
git status                       # чисто
git push -u origin main          # если ветка не отслеживается — поможет -u
```

Проверка: https://github.com/FrostyFrost/kanban-data — должны быть видны tasks.jsonl и README.md.

---

## Шаг 2. Второй компьютер — подтянуть данные

### Вариант A. Через приложение (кнопки ☁/🔄)

1. Склонируйте UI-репозиторий (или просто скачайте index.html/app.js/styles.css):
   ```bash
   git clone git@github.com:FrostyFrost/kanban.git
   cd kanban
   ```
2. Откройте `index.html` в Chrome/Edge (иначе File System Access API не сработает).
3. В шапке нажмите ⚙ → введите GitHub PAT (см. ниже) — он нужен только для
   **☁ push**. Для 🔄 достаточно публичного репозитория, токен не нужен.
4. Нажмите **🔄** («Обновить из GitHub») — приложение подтянет актуальные
   карточки из репозитория данных и сработает merge по правилу «последний `updated`
   побеждает».
5. Карта появится сразу после pull.

### Вариант B. Через git (вручную)

```bash
git clone git@github.com:FrostyFrost/kanban-data.git
cd kanban-data
git pull
```

Затем в приложении нажмите 📁 и выберите `kanban-data/tasks.jsonl`.

⚠️ Файл с задачями редактируется локально в `kanban-data/`; приложение не видит его
автоматически — нужно выбирать файл через 📁 или 🔄 один раз после `git pull`.

---

## Шаг 3. Создание GitHub PAT (для ☁ — загрузка в GitHub)

1. Откройте https://github.com/settings/tokens
2. **Generate new token** → **Generate new token (classic)**
3. Note: `kanban-sync`, срок: 90 дней (или больше)
4. Scope: **`repo`** (полный доступ к репозиториям) — нужен, чтобы обновлять
   `tasks.jsonl` в `FrostyFrost/kanban-data`
5. Generate token → **скопируйте значение** (показывается один раз)

Вставьте во вкладку ⚙ → «GitHub PAT» → «Сохранить».

⚠ Токен хранится в localStorage браузера (DevTools → Application → Local Storage).
Не вставляйте его в чаты и не коммитьте в git.

---

## Шаг 4. Синхронизация в повседневной работе

| Действие | Как |
|---|---|
| Загрузить локальные изменения в облако | ☁ (нужен PAT) |
| Подтянуть свежие данные | 🔄 (без PAT, если репо публичный) |
| Проверить обновления при открытии | автомат — статус в шапке («Есть обновления на GitHub») |
| Не удалось синхронизировать | вернуться в ☁/🔄 позже, ничего не теряется |

Статус обновления в шапке — простая индикация: ☁ = отправить, 🔄 = получить.
При открытии страницы страница тихо проверяет наличие новых данных на GitHub, но
**никогда не перезаписывает** локальные изменения без спроса.

---

## Шаг 5. Решение проблем

**SSH не работает** (`ssh: connect to host github.com port 22: Connection refused`)
→ используйте HTTPS:
```bash
git remote set-url origin https://github.com/FrostyFrost/kanban.git
git push
```
(GitHub попросит вставить PAT вместо пароля)

**❌ «Файл не найден на GitHub»** (при 🔄)
→ проверьте, что репо существует и `tasks.jsonl` лежит в корне ветки `main`

**❌ «Пустое содержимое или пустой ответ»** (при ☁)
→ проверьте токен (⚙) и scope `repo`; скопируйте свежий PAT

**GitHub API отдаёт 403**
→ возможно, IP-адрес заблокирован (corporate proxy) — проверьте доступ к
`https://api.github.com` с браузера

---

## Что НЕ нужно

- Не нужно устанавливать Node.js, Python или другие runtime — приложение
  собирает из локальных файлов и работает в браузере
- Не нужно запускать сервер — всё клиентское
- Не нужно вручную коммитить `tasks.jsonl` — кнопка ☁ делает это через API
