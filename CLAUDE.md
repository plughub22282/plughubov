\# VST3 Manager Project Context



\## Стек

Electron + Vite + React + Tailwind CSS + TypeScript.



\## Текущий статус

\- Настроена базовая архитектура Electron IPC.

\- Реализованы методы `stats`, `claim`, `redeem` для реферальной системы.

\- Разрабатывается 3-этапная система защиты от вирусов (Anti-Spoofing, двухфазный VirusTotal API v3, карантин-зона).



\## Архитектурные правила

\- Весь код строго разделен: Main (Node.js) и Renderer (React UI).

\- Взаимодействие только через `preload.ts` и `window.api`.





