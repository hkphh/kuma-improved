# Добавление модуля

Модуль — это самодостаточная папка внутри `modules/`. Ядро о нём почти ничего
не знает: оно читает манифест, регистрирует указанные файлы на разрешённых
доменах и отдаёт модулю его настройки через runtime-конфиг.

## 1. Создайте папку

```
modules/my-module/
  module.json
  content.js
```

Если модулю нужно выполнять код в MAIN-мире страницы (например, перехватывать
`fetch`), добавьте `inject.js` и передайте его имя в `module.json` как обычно —
glob `modules/*/inject.js` уже объявлен в `web_accessible_resources` корневого
`manifest.json`.

CSS-файлы, перечисленные в `files.css`, будут внедряться как обычные
content-script стили. Для UI предпочтительнее Shadow DOM — тогда стили страницы
не влияют на модуль, а модуль не влияет на страницу.

## 2. Опишите `module.json`

```json
{
  "id": "my-module",
  "name": "Мой модуль",
  "description": "Короткое описание для страницы настроек",
  "version": "1.0.0",
  "defaultEnabled": true,
  "runAt": "document_idle",
  "allFrames": false,
  "files": {
    "js": ["modules/my-module/content.js"],
    "css": []
  },
  "settings": {
    "endpoint": "/api/private/example",
    "verbose": false
  },
  "settingsSchema": [
    {
      "key": "endpoint",
      "type": "text",
      "label": "Endpoint",
      "hint": "Путь, который модуль считает интересным"
    },
    {
      "key": "verbose",
      "type": "boolean",
      "label": "Подробный режим"
    }
  ]
}
```

### Поля

| Поле | Обязательно | Описание |
|---|---|---|
| `id` | да | Уникальный идентификатор, совпадает с именем папки. |
| `name` | да | Отображаемое имя. |
| `description` | нет | Описание в настройках и popup. |
| `version` | нет | Показывается рядом с именем. |
| `defaultEnabled` | нет | Включён ли модуль для новых установок (по умолчанию `true`). |
| `runAt` | нет | `document_start` или `document_idle` (по умолчанию `document_start`). |
| `allFrames` | нет | Внедрять ли во все фреймы (по умолчанию `false`). |
| `matchPath` | нет | Префикс пути для match pattern, если модуль нужен только в разделе сайта. |
| `files.js` | да | Массив JS-файлов в порядке подключения. |
| `files.css` | нет | Массив CSS-файлов. |
| `settings` | нет | Значения по умолчанию. |
| `settingsSchema` | нет | Описание полей для авто-сгенерированной формы настроек. |

Типы `settingsSchema`: `text`, `number`, `boolean`, `select`
(`options: [{ "value": "...", "label": "..." }]`).

## 3. Добавьте модуль в реестр

`modules/registry.json`:

```json
{
  "modules": [
    "process-tree",
    "web-tester",
    "my-module"
  ]
}
```

Порядок в массиве — порядок отображения в настройках.

## 4. Перезагрузите расширение

`chrome://extensions` → «Обновить». Service worker перечитает реестр и
зарегистрирует новый модуль.

---

## Контракт модуля

### Получение настроек

Content-скрипт модуля НЕ импортирует `core/settings.js`. Он читает готовый
runtime-конфиг:

```js
const MODULE_ID = 'my-module';

chrome.storage.local.get('runtime').then(({ runtime }) => {
  const mod = runtime && runtime.modules && runtime.modules[MODULE_ID];
  if (!mod || !mod.enabled) return;

  const settings = mod.settings; // настройки с учётом defaults
  // ...
});
```

Если модуль выключают на лету, об этом сообщит событие:

```js
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.runtime) {
    const runtime = changes.runtime.newValue;
    const mod = runtime && runtime.modules && runtime.modules[MODULE_ID];
    if (!mod || !mod.enabled) cleanup();
  }
});
```

### Изоляция

* Весь код модуля оборачивайте в IIFE.
* Не создавайте глобальные имена без префикса модуля.
* Используйте уникальные id/классы DOM (`__my_module_...`).
* Не читайте чужие ключи `chrome.storage` — только свой `module.<id>.*`.
* Не полагайтесь на то, что другие модули загружены.

### Проверка домена и маршрута

Ядро уже гарантирует, что скрипт запущен только на разрешённом FQDN.
Дополнительно модуль может проверить свой маршрут (hash/path), если ему нужна
конкретная страница SPA:

```js
function routeMatches(pattern) {
  const haystack = location.pathname + location.search + location.hash;
  return new RegExp(pattern, 'i').test(haystack);
}
```

---

## Пример: MAIN-мир + обмен сообщениями

`content.js` (изолированный мир):

```js
(function () {
  'use strict';
  if (window.__myModuleLoaded) return;
  window.__myModuleLoaded = true;

  function pushConfig(cfg) {
    window.dispatchEvent(new CustomEvent('__my_module_config__', {
      detail: JSON.stringify(cfg)
    }));
  }

  window.addEventListener('__my_module_ready__', () => pushConfig({ verbose: true }));

  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('modules/my-module/inject.js');
  script.onload = function () { this.remove(); };
  (document.head || document.documentElement).appendChild(script);

  window.addEventListener('__my_module_event__', (event) => {
    const data = JSON.parse(event.detail);
    console.log('module event', data);
  });
})();
```

`inject.js` (MAIN-мир):

```js
(function () {
  'use strict';

  window.addEventListener('__my_module_config__', (event) => {
    const cfg = JSON.parse(event.detail);
    console.log('config', cfg);
  });

  window.dispatchEvent(new Event('__my_module_ready__'));
})();
```

Строковый `detail` используется намеренно: JSON безопасно пересекает границу
миров и не зависит от объектов страницы.
