// ============================================================================
//  PlugHub Admin — клиентская логика (ванильный JS).
//  Работает только через серверные /api/* эндпоинты. Никаких ключей Supabase
//  в браузере — служебный доступ к БД остаётся на сервере (server.js).
// ============================================================================

const $ = (id) => document.getElementById(id)

// ─── Утилиты ─────────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  let body = null
  try { body = await res.json() } catch { /* пустой ответ */ }
  if (!res.ok) throw new Error(body?.error || `Ошибка ${res.status}`)
  return body
}

let toastTimer = null
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.style.opacity = '1'
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.style.opacity = '0' }, 2200)
}

function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('Скопировано')).catch(() => toast('Не удалось скопировать'))
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d)) return '—'
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// ─── Экраны ──────────────────────────────────────────────────────────────────

function showLogin() { $('login').classList.remove('hidden'); $('panel').classList.add('hidden') }
function showPanel() { $('login').classList.add('hidden'); $('panel').classList.remove('hidden'); loadAll() }

// ─── Авторизация ─────────────────────────────────────────────────────────────

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('loginBtn'); const err = $('loginError')
  err.classList.add('hidden')
  btn.disabled = true; btn.textContent = 'Вход…'
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('password').value }) })
    $('password').value = ''
    showPanel()
  } catch (e2) {
    err.textContent = e2.message
    err.classList.remove('hidden')
  } finally {
    btn.disabled = false; btn.textContent = 'Войти'
  }
})

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }) } catch { /* ignore */ }
  showLogin()
})

// ─── Пользователи ────────────────────────────────────────────────────────────

async function loadUsers() {
  const body = $('usersBody')
  body.innerHTML = `<tr><td colspan="6" class="px-6 py-10 text-center text-slate-500">Загрузка…</td></tr>`
  try {
    const { users, total } = await api('/api/admin/users')
    $('userCount').textContent = `· ${total}`
    if (!users.length) {
      body.innerHTML = ''
      $('usersEmpty').classList.remove('hidden')
      return
    }
    $('usersEmpty').classList.add('hidden')
    body.innerHTML = users.map((u) => {
      const badge = u.premium_active
        ? `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-accent/20 text-accent border border-accent/30">✦ Премиум</span>`
        : `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-panel text-slate-400 border border-bdr">Бесплатный</span>`
      const name = esc(u.display_name || 'Без имени')
      const email = esc(u.email || '')
      return `
        <tr class="hover:bg-panel/40 transition">
          <td class="px-6 py-3.5">
            <div class="font-medium text-white">${name}</div>
            ${email ? `<div class="text-xs text-slate-500">${email}</div>` : ''}
          </td>
          <td class="px-6 py-3.5">${badge}</td>
          <td class="px-6 py-3.5 text-slate-400">${fmtDate(u.premium_until)}</td>
          <td class="px-6 py-3.5"><span class="font-mono text-xs text-slate-300">${esc(u.referral_code || '—')}</span></td>
          <td class="px-6 py-3.5 text-slate-400">${u.referral_rewards_granted ?? 0}</td>
          <td class="px-6 py-3.5 text-slate-500">${fmtDate(u.created_at)}</td>
        </tr>`
    }).join('')
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="px-6 py-10 text-center text-red-400">${esc(e.message)}</td></tr>`
  }
}

// ─── Список ключей ───────────────────────────────────────────────────────────

async function loadKeys() {
  const body = $('keysBody')
  body.innerHTML = `<tr><td colspan="6" class="px-6 py-10 text-center text-slate-500">Загрузка…</td></tr>`
  try {
    const { keys } = await api('/api/admin/keys')
    $('keyCount').textContent = `· ${keys.length}`
    if (!keys.length) {
      body.innerHTML = ''
      $('keysEmpty').classList.remove('hidden')
      return
    }
    $('keysEmpty').classList.add('hidden')
    body.innerHTML = keys.map((k) => {
      const used = !!k.redeemed_by
      const status = used
        ? `<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-medium bg-panel text-slate-400 border border-bdr">Активирован</span>`
        : `<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-semibold bg-green-500/15 text-green-400 border border-green-500/25">Свободен</span>`
      return `
        <tr class="hover:bg-panel/40 transition">
          <td class="px-6 py-3.5"><span class="font-mono text-slate-200">${esc(k.code)}</span></td>
          <td class="px-6 py-3.5 text-slate-400">${k.duration_days ?? 30}</td>
          <td class="px-6 py-3.5 text-slate-400">${esc(k.note || '—')}</td>
          <td class="px-6 py-3.5">${status}</td>
          <td class="px-6 py-3.5 text-slate-500">${fmtDate(k.created_at)}</td>
          <td class="px-6 py-3.5 text-right">
            <button data-code="${esc(k.code)}" class="copy-key text-xs px-2.5 py-1.5 rounded-lg border border-bdr bg-panel hover:bg-bg text-slate-300 transition">Копировать</button>
          </td>
        </tr>`
    }).join('')
    body.querySelectorAll('.copy-key').forEach((b) => b.addEventListener('click', () => copy(b.dataset.code)))
  } catch (e) {
    body.innerHTML = `<tr><td colspan="6" class="px-6 py-10 text-center text-red-400">${esc(e.message)}</td></tr>`
  }
}

// ─── Генерация ключей ────────────────────────────────────────────────────────

let lastGenerated = []

$('genBtn').addEventListener('click', async () => {
  const btn = $('genBtn'); const status = $('genStatus')
  const count = parseInt($('genCount').value, 10) || 1
  const durationDays = parseInt($('genDays').value, 10) || 30
  const note = $('genNote').value.trim()

  btn.disabled = true; btn.textContent = 'Генерация…'; status.textContent = ''
  try {
    const { created } = await api('/api/admin/keys', {
      method: 'POST',
      body: JSON.stringify({ count, durationDays, note })
    })
    lastGenerated = created.map((c) => c.code)
    renderGenerated(created)
    status.textContent = `Готово: ${created.length} шт.`
    loadKeys() // обновляем нижнюю таблицу
  } catch (e) {
    status.innerHTML = `<span class="text-red-400">${esc(e.message)}</span>`
  } finally {
    btn.disabled = false; btn.textContent = 'Сгенерировать ключ'
  }
})

function renderGenerated(created) {
  const wrap = $('genResult'); const list = $('genList')
  wrap.classList.remove('hidden')
  list.innerHTML = created.map((c) => `
    <div class="flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-panel border border-bdr">
      <span class="font-mono text-accent tracking-wide">${esc(c.code)}</span>
      <span class="text-xs text-slate-500 ml-auto">${c.duration_days} дн.</span>
      <button data-code="${esc(c.code)}" class="copy-one text-xs px-2.5 py-1.5 rounded-lg border border-bdr bg-card hover:bg-bg text-slate-300 transition">Копировать</button>
    </div>`).join('')
  list.querySelectorAll('.copy-one').forEach((b) => b.addEventListener('click', () => copy(b.dataset.code)))
}

$('copyAllBtn').addEventListener('click', () => {
  if (lastGenerated.length) copy(lastGenerated.join('\n'))
})

// ─── Релизы (публикация версий) ──────────────────────────────────────────────

async function loadReleases() {
  const list = $('relList')
  try {
    const { releases } = await api('/api/releases')
    if (!releases.length) {
      list.innerHTML = `<p class="text-sm text-slate-600">Пока не опубликовано ни одной версии.</p>`
      return
    }
    list.innerHTML = releases.map((r, i) => {
      const links = ['windows', 'mac', 'linux']
        .filter((k) => r.downloads?.[k])
        .map((k) => `<span class="text-xs px-2 py-0.5 rounded bg-panel border border-bdr text-slate-400">${k}</span>`)
        .join(' ')
      const latest = i === 0
        ? `<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 font-semibold">актуальная</span>`
        : ''
      return `
        <div class="flex items-center gap-3 px-4 py-3 rounded-xl bg-panel border border-bdr">
          <span class="font-mono font-semibold text-white">v${esc(r.version)}</span>
          ${latest}
          <div class="flex gap-1.5">${links}</div>
          ${r.notes ? `<span class="text-xs text-slate-500 truncate max-w-[200px]" title="${esc(r.notes)}">${esc(r.notes)}</span>` : ''}
          <span class="text-xs text-slate-600 ml-auto">${fmtDate(r.published_at)}</span>
          <button data-ver="${esc(r.version)}" class="del-rel text-xs px-2.5 py-1.5 rounded-lg border border-bdr bg-card hover:bg-red-500/10 hover:border-red-500/40 hover:text-red-400 text-slate-400 transition">Удалить</button>
        </div>`
    }).join('')
    list.querySelectorAll('.del-rel').forEach((b) => b.addEventListener('click', () => deleteRelease(b.dataset.ver)))
  } catch (e) {
    list.innerHTML = `<p class="text-sm text-red-400">${esc(e.message)}</p>`
  }
}

async function deleteRelease(version) {
  if (!confirm(`Удалить версию ${version}? Она пропадёт с сайта.`)) return
  try {
    await api(`/api/admin/releases/${encodeURIComponent(version)}`, { method: 'DELETE' })
    toast(`Версия ${version} удалена`)
    loadReleases()
  } catch (e) {
    toast(e.message)
  }
}

$('relBtn').addEventListener('click', async () => {
  const btn = $('relBtn'); const status = $('relStatus')
  btn.disabled = true; btn.textContent = 'Публикация…'; status.textContent = ''
  try {
    const { release } = await api('/api/admin/releases', {
      method: 'POST',
      body: JSON.stringify({
        version: $('relVersion').value,
        windowsUrl: $('relWin').value,
        macUrl: $('relMac').value,
        linuxUrl: $('relLinux').value,
        notes: $('relNotes').value
      })
    })
    status.innerHTML = `<span class="text-emerald-400">Опубликовано: v${esc(release.version)}</span>`
    ;['relVersion', 'relWin', 'relMac', 'relLinux', 'relNotes'].forEach((id) => { $(id).value = '' })
    loadReleases()
  } catch (e) {
    status.innerHTML = `<span class="text-red-400">${esc(e.message)}</span>`
  } finally {
    btn.disabled = false; btn.textContent = 'Опубликовать версию'
  }
})

// ─── Обновление ──────────────────────────────────────────────────────────────

$('refreshUsers').addEventListener('click', loadUsers)
$('refreshKeys').addEventListener('click', loadKeys)

function loadAll() { loadUsers(); loadKeys(); loadReleases() }

// ─── Старт: проверяем активную сессию ────────────────────────────────────────

;(async () => {
  try {
    const { authenticated } = await api('/api/admin/session')
    if (authenticated) showPanel(); else showLogin()
  } catch {
    showLogin()
  }
})()
