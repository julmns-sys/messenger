# Assets

Сюда складывай свои визуальные файлы.

## Шрифты

Папка:

`assets/fonts/`

Пример:

- `assets/fonts/YourSans-Regular.woff2`
- `assets/fonts/YourSans-Medium.woff2`
- `assets/fonts/YourDisplay-Bold.woff2`

Подключение уже подготовлено в [assets/css/styles.css](/home/dgwowu/Downloads/Telegram%20Desktop/messenger/messenger/assets/css/styles.css:1).

Что менять:

1. Раскомментируй блок `@font-face` в начале `styles.css`.
2. Подставь свои имена файлов.
3. Обнови CSS-переменные `--font-ui` и `--font-display`.

## Иконки

Папка:

`assets/icons/ui/`

Пример:

- `assets/icons/ui/search.svg`
- `assets/icons/ui/plus.svg`
- `assets/icons/ui/back.svg`
- `assets/icons/ui/close.svg`

Для маленьких иконок в кнопках используй класс:

```html
<img class="icon-asset" src="/assets/icons/ui/search.svg" alt="">
```

## Где менять в HTML

Сейчас часть иконок у тебя текстовые:

- [chat.html](/home/dgwowu/Downloads/Telegram%20Desktop/messenger/messenger/chat.html:20)
- [group_chat.html](/home/dgwowu/Downloads/Telegram%20Desktop/messenger/messenger/group_chat.html:20)
- [index.html](/home/dgwowu/Downloads/Telegram%20Desktop/messenger/messenger/index.html:20)

Например, было:

```html
<a class="icon-button" href="/search" aria-label="Search">@</a>
```

Можно заменить на:

```html
<a class="icon-button" href="/search" aria-label="Search">
  <img class="icon-asset" src="/assets/icons/ui/search.svg" alt="">
</a>
```

## Лого / бренд

Если захочешь отдельный акцентный шрифт только для `/Chatik`, он уже вынесен в переменную `--font-display`.

Класс:

- [assets/css/styles.css](/home/dgwowu/Downloads/Telegram%20Desktop/messenger/messenger/assets/css/styles.css:839)

## Рекомендация

Для web лучше класть:

- шрифты в `woff2`
- иконки в `svg`
