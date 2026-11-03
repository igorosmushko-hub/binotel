/* SimpleForms ↔ Binatel — Frontend App */

const $ = id => document.getElementById(id)

const projectList         = $('project-list')
const statusFilter        = $('status-filter')
const audioFilter         = $('audio-filter')
const sortSelect          = $('sort-select')
const searchInput         = $('search-input')
const dateFromInput       = $('date-from')
const dateToInput         = $('date-to')
const loadBtn             = $('load-btn')
const downloadBar         = $('download-bar')
const downloadCsvLink     = $('download-csv-link')
const downloadXlsxLink    = $('download-xlsx-link')
const downloadArchiveLink = $('download-archive-link')
const actions             = $('actions')
const recordCount         = $('record-count')
const statusBar           = $('status-bar')
const tableBody           = $('table-body')
const loadingOverlay      = $('loading-overlay')
const archiveByList       = $('archive-by-list')
const formListFile        = $('form-list-file')
const formNumbersInput    = $('form-numbers-input')
const archiveListBtn      = $('archive-list-btn')
const archiveListStatus   = $('archive-list-status')
const archiveListSpinner  = $('archive-list-spinner')
const playerBar           = $('player-bar')
const playerAudio         = $('player-audio')
const playerTitle         = $('player-title')
const playerClose         = $('player-close')

let allRecords = []

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  showStatus('Загрузка проектов…', 'loading')
  try {
    const projects = await api('/api/projects')
    populateProjects(projects)
    hideStatus()
  } catch (err) {
    showStatus('Ошибка загрузки проектов: ' + err.message, 'error')
  }
}

function populateProjects(projects) {
  projectList.innerHTML = ''
  projects.forEach(p => {
    const label = document.createElement('label')
    label.className = 'project-item'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.value = p.id
    cb.addEventListener('change', onProjectChange)
    label.appendChild(cb)
    label.appendChild(document.createTextNode(p.name || p.id))
    projectList.appendChild(label)
  })
}

function getSelectedIds() {
  return Array.from(projectList.querySelectorAll('input[type=checkbox]:checked')).map(cb => cb.value)
}

function onProjectChange() {
  const ids = getSelectedIds()
  loadBtn.disabled = ids.length === 0
  if (ids.length > 0) {
    const idsParam = ids.join(',')
    downloadCsvLink.href     = `/api/export/csv?projectIds=${idsParam}`
    downloadXlsxLink.href    = `/api/export/xlsx?projectIds=${idsParam}`
    downloadArchiveLink.href = `/api/archive?projectIds=${idsParam}`
    downloadBar.style.display = 'flex'
    archiveByList.style.display = 'block'
  } else {
    downloadBar.style.display = 'none'
    archiveByList.style.display = 'none'
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

loadBtn.addEventListener('click', loadForms)

// Все фильтры — мгновенная реакция без перезагрузки
statusFilter.addEventListener('change', renderTable)
audioFilter.addEventListener('change', renderTable)
sortSelect.addEventListener('change', renderTable)
searchInput.addEventListener('input', renderTable)

dateFromInput.addEventListener('change', () => {
  if (dateFromInput.value) {
    dateToInput.min = dateFromInput.value
    if (dateToInput.value && dateToInput.value < dateFromInput.value) {
      dateToInput.value = dateFromInput.value
    }
  } else {
    dateToInput.min = ''
  }
  renderTable()
})

dateToInput.addEventListener('change', () => {
  if (dateToInput.value) {
    dateFromInput.max = dateToInput.value
    if (dateFromInput.value && dateFromInput.value > dateToInput.value) {
      dateFromInput.value = dateToInput.value
    }
  } else {
    dateFromInput.max = ''
  }
  renderTable()
})

// ── Load forms ────────────────────────────────────────────────────────────────

function setUiLocked(locked) {
  loadingOverlay.style.display = locked ? 'flex' : 'none'
  // Блокируем все интерактивные элементы страницы
  document.querySelectorAll('button, input, select, textarea, a.btn-download').forEach(el => {
    if (locked) el.setAttribute('disabled', '')
    else        el.removeAttribute('disabled')
  })
  // Кнопка загрузки — дополнительно управляем вручную после разблокировки
  if (!locked) {
    loadBtn.disabled = getSelectedIds().length === 0
    archiveListBtn.disabled = parseFormNumbers().length === 0
  }
}

// ── Архив по списку номеров анкет ─────────────────────────────────────────────

// Больше номеров в одном запросе рискует не уложиться в лимит времени Vercel (300 с)
const ARCHIVE_PART_SIZE  = 800
const ARCHIVE_PART_DELAY = 12000 // мс между запросами частей

function parseFormNumbers() {
  return [...new Set(
    formNumbersInput.value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
  )]
}

formNumbersInput.addEventListener('input', () => {
  archiveListBtn.disabled = parseFormNumbers().length === 0
})

// Загрузка списка номеров из XLSX/CSV: файл разбирает бэкенд, результат — в textarea
formListFile.addEventListener('change', async () => {
  const file = formListFile.files[0]
  if (!file) return
  archiveListStatus.textContent = 'Читаю файл…'
  try {
    const res = await fetch('/api/archive/parse-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

    const list = data.numbers.length ? data.numbers : data.ids
    formNumbersInput.value = list.join('\n')
    archiveListBtn.disabled = list.length === 0
    archiveListStatus.textContent =
      `Из файла «${file.name}» загружено ${list.length} ${data.numbers.length ? 'номеров' : 'ID'} анкет — проверьте и нажмите «Скачать архив».`
  } catch (err) {
    archiveListStatus.textContent = 'Ошибка чтения файла: ' + err.message
  } finally {
    formListFile.value = '' // чтобы повторный выбор того же файла сработал
  }
})

archiveListBtn.addEventListener('click', async () => {
  const ids = getSelectedIds()
  const numbers = parseFormNumbers()
  if (!ids.length || !numbers.length) return

  const parts = []
  for (let i = 0; i < numbers.length; i += ARCHIVE_PART_SIZE) {
    parts.push(numbers.slice(i, i + ARCHIVE_PART_SIZE))
  }

  archiveListBtn.disabled = true
  for (let i = 0; i < parts.length; i++) {
    submitArchiveRequest(ids, parts[i], parts.length > 1 ? `${i + 1}of${parts.length}` : '')
    archiveListStatus.textContent = parts.length > 1
      ? `Запрошена часть ${i + 1} из ${parts.length}… архив собирается на сервере.`
      : 'Архив собирается на сервере…'
    if (i < parts.length - 1) await sleep(ARCHIVE_PART_DELAY)
  }
  if (parts.length > 1) {
    archiveListStatus.textContent =
      `Запрошены все ${parts.length} части (${numbers.length} номеров) — архивы собираются, каждый скачается по готовности.`
  }
  archiveListBtn.disabled = false
})

// Сколько запросов на архив сейчас в процессе сборки на сервере — пока > 0, крутится спиннер.
let archivePending = 0
let archiveErrors = []

function setArchiveSpinner(active) {
  archiveListSpinner.style.display = active ? 'inline-block' : 'none'
}

// Вызывается, когда для одного запроса стало известно, что он либо начал скачиваться,
// либо завершился ошибкой (errorMessage). Когда все запросы разрешились — гасим спиннер
// и показываем итоговый статус.
function finishArchivePart(errorMessage) {
  if (errorMessage) archiveErrors.push(errorMessage)
  archivePending = Math.max(0, archivePending - 1)
  if (archivePending > 0) return

  setArchiveSpinner(false)
  archiveListStatus.textContent = archiveErrors.length
    ? 'Ошибка: ' + archiveErrors.join(' | ')
    : 'Скачивание началось — прогресс смотрите в панели загрузок браузера.'
  archiveErrors = []
}

// Отправляем скрытую форму в скрытый iframe: браузер сам подхватит скачивание,
// а страница не перезагрузится. fetch не используем, чтобы не держать гигабайты в памяти.
//
// Проблема: у файловых скачиваний (Content-Disposition: attachment) iframe никогда не
// получает событие 'load' — Chrome перехватывает их как download, а не как навигацию.
// Поэтому окончание сборки архива на сервере отслеживаем через cookie: sendArchive()
// в backend/src/routes/archive.ts выставляет её прямо перед началом отдачи файла,
// а тут мы её опрашиваем. Если же сервер вернул JSON с ошибкой (а не файл) — это
// обычная навигация, и 'load' сработает дважды: первый раз — служебный about:blank
// от самой вставки iframe в DOM, второй — уже реальный ответ с ошибкой.
function submitArchiveRequest(projectIds, numbers, part) {
  const iframe = document.createElement('iframe')
  const frameName = `archive-frame-${Date.now()}-${part || '0'}`
  iframe.name = frameName
  iframe.style.display = 'none'
  document.body.appendChild(iframe)

  const token = `${Date.now()}${Math.random().toString(36).slice(2)}`
  const cookieName = `dl_${token}`

  archivePending++
  setArchiveSpinner(true)

  let settled = false
  let loadCount = 0

  function settle(errorMessage) {
    if (settled) return
    settled = true
    clearInterval(pollId)
    clearTimeout(safetyTimeout)
    finishArchivePart(errorMessage)
  }

  const pollId = setInterval(() => {
    if (document.cookie.split('; ').includes(`${cookieName}=1`)) {
      document.cookie = `${cookieName}=; Max-Age=0; path=/`
      settle(null)
    }
  }, 400)

  // На случай сетевого сбоя/зависшего запроса — не держим спиннер вечно
  // (лимит функции на Vercel — 300 с, берём с запасом чуть меньше)
  const safetyTimeout = setTimeout(
    () => settle('не удалось определить статус — проверьте папку загрузок или попробуйте ещё раз'),
    290000
  )

  iframe.addEventListener('load', () => {
    loadCount++
    if (loadCount < 2) return // первая загрузка — служебный about:blank при вставке iframe
    let message = 'не удалось собрать архив'
    try {
      const text = iframe.contentDocument?.body?.innerText || ''
      const data = JSON.parse(text)
      if (data.error) message = data.error
    } catch {}
    settle(message)
  })

  const form = document.createElement('form')
  form.method = 'POST'
  form.action = '/api/archive'
  form.target = frameName
  form.style.display = 'none'

  const addField = (name, value) => {
    const input = document.createElement('input')
    input.type = 'hidden'
    input.name = name
    input.value = value
    form.appendChild(input)
  }
  addField('projectIds', projectIds.join(','))
  addField('formNumbers', numbers.join(','))
  addField('downloadToken', token)
  if (part) addField('part', part)

  document.body.appendChild(form)
  form.submit()
  form.remove()
  setTimeout(() => iframe.remove(), 10 * 60 * 1000)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function loadForms() {
  const ids = getSelectedIds()
  if (!ids.length) return

  const params = new URLSearchParams({ projectIds: ids.join(',') })

  setUiLocked(true)

  try {
    allRecords = await api(`/api/forms?${params}`)
    actions.style.display = 'flex'
    renderTable()
    hideStatus()
  } catch (err) {
    showStatus('Ошибка загрузки: ' + err.message, 'error')
  } finally {
    setUiLocked(false)
  }
}

// ── Render table ──────────────────────────────────────────────────────────────

function renderTable() {
  let filtered = allRecords

  // 1. Фильтр по статусу
  const statusVal = statusFilter.value
  if (statusVal) {
    filtered = filtered.filter(r => r.formStatus === statusVal)
  }

  // 2. Фильтр по наличию аудио
  const audioVal = audioFilter.value
  if (audioVal === 'yes') filtered = filtered.filter(r => r.recordingUrl)
  if (audioVal === 'no')  filtered = filtered.filter(r => !r.recordingUrl)

  // 3. Фильтр по дате
  const dateFrom = dateFromInput.value ? new Date(dateFromInput.value) : null
  const dateTo   = dateToInput.value   ? new Date(dateToInput.value + 'T23:59:59') : null
  if (dateFrom || dateTo) {
    filtered = filtered.filter(r => {
      if (!r.formCreatedAt) return false
      const d = new Date(r.formCreatedAt)
      if (dateFrom && d < dateFrom) return false
      if (dateTo   && d > dateTo)   return false
      return true
    })
  }

  // 4. Поиск по тексту
  const q = searchInput.value.trim().toLowerCase()
  if (q) {
    filtered = filtered.filter(r =>
      r.phone?.toLowerCase().includes(q) ||
      r.formId?.toLowerCase().includes(q) ||
      r.formNumber?.toLowerCase().includes(q) ||
      r.callId?.toLowerCase().includes(q)
    )
  }

  // 5. Сортировка
  const sortVal = sortSelect.value
  if (sortVal) {
    filtered = [...filtered] // не мутируем оригинал
    if (sortVal === 'num-desc') {
      filtered.sort((a, b) => Number(b.formNumber || 0) - Number(a.formNumber || 0))
    } else if (sortVal === 'num-asc') {
      filtered.sort((a, b) => Number(a.formNumber || 0) - Number(b.formNumber || 0))
    } else if (sortVal === 'date-desc') {
      filtered.sort((a, b) => new Date(b.formCreatedAt).getTime() - new Date(a.formCreatedAt).getTime())
    } else if (sortVal === 'date-asc') {
      filtered.sort((a, b) => new Date(a.formCreatedAt).getTime() - new Date(b.formCreatedAt).getTime())
    }
  }

  recordCount.textContent = `Записей: ${filtered.length} / ${allRecords.length}`

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="11" class="empty-cell">Нет данных</td></tr>`
    return
  }

  tableBody.innerHTML = filtered.map(r => `
    <tr>
      <td title="${r.projectName}">${truncate(r.projectName, 20)}</td>
      <td title="${r.formId}">${truncate(r.formId, 12)}</td>
      <td>${r.formNumber || '—'}</td>
      <td>${r.phone || '—'}</td>
      <td>${badge(r.formStatus)}</td>
      <td>${formatDate(r.formCreatedAt)}</td>
      <td title="${r.callId || ''}">${r.callId ? truncate(r.callId, 12) : '<span class="no-call">нет</span>'}</td>
      <td>${r.recordingUrl
        ? `<button type="button" class="rec-play" data-url="${r.recordingUrl}" data-label="№${r.formNumber || '—'} · ${r.phone || '—'}">▶ Слушать</button>`
        : '<span class="no-call">—</span>'
      }</td>
      <td>${formatDate(r.callDate)}</td>
      <td>${r.operator || '—'}</td>
      <td>${r.duration != null ? r.duration : '—'}</td>
    </tr>
  `).join('')
}

// ── Audio player ──────────────────────────────────────────────────────────────

let playbackSpeed = parseFloat(localStorage.getItem('playbackSpeed')) || 1

function applySpeed(speed) {
  playbackSpeed = speed
  localStorage.setItem('playbackSpeed', String(speed))
  playerAudio.playbackRate = speed
  playerAudio.defaultPlaybackRate = speed
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.speed) === speed)
  })
}

function playRecording(url, label) {
  playerBar.style.display = 'flex'
  document.body.classList.add('player-open')
  playerTitle.textContent = label
  if (playerAudio.getAttribute('src') !== url) {
    playerAudio.src = url
  }
  applySpeed(playbackSpeed)
  playerAudio.play()
}

tableBody.addEventListener('click', e => {
  const btn = e.target.closest('.rec-play')
  if (btn) playRecording(btn.dataset.url, btn.dataset.label)
})

document.querySelectorAll('.speed-btn').forEach(btn => {
  btn.addEventListener('click', () => applySpeed(parseFloat(btn.dataset.speed)))
})

// После смены src браузер сбрасывает playbackRate — восстанавливаем
playerAudio.addEventListener('loadedmetadata', () => {
  playerAudio.playbackRate = playbackSpeed
})

playerClose.addEventListener('click', () => {
  playerAudio.pause()
  playerAudio.removeAttribute('src')
  playerAudio.load() // прерываем загрузку записи
  playerBar.style.display = 'none'
  document.body.classList.remove('player-open')
})

applySpeed(playbackSpeed)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function api(url) {
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  return res.json()
}

function showStatus(msg, type) {
  statusBar.textContent = msg
  statusBar.className = `status-bar ${type}`
  statusBar.style.display = 'block'
}

function hideStatus() {
  statusBar.style.display = 'none'
}

const STATUS_LABEL = {
  targeted:    'Целевая',
  nontargeted: 'Нецелевая',
  incomplete:  'Незавершённая',
  defect:      'Брак',
}

function badge(status) {
  const cls = {
    targeted:    'badge-targeted',
    nontargeted: 'badge-nontargeted',
    incomplete:  'badge-incomplete',
    defect:      'badge-defect',
  }[status] || 'badge-unknown'
  return `<span class="badge ${cls}">${STATUS_LABEL[status] || status || '—'}</span>`
}

function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

function truncate(str, len) {
  if (!str) return '—'
  return str.length > len ? str.slice(0, len) + '…' : str
}

// ── Start ─────────────────────────────────────────────────────────────────────

init()
