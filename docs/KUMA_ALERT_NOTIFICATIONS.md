# KUMA: как приходят уведомления об алертах

Снято вживую на `hq77-siem-s04.corp.rusagrogroup.ru:7220` (KUMA 4.6.0.242),
скрипты `848.541b4ed8c8fec889.js` и `assets/i18n/ru.json`. Формат пакетов
подтверждён реальным потоком `notifications/feed`.

## Главное

Уведомления — это **Server-Sent Events**, а не HTTP-опрос.
В Network у вас не было запросов, потому что поток открывается один раз
и висит в статусе `pending` всё время жизни страницы. В HAR он тоже
не попадёт: HAR пишется по завершённым запросам, а этот никогда не
завершается.

```
GET /api/private/notifications/feed
Accept: text/event-stream
→ 200, Content-Type: text/event-stream; charset=utf-8
→ соединение не закрывается
```

Класс `NotificationService` (модуль 848):

```js
this.sseUrl = 'api/private/notifications/feed';
start() { this.sse.disconnect(this.sseUrl); this.sse.connect(this.sseUrl, this.kind); }
```

Внутри `SseService.connect()`:

```js
const es = new EventSource(url);
es.addEventListener(kind, (e) => {
  this.message.next(e);
  window.postMessage({ app: 'kuma', family: 'sse', ...JSON.parse(e.data) });
  this.broadcastTabSync.broadcastSSEMessage(kind, e.data);
});
```

Событие называется `notification` (это и есть `kind` из `connect`),
а полезная нагрузка — JSON вида:

```json
{ "kind": "alert", "payload": { "name": "..." } }
```

Тосты показывает сервис из модуля `6645`:

```js
this.notificationService.alertNotifications().subscribe((n) => {
  this.toastService.success(translate('toast.newAlertCreated', { name: n.payload.name }));
});
```

Ключ локализации:

* ru: `Создан новый алерт: {{name}}.`
* en: `New alert created: {{name}}.`

То есть **всплывашка — это не новый инцидент, а уведомление о новом алерте**.

## Только одна вкладка держит соединение

`BroadcastTabSync` выбирает лидера через `BroadcastChannel`:

* лидер открывает `EventSource`, ловит события и рассылает их другим вкладкам
  через `BroadcastChannel` и `window.postMessage`;
* остальные вкладки **никогда** не открывают `EventSource` сами и не получают
  `window.postMessage` от соседних вкладок — сообщения `BroadcastChannel`
  в их окно не приходят, KUMA сама передаёт данные только своим обработчикам.

Отсюда и странность: в одной вкладке поток есть, в другой — никаких запросов.

## Практические следствия

1. Перехватывать `fetch`/XHR бессмысленно: поток идёт мимо них (`EventSource`).
2. Собственное соединение `EventSource` к тому же `notifications/feed` получает
   те же события в любой вкладке, включая нелидерские. Так устроен модуль
   `sound-alert`: он фильтрует `kind === "alert"` и играет звук.
3. Копия `EventSource` не ломает KUMA: несколько подписчиков на сервере
   поддерживаются, страница о них не знает. Но каждое соединение — отдельная
   нагрузка на сервер, поэтому модуль держит **одно соединение на браузер**:
   вкладки договариваются через `BroadcastChannel`, поток ведёт только одна,
   она же и звучит.
4. В нелидерских вкладках KUMA своего потока может не быть вовсе — на них
   нельзя опираться, свой `EventSource` там единственный источник событий.

## Полный формат живого потока (проверено)

```
event:connected
data:<nil>

event:notification
data:{"kind":"task","payload":{...},"tenantIDs":[...],"ownerID":""}
data:{"kind":"alert","payload":{"id":"...","name":"..."},"tenantIDs":[...]}
```

* `connected` — служебный пакет после установки соединения;
* `notification` — основное событие, различается по `kind`:
  `alert`, `task`, `taskStatusChanged`, `dashboard`, `universal_dashboard`,
  `search_events`, `cancel_search_events`, `category`;
* у алерта в `payload` есть как минимум `id` и `name`.

## Как посмотреть

* В консоли KUMA должны быть строки `sse - connect api/private/notifications/feed`
  и `sse - connection established api/private/notifications/feed`.
* В Network: фильтр `eventsource` (или «All», тип `eventsource`), одна
  вечно «pending» запись `notifications/feed`.
