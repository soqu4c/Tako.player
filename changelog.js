// What changed in each version, newest first. Shown once after an update and from
// "What's new" on the start screen and in Settings → About. Each text is [Russian, English].

const CHANGELOG = [
  {
    version: '1.3.1',
    date: '2026-11-01',
    sections: [
      [['Бета-версия', 'Beta version'], [
        ['Настройки → О программе → «Версия»: можно перейти на бету с видеоредактором и вернуться обратно на основную', 'Settings → About → “Version”: switch to the beta with the video editor, and back to the main version'],
      ]],
      [['Что нового', 'What’s new'], [
        ['После обновления один раз показывается, что изменилось; потом — кнопкой на главном экране и в «О программе»', 'After an update the changes are shown once; later from the start screen and from About'],
      ]],
      [['Discord', 'Discord'], [
        ['В статусе Discord есть кнопка «Скачать Tako.player»', 'The Discord status has a “Download Tako.player” button'],
      ]],
    ],
  },
  {
    version: '1.3.0',
    date: '2026-10-31',
    sections: [
      [['Язык интерфейса', 'Interface language'], [
        ['Английский интерфейс — Настройки → Интерфейс', 'English interface — Settings → Interface'],
      ]],
      [['Субтитры из голоса', 'Subtitles from speech'], [
        ['Субтитры → «Распознать речь…» (или Shift+S): плеер сам распознаёт речь и делает файл .srt рядом с видео', 'Subtitles → “Recognize speech…” (or Shift+S): the player turns speech into an .srt file next to the video'],
        ['При первом запуске один раз скачивается модель распознавания (~490 МБ); папку для неё можно выбрать в настройках', 'The first time, the recognition model (~490 MB) is downloaded once; its folder can be chosen in the settings'],
      ]],
      [['Звук', 'Sound'], [
        ['Громкость до 200%', 'Volume up to 200%'],
        ['При объединении дорожек в один звук у каждой дорожки своя громкость', 'When tracks are mixed into one, each track has its own volume'],
        ['Дорожку можно удалить из самого файла (окно «Дорожки», N) — оригинал уходит в корзину', 'A track can be removed from the file itself (Tracks window, N) — the original goes to the Recycle Bin'],
      ]],
      [['Картинка', 'Picture'], [
        ['Приближение: Ctrl + колесо мыши или Ctrl +/−, картинку можно двигать мышью; Z — сбросить', 'Zoom: Ctrl + mouse wheel or Ctrl +/−, drag the picture with the mouse; Z resets'],
        ['Маленькое окно поверх всех окон — W; W, Esc или F возвращают обычное окно', 'Small window on top of all windows — W; W, Esc or F bring the normal window back'],
      ]],
      [['Метки и клипы', 'Marks and clips'], [
        ['B — поставить метку, Shift+B — список меток', 'B adds a mark, Shift+B opens the list of marks'],
        ['Из меток сохраняются отдельные короткие клипы или один склеенный ролик', 'Marks become separate short clips or one video glued together'],
        ['Готовый клип или кадр можно перетащить прямо в Discord, Telegram или Проводник; карточки библиотеки тоже перетаскиваются', 'A saved clip or frame can be dragged straight into Discord, Telegram or Explorer; library cards can be dragged too'],
      ]],
      [['Обрезка', 'Trimming'], [
        ['Звуковая волна под кадрами; волны всех дорожек строятся за один проход, переключение дорожек мгновенное', 'Sound waveform under the frames; all tracks are read in one pass, so switching tracks is instant'],
      ]],
      [['Библиотека', 'Library'], [
        ['Фильтры: видео, недосмотренные, не открытые, избранное (звёздочка на карточке)', 'Filters: videos, in progress, not opened, favorites (the star on a card)'],
        ['Сортировка по длительности', 'Sorting by length'],
        ['Меню «⋯» и правый клик: переименовать, удалить в корзину', 'The “⋯” menu and right click: rename, move to the Recycle Bin'],
      ]],
    ],
  },
  {
    version: '1.2.3',
    date: '2026-10-30',
    sections: [
      [['Обновления', 'Updates'], [
        ['Плеер проверяет обновления прямо на заставке и ставит новую версию до открытия', 'The player checks for updates on the splash screen and installs a new version before opening'],
      ]],
      [['Рисование на кадре — кнопка с кистью или D', 'Drawing on a frame — the brush button or D'], [
        ['Кисть, маркер, стрелка, рамка, овал и текст; 6 цветов, 3 толщины', 'Brush, marker, arrow, box, oval and text; 6 colors, 3 widths'],
        ['Выбор (V): линии, фигуры и текст можно перетаскивать, Delete удаляет выбранное', 'Select (V): lines, shapes and text can be moved, Delete removes the selected one'],
        ['Копировать (Ctrl+C) — сразу вставляется в Discord или Telegram; сохранить PNG (Ctrl+S)', 'Copy (Ctrl+C) pastes straight into Discord or Telegram; save as PNG (Ctrl+S)'],
      ]],
      [['Управление', 'Controls'], [
        ['Кнопки перемотки ⟲ ⟳; клик по времени показывает миллисекунды', 'Skip buttons ⟲ ⟳; clicking the time shows milliseconds'],
        ['Панель управления стала компактнее и сворачивается до полосы времени (H)', 'The control bar is more compact and folds down to the timeline (H)'],
        ['Esc закрывает видео и открывает библиотеку', 'Esc closes the video and opens the library'],
      ]],
      [['Библиотека', 'Library'], [
        ['Вкладки по папкам; папки и вложенные папки можно сворачивать', 'Tabs for folders; folders and subfolders can be folded'],
      ]],
    ],
  },
];
