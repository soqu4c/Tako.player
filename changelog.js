// What changed in each version, newest first. Shown once after an update and from
// "What's new" on the start screen and in Settings → About. Each text is [Russian, English].

const CHANGELOG = [
  {
    version: '1.4.0-beta.4',
    date: '2026-11-01',
    sections: [
      [['Видео по ссылке', 'Videos by link'], [
        ['YouTube, Twitch, VK Видео, Kick и другие сайты: вставьте ссылку в плеер (Ctrl+V), кнопка «Ссылка» на главном экране или Ctrl+U', 'YouTube, Twitch, VK Video, Kick and other sites: paste a link into the player (Ctrl+V), the “Link” button on the start screen or Ctrl+U'],
        ['Прямые эфиры — с пометкой «В эфире», записи можно перематывать', 'Live streams show “Live”, recordings can be sought'],
      ]],
      [['Видеоредактор', 'Video editor'], [
        ['Выделенные клипы тянутся все вместе, даже после отвязки звука от картинки', 'Selected clips are dragged all together, also after unlinking sound from picture'],
      ]],
    ],
  },
  {
    version: '1.4.0-beta.3',
    date: '2026-11-01',
    sections: [
      [['Видеоредактор', 'Video editor'], [
        ['Переходы между клипами: наплыв и затемнение — правый клик по клипу или «Скорость и переход» в эффектах', 'Transitions between clips: cross dissolve and dip to black — right click a clip, or “Speed and transition” in the effects'],
        ['Скорость клипа от 10% до 1000%, звук без изменения тона', 'Clip speed from 10% to 1000%, sound keeps its pitch'],
        ['Вкладка «История»: все шаги по названиям, к любому можно вернуться', 'The History tab: every step by name, go back to any of them'],
        ['Готовые настройки экспорта: YouTube, Shorts / TikTok, Discord до 10 и 50 МБ — и свои, под своим названием', 'Export presets: YouTube, Shorts / TikTok, Discord up to 10 and 50 MB — and your own, under your own name'],
        ['Короткое обучение при первом открытии (кнопка «?»), «Сообщить об ошибке»', 'A short tour on first opening (the “?” button), “Report a problem”'],
      ]],
      [['Плеер', 'Player'], [
        ['Всё из 1.3.3: оформление к Хеллоуину, «Сообщить об ошибке»', 'Everything from 1.3.3: the Halloween look, “Report a problem”'],
      ]],
    ],
  },
  {
    version: '1.4.0-beta.2',
    date: '2026-11-01',
    sections: [
      [['Видеоредактор', 'Video editor'], [
        ['Бегунок, доведённый до края таймлайна, плавно ведёт таймлайн дальше, а не перескакивает на целый экран', 'The playhead held at an edge of the timeline scrolls it on smoothly instead of jumping a screen at a time'],
        ['Громкость дорожки: 100% — двойным кликом по числу, частые клики по ползунку её не сбрасывают', 'Track volume: double click the number for 100%; quick clicks on the slider no longer reset it'],
      ]],
      [['Плеер', 'Player'], [
        ['Всё из версии 1.3.2: клики по полоске обрезки, правый клик по громкости — 100%', 'Everything from 1.3.2: clicks on the trim strip, right click on the volume for 100%'],
      ]],
    ],
  },
  {
    version: '1.4.0-beta.1',
    date: '2026-11-01',
    sections: [
      [['Видеоредактор (бета)', 'Video editor (beta)'], [
        ['Кнопка «β» слева: таймлайн с дорожками видео, звука и титров, монитор, панель проекта и эффектов', 'The “β” button on the left: a timeline with video, sound and title tracks, a monitor, project and effect panels'],
        ['Все звуковые дорожки файла (игра, микрофон, Discord) — отдельно, с волнами и названиями как в OBS', 'All sound tracks of a file (game, mic, Discord) apart, with waveforms and names as in OBS'],
        ['Громкость, затухания, положение, масштаб, поворот и прозрачность клипа', 'Clip volume, fades, position, scale, rotation and opacity'],
        ['Титры со шрифтами, метки, цвета клипов, блокировка и выключение дорожек', 'Titles with fonts, markers, clip colors, locking and muting tracks'],
        ['Экспорт: размер, частота кадров, качество или битрейт, 2 прохода', 'Export: size, frame rate, quality or bitrate, two passes'],
      ]],
      [['Плеер', 'Player'], [
        ['Несколько звуковых дорожек одновременно — кнопка «+» у дорожек или Shift+A', 'Several sound tracks at once — the “+” button by the tracks or Shift+A'],
      ]],
    ],
  },
  {
    version: '1.3.3',
    date: '2026-11-01',
    sections: [
      [['Хеллоуин 🎃', 'Halloween 🎃'], [
        ['С 24 октября по 2 ноября — летучие мыши, паутина и тыквенные цвета. Выключается в Настройки → Интерфейс', 'From October 24 to November 2 — bats, cobwebs and pumpkin colors. Switch it off in Settings → Interface'],
      ]],
      [['Сообщить об ошибке', 'Report a problem'], [
        ['Настройки → О программе → «Сообщить об ошибке»: откроется страница на GitHub, где уже указаны версия и последние ошибки программы', 'Settings → About → “Report a problem”: opens a GitHub page with the version and the program’s recent errors already filled in'],
      ]],
    ],
  },
  {
    version: '1.3.2',
    date: '2026-11-01',
    sections: [
      [['Исправления', 'Fixes'], [
        ['Полоска с кадрами в обрезке: клик ставит просмотр туда, куда нажали, а не прыгает в начало', 'The frame strip in trimming: a click goes where you clicked instead of jumping to the start'],
        ['Громкость: правый клик по ползунку — 100%, у отметки 100% ползунок прилипает', 'Volume: right click on the slider sets 100%, and the slider sticks at the 100% mark'],
        ['Громкость дорожек при сохранении: 100% — двойным кликом по числу, частые клики по ползунку его больше не сбрасывают', 'Track volumes when saving: double click the number for 100%; quick clicks on the slider no longer reset it'],
      ]],
    ],
  },
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
