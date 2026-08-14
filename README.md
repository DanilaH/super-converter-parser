# super-converter-parser

Минимальный spike для проверки, можно ли получить данные Keyword Surfer из Google SERP через Playwright.

Сейчас это не готовый парсер: скрипт намеренно собирает диагностические данные из обычного DOM, iframe и открытых shadow root, чтобы сначала понять, где расширение показывает volume и CPC.

## Требования

- Node.js 20+
- Google Chrome
- отдельный Chrome-профиль для исследования
- расширение Keyword Surfer, установленное в этом профиле

## Установка

```powershell
npm install
```

## Первый запуск Research Chrome (Windows PowerShell)

Из корня проекта:

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" "--remote-debugging-port=9222" "--user-data-dir=$PWD\.research-profile"
```

Если Chrome установлен в `Program Files (x86)`:

```powershell
& "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe" "--remote-debugging-port=9222" "--user-data-dir=$PWD\.research-profile"
```

В открывшемся Chrome:

1. Установить Keyword Surfer из Chrome Web Store.
2. Выбрать регион United States.
3. Оставить окно Chrome открытым.

Не используй свой обычный Chrome-профиль.

## Запуск проверки

В другом окне PowerShell:

```powershell
npm run probe -- "compare lists"
```

По умолчанию скрипт подключается к `http://127.0.0.1:9222` и ждёт появления виджета Keyword Surfer до 30 секунд.

При необходимости:

```powershell
$env:SURFER_WAIT_MS = "20000"
$env:CDP_URL = "http://127.0.0.1:9222"
npm run probe -- "compare lists"
```

## Что смотреть

После запуска появятся:

```text
debug/
├── google-serp.html
├── google-serp.png
└── probe-report.json
```

В консоли и `probe-report.json` будут:

- строки, похожие на Keyword Surfer volume/CPC;
- элементы с признаками `surfer`, `keyword`, `volume` или `cpc`;
- найденные iframe;
- открытые shadow roots;
- грубый список ссылок Google с заголовками `h3`.

Если Google покажет CAPTCHA, реши её в Chrome и нажми Enter в терминале.
