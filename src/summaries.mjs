/**
 * Generate, store, and schedule daily and weekly work summaries.
 *
 * The text is written by the host's language-model service from the material
 * built by `summary-data.mjs`; this module owns the prompt contract, the JSON
 * store under `$DSH_HOME/workbench/summaries.json`, and the due-time rules.
 *
 * Design:
 *   - a daily summary covers one local day and is written from that day's raw
 *     conversation material;
 *   - a weekly summary covers Monday to Friday: it is rewritten from that
 *     week's daily summaries when they exist, and falls back to the week's raw
 *     material when they do not, so the feature works from its first day;
 *   - every call is opt-in through configuration and degrades to a clear error
 *     when no model service or route is available;
 *   - stored text is redacted again before saving, because the model may echo
 *     something credential-shaped.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  addDays,
  collectSummaryMaterial,
  dayKeyOf,
  dayWindow,
  isoWeekdayOfKey,
  localTimeOf,
  weekWindow,
  workWeekKeys,
} from './summary-data.mjs'
import { redactSecrets } from './redact.mjs'

/** Store schema version; a mismatch is treated as a cold start. */
const STORE_VERSION = 1

/** Keep the store bounded; older entries are dropped first. */
const MAX_ENTRIES = 200

/** System instruction for the daily report. */
const DAILY_SYSTEM = [
  '你是一名严谨的中文工作总结助手，负责把技术对话整理成能直接发给上级的书面日报。',
  '只根据用户提供的当日对话材料写作；材料里没有的工作、数字、人名不要编造，宁可少写。',
  '忽略闲聊、寒暄、娱乐、与工作无关的学习类内容，只保留与工作/项目推进相关的事项。',
  '不要输出代码、密钥、完整文件路径、链接或表格；不要写“我建议”“或许”这类含糊表述。',
  '固定四段，段落标题照抄用户要求，简体中文，200-400 字，读起来像一份正式日报。',
].join('\n')

/** System instruction for the weekly report rebuilt from daily reports. */
const WEEKLY_SYSTEM = [
  '你是一名严谨的中文工作总结助手，负责把一周的日报合并成能直接发给上级的书面周报。',
  '只根据用户提供的本周日报材料写周报；材料里没有的内容不要补充，不要编造数据。',
  '忽略与工作无关的闲聊内容，按项目或事项归类，合并重复事项，突出产出和进展。',
  '不要输出代码、密钥、完整文件路径、链接或表格。',
  '固定四段，段落标题照抄用户要求，简体中文，300-500 字，读起来像一份正式周报。',
].join('\n')

/** System instruction for the weekly fallback that reads raw material. */
const WEEKLY_MATERIAL_SYSTEM = [
  '你是一名严谨的中文工作总结助手，负责把一周的原始工作对话整理成能直接发给上级的书面周报。',
  '只根据用户提供的本周对话材料写作；材料里没有的工作、数字、人名不要编造，宁可少写。',
  '忽略闲聊、寒暄、娱乐、与工作无关的学习类内容，按项目或事项归类，突出产出和进展。',
  '不要输出代码、密钥、完整文件路径、链接或表格。',
  '固定四段，段落标题照抄用户要求，简体中文，300-500 字，读起来像一份正式周报。',
].join('\n')

/** Local weekday labels, indexed by ISO weekday. */
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

/**
 * Path of the summary store.
 * @param {string} dshHome - DSH home directory.
 * @returns {string} absolute path.
 */
export function summariesPath(dshHome) {
  return join(dshHome, 'workbench', 'summaries.json')
}

/**
 * Load the summary store, treating a missing or corrupt file as empty.
 * @param {string} dshHome - DSH home directory.
 * @returns {{version: number, entries: Record<string, object>}} store.
 */
export function loadSummaryStore(dshHome) {
  try {
    const parsed = JSON.parse(readFileSync(summariesPath(dshHome), 'utf8'))
    if (parsed?.version === STORE_VERSION && parsed.entries !== null && typeof parsed.entries === 'object') return parsed
  } catch {
    // Missing or unreadable: start empty and rewrite on the next save.
  }
  return { version: STORE_VERSION, entries: {} }
}

/**
 * Persist the summary store.
 * @param {string} dshHome - DSH home directory.
 * @param {{version: number, entries: Record<string, object>}} store - store to write.
 * @returns {void}
 */
export function saveSummaryStore(dshHome, store) {
  const path = summariesPath(dshHome)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(store, null, 2))
}

/**
 * Format a date key for display, e.g. `2026-11-03` → `11月3日（周二）`.
 * @param {string} dayKey - `YYYY-MM-DD`.
 * @returns {string} display label.
 */
export function formatDateLabel(dayKey) {
  const [, month, day] = dayKey.split('-').map(Number)
  const weekday = WEEKDAY_LABELS[isoWeekdayOfKey(dayKey) - 1] ?? ''
  return `${month}月${day}日（${weekday}）`
}

/**
 * Build the store key for one summary period.
 * @param {'daily' | 'weekly'} kind - summary kind.
 * @param {string} fromKey - first covered date.
 * @param {string} toKey - last covered date.
 * @returns {string} store key.
 */
export function summaryKey(kind, fromKey, toKey) {
  return kind === 'daily' ? `daily:${fromKey}` : `weekly:${fromKey}~${toKey}`
}

/**
 * Read one kind of summary, newest first.
 * @param {object} store - summary store.
 * @param {'daily' | 'weekly'} kind - summary kind.
 * @returns {object[]} entries.
 */
export function listSummaryEntries(store, kind) {
  return Object.values(store.entries)
    .filter((entry) => entry !== null && typeof entry === 'object' && entry.kind === kind)
    .sort((left, right) => (right.generatedAt ?? 0) - (left.generatedAt ?? 0))
}

/**
 * Persist one generated entry, keeping the store bounded.
 * @param {string} dshHome - DSH home directory.
 * @param {object} entry - summary entry.
 * @returns {object} the saved entry.
 */
export function saveSummaryEntry(dshHome, entry) {
  const store = loadSummaryStore(dshHome)
  store.entries[entry.key] = entry
  const all = Object.values(store.entries).sort((left, right) => (right.generatedAt ?? 0) - (left.generatedAt ?? 0))
  for (const stale of all.slice(MAX_ENTRIES)) delete store.entries[stale.key]
  saveSummaryStore(dshHome, store)
  return entry
}

/**
 * Build the daily prompt body.
 * @param {string} label - human date label.
 * @param {string} material - filtered conversation material.
 * @returns {string} user input.
 */
export function dailyPrompt(label, material) {
  return [
    `以下是 ${label} 当天我与 AI 助手的对话材料（已过滤掉系统提示等无关内容，工具输出未包含）。`,
    '请写今天的工作日报，写成可以直接发给上级的书面总结，固定四段：',
    '一、今日主要工作（3-6 条，每条一句话，写清“做了什么 + 产出/结果”）',
    '二、完成情况（哪些已完成、哪些进行中）',
    '三、问题与风险（没有就写“无”）',
    '四、明日计划（1-3 条；材料不足时写“待补充”）',
    '要求：简体中文，200-400 字，只写工作相关，不写感受和空话，不编造材料里没有的事。',
    '',
    '材料：',
    material,
  ].join('\n')
}

/**
 * Build the weekly prompt body from daily summaries.
 * @param {string} fromLabel - first date label.
 * @param {string} toLabel - last date label.
 * @param {string} dailyText - concatenated daily summaries.
 * @returns {string} user input.
 */
export function weeklyPrompt(fromLabel, toLabel, dailyText) {
  return [
    `以下是本周（${fromLabel} 至 ${toLabel}）每天的日报。`,
    '请写本周周报，写成可以直接发给上级的书面总结，固定四段：',
    '一、本周重点（3-5 条，每条一句话）',
    '二、进展与产出（按项目/模块归类，写清产出物）',
    '三、问题与风险（没有就写“无”）',
    '四、下周计划（2-3 条）',
    '要求：简体中文，300-500 字；只写材料里有的事；合并重复事项，不要编造数据。',
    '',
    '材料：',
    dailyText,
  ].join('\n')
}

/**
 * Build the weekly prompt body from raw conversation material.
 *
 * Used when the week has no daily summaries yet (for example the feature was
 * switched on mid-week), so a weekly report is still produced instead of being
 * skipped.
 * @param {string} fromLabel - first date label.
 * @param {string} toLabel - last date label.
 * @param {string} material - filtered conversation material for the week.
 * @returns {string} user input.
 */
export function weeklyMaterialPrompt(fromLabel, toLabel, material) {
  return [
    `以下是本周（${fromLabel} 至 ${toLabel}）的原始工作材料，本周尚未生成日报。`,
    '请直接写本周周报，写成可以直接发给上级的书面总结，固定四段：',
    '一、本周重点（3-5 条，每条一句话）',
    '二、进展与产出（按项目/模块归类，写清产出物）',
    '三、问题与风险（没有就写“无”）',
    '四、下周计划（2-3 条）',
    '要求：简体中文，300-500 字；只写材料里有的事；合并重复事项，不要编造数据。',
    '',
    '材料：',
    material,
  ].join('\n')
}

/**
 * Stream one text-only model call and return the assembled text.
 * @param {object} input
 * @param {any} input.llm - host `llm` service.
 * @param {string} input.provider - provider id.
 * @param {string} input.model - model id.
 * @param {string} input.system - system instruction.
 * @param {string} input.text - user input.
 * @param {number} input.maxTokens - output cap.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @returns {Promise<string>} redacted model text.
 */
export async function callSummaryModel({ llm, provider, model, system, text, maxTokens, signal }) {
  if (llm === null || llm === undefined || typeof llm.stream !== 'function') {
    throw new Error('当前环境没有可用的模型服务，无法生成总结')
  }
  const chunks = llm.stream({
    provider,
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    maxTokens,
    ...(signal === undefined ? {} : { signal }),
  })
  let output = ''
  let finish = null
  for await (const chunk of chunks) {
    if (chunk?.type === 'text-delta') output += chunk.text
    else if (chunk?.type === 'finish') finish = chunk.reason
  }
  const kind = finish?.kind ?? 'stop'
  if (kind !== 'stop') {
    if (kind === 'max-tokens') throw new Error('模型输出被截断（maxTokens 不够），请调大 summaryMaxOutputTokens')
    if (kind === 'tool-calls') throw new Error('模型试图调用工具，总结失败')
    if (kind === 'aborted') throw new Error('总结生成被取消')
    const message = finish?.failure?.message ?? finish?.failure?.code ?? kind
    throw new Error(`模型调用失败：${message}`)
  }
  const cleaned = output.trim()
  if (cleaned === '') throw new Error('模型没有返回文字')
  return redactSecrets(cleaned)
}

/**
 * Generate one daily summary from the day's material.
 * @param {object} input
 * @param {string} input.dshHome - DSH home directory.
 * @param {string} input.timeZone - IANA zone.
 * @param {string} [input.dateKey] - local date; defaults to today.
 * @param {any} input.llm - host `llm` service.
 * @param {string} input.provider - provider id.
 * @param {string} input.model - model id.
 * @param {number} [input.maxChars] - material character budget.
 * @param {number} [input.maxTokens] - output token cap.
 * @param {number} [input.now] - reference instant.
 * @returns {Promise<object>} generated entry, or `{skipped:true}` with a reason.
 */
export async function generateDailySummary(input) {
  const now = input.now ?? Date.now()
  const dateKey = input.dateKey ?? dayKeyOf(now, input.timeZone)
  const window = dayWindow(dateKey, input.timeZone)
  const material = collectSummaryMaterial({
    dshHome: input.dshHome,
    from: window.from,
    to: window.to,
    maxChars: input.maxChars ?? 60_000,
  })
  if (material.sessions.length === 0 || material.materialText.trim() === '') {
    return { skipped: true, reason: 'no-material', kind: 'daily', fromKey: dateKey, toKey: dateKey }
  }
  const label = formatDateLabel(dateKey)
  const text = await callSummaryModel({
    llm: input.llm,
    provider: input.provider,
    model: input.model,
    system: DAILY_SYSTEM,
    text: dailyPrompt(label, material.materialText),
    maxTokens: input.maxTokens ?? 1500,
  })
  const entry = {
    kind: 'daily',
    key: summaryKey('daily', dateKey, dateKey),
    fromKey: dateKey,
    toKey: dateKey,
    title: `${label} 日报`,
    text,
    generatedAt: now,
    model: `${input.provider}/${input.model}`,
    sessions: material.sessions.length,
    messageCount: material.messageCount,
    materialChars: material.materialText.length,
  }
  return saveSummaryEntry(input.dshHome, entry)
}

/**
 * Sum one numeric field across entries, tolerating missing values.
 * @param {object[]} entries - summary entries.
 * @param {string} field - numeric field name.
 * @returns {number} total.
 */
function sumField(entries, field) {
  let total = 0
  for (const entry of entries) {
    const value = entry[field]
    if (typeof value === 'number' && Number.isFinite(value)) total += value
  }
  return total
}

/**
 * Generate one weekly summary for the Monday-to-Friday week containing a date.
 *
 * The week's daily summaries are the preferred source, because they are already
 * written and checked. When the week has none (the feature was enabled mid-week,
 * or the machine was off), the week's raw conversation material is summarized
 * directly; only a week with no work material at all is skipped.
 * @param {object} input - same shape as {@link generateDailySummary}.
 * @returns {Promise<object>} generated entry, or `{skipped:true}` with a reason.
 */
export async function generateWeeklySummary(input) {
  const now = input.now ?? Date.now()
  const dateKey = input.dateKey ?? dayKeyOf(now, input.timeZone)
  const window = weekWindow(dateKey, input.timeZone)
  const fromLabel = formatDateLabel(window.fromKey)
  const toLabel = formatDateLabel(window.toKey)
  const store = loadSummaryStore(input.dshHome)
  const dailies = Object.values(store.entries)
    .filter(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        entry.kind === 'daily' &&
        typeof entry.fromKey === 'string' &&
        entry.fromKey >= window.fromKey &&
        entry.fromKey <= window.toKey,
    )
    .sort((left, right) => left.fromKey.localeCompare(right.fromKey))

  let promptText
  let system
  let materialChars
  let sessions
  let messageCount
  if (dailies.length > 0) {
    // Preferred path: polish the existing daily reports into a weekly report.
    const dailyText = dailies.map((entry) => `### ${formatDateLabel(entry.fromKey)}\n${entry.text}`).join('\n\n')
    promptText = weeklyPrompt(fromLabel, toLabel, dailyText)
    system = WEEKLY_SYSTEM
    materialChars = dailyText.length
    sessions = sumField(dailies, 'sessions')
    messageCount = sumField(dailies, 'messageCount')
  } else {
    // Fallback: no daily report exists for this week, summarize its raw
    // material instead of skipping a whole week of work.
    const material = collectSummaryMaterial({
      dshHome: input.dshHome,
      from: window.from,
      to: window.to,
      maxChars: input.maxChars ?? 60_000,
    })
    if (material.sessions.length === 0 || material.materialText.trim() === '') {
      return { skipped: true, reason: 'no-material', kind: 'weekly', fromKey: window.fromKey, toKey: window.toKey }
    }
    promptText = weeklyMaterialPrompt(fromLabel, toLabel, material.materialText)
    system = WEEKLY_MATERIAL_SYSTEM
    materialChars = material.materialText.length
    sessions = material.sessions.length
    messageCount = material.messageCount
  }

  const text = await callSummaryModel({
    llm: input.llm,
    provider: input.provider,
    model: input.model,
    system,
    text: promptText,
    maxTokens: input.maxTokens ?? 1800,
  })
  const entry = {
    kind: 'weekly',
    key: summaryKey('weekly', window.fromKey, window.toKey),
    fromKey: window.fromKey,
    toKey: window.toKey,
    title: `${fromLabel} – ${toLabel} 周报`,
    text,
    generatedAt: now,
    model: `${input.provider}/${input.model}`,
    sessions,
    messageCount,
    materialChars,
    dailyCount: dailies.length,
  }
  return saveSummaryEntry(input.dshHome, entry)
}

/**
 * Generate one summary of either kind.
 * @param {object} input - `kind` plus the {@link generateDailySummary} fields.
 * @returns {Promise<object>} generated entry or a skip reason.
 */
export function generateSummary(input) {
  return input.kind === 'weekly' ? generateWeeklySummary(input) : generateDailySummary(input)
}

/**
 * Parse an `HH:MM` configuration value into minutes after midnight.
 * @param {string} value - time text.
 * @param {number} fallback - minutes when invalid.
 * @returns {number} minutes after midnight.
 */
function parseClock(value, fallback) {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(String(value).trim())
  if (match === null) return fallback
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return fallback
  return hour * 60 + minute
}

/**
 * List the summary jobs that are due right now.
 *
 * Explainable rules, applied after the configured local time has passed:
 *   - daily: today's report and yesterday's report must both exist, so a day
 *     the machine was off is filled in on the next tick;
 *   - weekly: from Friday onwards the current Monday-to-Friday week must have a
 *     report; on Monday through Thursday the previous week must have one, which
 *     catches up a report missed while the service was not running.
 * @param {object} input
 * @param {number} input.now - reference instant.
 * @param {string} input.timeZone - IANA zone.
 * @param {string} [input.dailyTime] - `HH:MM`, default `18:30`.
 * @param {string} [input.weeklyTime] - `HH:MM`, default `18:30`.
 * @param {object} input.store - summary store.
 * @returns {{kind: 'daily'|'weekly', dateKey: string}[]} due jobs, daily first.
 */
export function dueSummaryJobs({ now, timeZone, dailyTime = '18:30', weeklyTime = '18:30', store }) {
  const todayKey = dayKeyOf(now, timeZone)
  const clock = localTimeOf(now, timeZone)
  const nowMinutes = clock.hour * 60 + clock.minute
  const dailyDue = nowMinutes >= parseClock(dailyTime, 18 * 60 + 30)
  const weeklyDue = nowMinutes >= parseClock(weeklyTime, 18 * 60 + 30)
  const has = (kind, fromKey, toKey) =>
    store.entries[summaryKey(kind, fromKey, toKey)] !== undefined
  const jobs = []
  if (dailyDue) {
    const yesterday = addDays(todayKey, -1)
    if (!has('daily', todayKey, todayKey)) jobs.push({ kind: 'daily', dateKey: todayKey })
    if (!has('daily', yesterday, yesterday)) jobs.push({ kind: 'daily', dateKey: yesterday })
  }
  if (weeklyDue) {
    const weekday = isoWeekdayOfKey(todayKey)
    // Friday (5) and the weekend belong to the week that just ended; Monday to
    // Thursday look back at the previous week for a report that was missed.
    const anchorKey = weekday >= 5 ? todayKey : addDays(todayKey, -7)
    const week = workWeekKeys(anchorKey)
    if (!has('weekly', week.fromKey, week.toKey)) jobs.push({ kind: 'weekly', dateKey: anchorKey })
  }
  return jobs
}
