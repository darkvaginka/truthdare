# Truth or Dare — Telegram Mini App

«Правда или Действие» — мультиплеерная игра в виде Telegram Mini App. Каждый игрок подключается со своего телефона, хост создаёт комнату, гости заходят по 4-символьному коду.

## Архитектура

Проект состоит из двух частей, разворачиваемых независимо:

- **Фронтенд** (`index.html`, `vercel.json`) — одностраничное приложение, статически хостится на Vercel (`https://truthdare-dusky.vercel.app`).
- **Бэкенд** (`server.js`, `package.json`) — Node.js-сервер с WebSocket и REST, хостится на Railway (`https://truthdare-production.up.railway.app`). Хранит Premium-статус в PostgreSQL.

Один Telegram-бот: открывает Mini App кнопкой WebApp, обрабатывает платежи Stars через webhook на `/webhook`.

## Фронтенд (`index.html`)

Весь UI — один HTML-файл (~6000 строк), без сборщика. Подключаются только Telegram WebApp SDK, Adsgram SDK и Google Fonts (Syne, Nunito).

### Экраны

Все экраны — `<div class="screen" id="s-...">`, переключаются функцией `go(id)` (только один `.active` за раз):

- `s-home` — главный экран с CTA «Создать / Войти / Соло».
- `s-create` — настройка новой комнаты (имя, категории, лимит игроков).
- `s-join` — вход по коду.
- `s-lobby` — лобби комнаты, список игроков, контролы хоста.
- `s-penalty` — выбор наказания за отказ (пресеты или кастом).
- `s-gamemode` — выбор режима раздачи (`turns`, `2t1d`, `auto`).
- `s-wheel` — экран хода (раунд/ход/текущий игрок).
- `s-choice`, `s-watch`, `s-card` — выбор типа, ожидание, показ карточки.
- `s-scores`, `s-solo`, `s-settings` — счёт, соло-режим, настройки.

### Состояние

- `state` — глобальное состояние клиента (`lang`, `isPremium`, `myName`, `roomCode`, …).
- `GAME` — состояние текущей игры (игроки, раунд, ход, использованные карточки).
- `_ws`, `_myId`, `_savedRoomCode`, `_wsReconnecting` — WebSocket-клиент с автореконнектом, heartbeat'ом и оверлеем «Переподключение…».

### Контент

- `CATEGORIES` (7 шт.): `friends`, `family` — бесплатные; `couples`, `party`, `close_friends`, `hot`, `couples_hot` — Premium.
- `CARDS[type][catId][lang]` — массив строк-карточек (`type` ∈ `truth`/`dare`, `lang` ∈ `ru`/`en`).
- `DEMO_CARDS` — отдельный мини-набор для быстрого демо (3 ИИ-игрока, до `DEMO_MAX_TURNS = 6` ходов).

### Локализация

Двуязычная (ru/en). Словарь — `T[lang][key]`. Применение — функция `applyI18n()`: проходит по элементам с атрибутами `data-i` (textContent) и `data-ph` (placeholder). После смены языка вызывать `applyI18n()` + `renderCatGrids()`.

### Telegram-интеграция

`window.Telegram.WebApp` — `tgApp.ready()`, `tgApp.expand()`, цвета header/background фиксируются под тёмную тему `#08090f`. Имя пользователя берётся из `initDataUnsafe.user.first_name`. `BackButton` навешивается на навигацию назад. Тактильные отклики — через `HapticFeedback` с фолбэком на `navigator.vibrate`.

### Реклама

Adsgram (`int-29283`) — межстраничные показы для бесплатных пользователей каждые `AD_EVERY_TURNS = 3` ходов через `showAdIfNeeded()`. Premium-пользователям не показываются.

### Premium и платежи

Покупка Premium через Telegram Stars: фронт вызывает `POST /create-invoice`, получает `invoiceLink`, открывает его через `tg.openInvoice()`. После успешной оплаты бот получает `successful_payment` через webhook и активирует подписку в БД.

## Бэкенд (`server.js`)

Один файл, ~530 строк. Express HTTP-сервер + `ws` WebSocket-сервер на одном порту.

### REST-эндпоинты

- `GET /` — health-check, возвращает количество комнат.
- `POST /create-invoice` — генерирует Telegram Stars invoice link для плана `forever` (299 ⭐) или `month` (49 ⭐).
- `GET /premium-status?userId=...` — текущий статус Premium для пользователя.
- `POST /admin/grant-premium` — ручная выдача Premium (требует `ADMIN_SECRET`).
- `POST /webhook` — Telegram-вебхук: `pre_checkout_query`, `successful_payment`, команды `/start`, `/help`, `/premium`.

### WebSocket-протокол

Клиент → сервер: `create_room`, `join_room`, `update_settings`, `start_game`, `pick_type`, `task_result`, `reaction`, `leave_room`, `ping`.

Сервер → клиенту: `room_created`, `room_joined`, `rejoined`, `player_joined`, `player_left`, `player_offline`, `player_rejoined`, `host_changed`, `settings_updated`, `game_started`, `type_picked`, `turn_result`, `reaction`, `room_expired`, `pong`, `error`.

### Состояние комнат

`rooms: Map<code, room>` в памяти процесса (нет персиста). `code` — 4 символа из безопасного алфавита (без `0/O/1/I`). Каждая комната хранит игроков с их WebSocket-ссылками, текущий ход и таймеры.

### Реконнект и устойчивость соединения

Это критичная часть — баги тут уже фиксили, не упрощать без причины:

- **Реджойн по имени.** При повторном `join_room` ищем существующего игрока по `clientId` ИЛИ по имени, если его старый WS закрыт. Это позволяет вернуться после полного обрыва.
- **Grace period 90 сек.** При обрыве соединения в запущенной игре игрок не удаляется сразу — `player.ws = null` и таймер на 90 сек. Реджойн в этом окне отменяет таймер.
- **Автопропуск хода 15 сек.** Если оборвался игрок, чей сейчас ход, через 15 сек его ход автоматически пропускается с `−1` очко.
- **Heartbeat 30 сек.** Сервер пингует все WS, не ответившие — terminate. Клиент держит свой heartbeat против Railway idle timeout.
- **Автоудаление комнаты:** через 4 часа от создания и через 10 минут если все игроки оффлайн.

### Premium-хранилище

PostgreSQL, единственная таблица `premium_users(user_id, plan, purchased_at, expires_at)`. План `forever` — `expires_at = NULL`, при апсерте `forever` не перезаписывается на `month`. План `month` при повторной покупке продлевается от текущей даты окончания (а не от `now`).

## Команды

```bash
npm start      # production: node server.js
npm run dev    # dev с hot-reload: node --watch server.js
```

Деплой фронта — push в репозиторий, Vercel деплоит автоматически по `vercel.json`. Деплой бэка — Railway по тому же репозиторию (использует `package.json` start-скрипт).

## Переменные окружения (бэкенд)

- `PORT` — порт HTTP/WS-сервера (по умолчанию `3000`).
- `DATABASE_URL` — строка подключения к PostgreSQL (с SSL).
- `BOT_TOKEN` — токен Telegram-бота (для invoice/webhook/sendMessage).
- `WEBAPP_URL` — URL Mini App, подставляется в кнопку `/start`.
- `ADMIN_SECRET` — для эндпоинта `/admin/grant-premium`.

## Полезное при правках

- HTML-файл большой (~360 KB, 6040 строк) — для чтения используйте `Read` с `offset`/`limit` или `grep` по разделителям `/* ====` и `<!-- ====`.
- Любая правка строки в UI должна попасть в обе локали в `T.ru` и `T.en`. Новые карточки — в обе локали в `CARDS[type][cat]`.
- Любая правка протокола WebSocket требует синхронных изменений в `handleMessage` (`server.js`) и `handleServerMsg` (`index.html`).
- Локально нет npm-зависимостей у фронта — править index.html напрямую, без билда.
