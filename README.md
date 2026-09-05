# China Orders

Актуальный исходный код веб-приложения для учёта заказов из Китая.

- Firebase project: `china-orders-firebase`
- Hosting: https://china-orders-firebase.web.app
- Production branch: `main`

## Структура

- `public/index.html` — веб-приложение.
- `public/order-import.js` — импорт заказов из одного или нескольких скриншотов.
- `public/order-import-parser.js` — распознавание товарных строк, цен, фрахта и комиссии.
- `public/404.html` — страница ошибки Firebase Hosting.
- `firestore.rules` — правила доступа Firestore.
- `functions/` — Cloud Functions приложения.

Скриншоты распознаются в браузере: полный исходный снимок не записывается в заказ. Перед добавлением все распознанные поля и фотографии можно проверить и изменить.

Локальные резервные копии, кэши Firebase и `node_modules` намеренно не хранятся в репозитории.

## Проверка и деплой

```powershell
node tests/order-import-parser.test.js
node --check public/order-import.js
node --check functions/index.js
firebase deploy --project china-orders-firebase
```
