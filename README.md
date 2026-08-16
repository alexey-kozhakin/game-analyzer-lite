# Game Analyzer Lite

Лёгкая версия Chess.com-анализатора: последние 10 партий по username, анализ Stockfish (WASM, в браузере) по клику на партию, интерактивный replay и график оценки. Без прокси и без бэкенда — работает как чистый статический сайт (совместимо с GitHub Pages), так как `api.chess.com` отдаёт открытые CORS-заголовки.

## Разработка

```bash
npm install
npm run dev
```

Откройте адрес, который выведет Vite (например `http://localhost:5173`). Приложение фетчит архив партий `alexey-kozhakin` по умолчанию — username можно сменить в форме.

## Продакшн-сборка

```bash
npm run build
npm run preview
```

Собранные файлы попадают в `dist/`.

## Деплой

При пуше в `main` GitHub Action `.github/workflows/deploy.yml` автоматически собирает проект и публикует `dist/` на GitHub Pages. Один раз нужно включить Pages в настройках репозитория: **Settings → Pages → Source: GitHub Actions**, и запушить репозиторий на GitHub под этим именем.
