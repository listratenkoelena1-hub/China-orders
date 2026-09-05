# China Orders

Актуальный исходный код веб-приложения для учёта заказов из Китая.

- Firebase project: `china-orders-firebase`
- Hosting: https://china-orders-firebase.web.app
- Production branch: `main`

## Структура

- `index.html` — веб-приложение.
- `404.html` — страница ошибки Firebase Hosting.
- `firestore.rules` — правила доступа Firestore.
- `functions/` — Cloud Functions, включая проверку готовности интеграции 1688.

Локальные резервные копии, кэши Firebase и `node_modules` намеренно не хранятся в репозитории.

## Проверка и деплой

```powershell
node --check functions/index.js
firebase deploy --project china-orders-firebase
```
