'use strict';

const crypto = require('crypto');
const express = require('express');
const { ActivityType, Client, Events, GatewayIntentBits, EmbedBuilder } = require('discord.js');

// ───────────────────────── Настройки (переменные окружения) ─────────────────────────
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.DISCORD_TOKEN;
const SECRET = process.env.RELAY_SECRET;
const DEFAULT_CHANNEL = process.env.CHANNEL_DEFAULT;

// Отдельные каналы по категориям (необязательно). Нет значения -> CHANNEL_DEFAULT.
// admin — команды админ-панели, баны и кики.
const CHANNELS = {
  players: process.env.CHANNEL_PLAYERS,
  kills: process.env.CHANNEL_KILLS,
  round: process.env.CHANNEL_ROUND,
  admin: process.env.CHANNEL_ADMIN,
};

// Онлайн сервера (всё необязательно):
//  • статус самого бота («Смотрит на 12/30») работает всегда;
//  • CHANNEL_STATUS  — канал, где бот ведёт одно обновляемое сообщение со статусом;
//  • CHANNEL_COUNTER — канал (лучше голосовой), в название которого пишется онлайн;
//  • STATUS_OFFLINE_AFTER — через сколько секунд без сигнала сервер считается офлайн (по умолчанию 90).
const STATUS_CHANNEL = process.env.CHANNEL_STATUS;
const COUNTER_CHANNEL = process.env.CHANNEL_COUNTER;
const OFFLINE_AFTER_MS = (Number(process.env.STATUS_OFFLINE_AFTER) || 90) * 1000;

if (!TOKEN || !SECRET || !DEFAULT_CHANNEL) {
  console.error('Нужны переменные окружения: DISCORD_TOKEN, RELAY_SECRET, CHANNEL_DEFAULT');
  process.exit(1);
}

// ───────────────────────── Оформление (меняй тут, DLL пересобирать не надо) ─────────────────────────
const EVENTS = {
  admin_command:      { cat: 'admin',   color: 0x3498db, title: '🛠️ Команда админ-панели' },
  ban:                { cat: 'admin',   color: 0x992d22, title: '🔨 Бан' },
  kick:               { cat: 'admin',   color: 0xe67e22, title: '👢 Кик' },
  waiting:            { cat: 'round',   color: 0x95a5a6, title: '⏳ Ожидание игроков' },
  round_start:        { cat: 'round',   color: 0x2ecc71, title: '▶️ Раунд начался' },
  round_end:          { cat: 'round',   color: 0xe67e22, title: '🏁 Раунд закончился' },
  join:               { cat: 'players', color: 0x57f287, title: '📥 Игрок зашёл' },
  leave:              { cat: 'players', color: 0xed4245, title: '📤 Игрок вышел' },
  kill:               { cat: 'kills',   color: 0xe74c3c, title: '💀 Убийство' },
  teamkill:           { cat: 'kills',   color: 0xf1c40f, title: '⚠️ Тимкилл' },
  warhead_start:      { cat: 'round',   color: 0xe74c3c, title: '☢️ Боеголовка запущена' },
  warhead_stop:       { cat: 'round',   color: 0x3498db, title: '🛑 Боеголовка остановлена' },
  warhead_detonated:  { cat: 'round',   color: 0x992d22, title: '💥 Боеголовка взорвалась' },
};

// Команды админ-панели, которые подсвечиваются красным как «опасные».
// Первое слово команды, в нижнем регистре. Правь под себя.
const DANGEROUS_COMMANDS = new Set([
  'ban', 'oban', 'unban', 'kick',
  'forceclass', 'give', 'kill', 'explode',
  'noclip', 'godmode', 'overwatch', 'bypass',
  'roundrestart', 'forcestart', 'roundlock', 'lobbylock',
  'server_event', 'cassie', 'setgroup',
]);

const LABELS = {
  admin: 'Админ',
  command: 'Команда',
  player: 'Игрок',
  user_id: 'ID',
  role: 'Роль',
  attacker: 'Убийца',
  attacker_id: 'ID убийцы',
  attacker_role: 'Роль убийцы',
  cause: 'Причина смерти',
  online: 'Онлайн',
  issuer: 'Кто выдал',
  reason: 'Причина',
  duration: 'Срок',
  winner: 'Победитель',
  round_time: 'Длительность',
  started_by: 'Кто запустил',
  stopped_by: 'Кто остановил',
};

const CODE_KEYS = new Set(['user_id', 'attacker_id', 'command']); // выводятся `моноширинным`
const WIDE_KEYS = new Set(['reason', 'command']);                 // на всю ширину, а не в строку

// Текст статуса бота. Discord сам добавляет глагол: «Смотрит» + текст ниже.
const PRESENCE_TEXT = {
  live: (online, max) => `на ${online}/${max}`,   // -> «Смотрит на 12/30»
  offline: 'на сервер: офлайн',                    // -> «Смотрит на сервер: офлайн»
  noData: 'на сервер: ждёт сигнал',                // -> «Смотрит на сервер: ждёт сигнал»
};

const ROUND_STATES = { waiting: 'Ожидание игроков', in_progress: 'Идёт', ended: 'Закончился' };
const STATUS_FOOTER = 'SCP:SL • статус сервера'; // по этой подписи бот находит своё сообщение со статусом

// ───────────────────────── Вспомогательное ─────────────────────────
const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

// Убираем Unity rich text (<color=red>…</color>) и экранируем markdown, чтобы ник не ломал эмбед.
const cleanText = (s) =>
  String(s ?? '')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/([\\*_~`|>])/g, '\\$1')
    .trim();

// Для моноширинных значений: обратные кавычки заменяем, переносы строк убираем.
const cleanCode = (s) => String(s ?? '').replace(/`/g, "'").replace(/\s+/g, ' ').trim();

function authorized(req) {
  const given = Buffer.from(String(req.get('x-relay-secret') || ''));
  const expected = Buffer.from(SECRET);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ───────────────────────── Логи: построение эмбедов ─────────────────────────
function buildEmbed(evt, serverName) {
  const meta = EVENTS[evt.type] || { cat: 'default', color: 0x5865f2, title: clip(evt.type, 60) };
  const fieldsIn = evt.fields && typeof evt.fields === 'object' ? evt.fields : {};

  let { title, color } = meta;
  if (evt.type === 'kill' && !fieldsIn.attacker) title = '💀 Смерть';

  if (evt.type === 'admin_command') {
    const name = String(fieldsIn.command || '').trim().split(/\s+/)[0].toLowerCase();
    if (DANGEROUS_COMMANDS.has(name)) {
      title = '🚨 Команда админ-панели';
      color = 0xe74c3c;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setFooter({ text: clip(cleanText(serverName), 100) || 'SCP:SL' });

  const ts = Number(evt.ts);
  embed.setTimestamp(Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000) : new Date());

  const fields = [];
  for (const [key, raw] of Object.entries(fieldsIn)) {
    if (raw == null) continue;

    let value;
    if (CODE_KEYS.has(key)) {
      const code = clip(cleanCode(raw), key === 'command' ? 900 : 60);
      value = code ? '`' + code + '`' : '';
    } else {
      value = clip(cleanText(raw), WIDE_KEYS.has(key) ? 300 : 100);
    }
    if (!value) continue;

    fields.push({ name: clip(LABELS[key] || key, 40), value, inline: !WIDE_KEYS.has(key) });
  }
  if (fields.length) embed.addFields(fields.slice(0, 25));

  return { embed, cat: meta.cat };
}

// ───────────────────────── Онлайн сервера: данные ─────────────────────────
const MAX_SERVERS = 20;
const FORGET_AFTER_MS = 60 * 60 * 1000; // сервер, молчащий больше часа, пропадает из статуса

// name -> { online, max, round, roundStartedAt, lastSeen }
const servers = new Map();

const toInt = (v, min, max) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

function acceptStatus(body) {
  if (!body || typeof body !== 'object') return false;

  const name = clip(String(typeof body.server === 'string' ? body.server : '').trim(), 80) || 'SCP:SL';
  const online = toInt(body.online, 0, 10000);
  const max = toInt(body.max, 0, 10000);
  if (online === null || max === null) return false;
  if (!servers.has(name) && servers.size >= MAX_SERVERS) return false;

  const round = Object.prototype.hasOwnProperty.call(ROUND_STATES, body.round) ? body.round : '';
  const startedAt = Number(body.round_started_at);

  servers.set(name, {
    online,
    max,
    round,
    roundStartedAt: Number.isFinite(startedAt) && startedAt > 0 ? Math.floor(startedAt) : 0,
    lastSeen: Date.now(), // время берём своё: часы игрового сервера могут уходить
  });
  return true;
}

function snapshotServers() {
  const now = Date.now();
  const list = [];
  for (const [name, s] of servers) {
    const age = now - s.lastSeen;
    if (age > FORGET_AFTER_MS) {
      servers.delete(name);
      continue;
    }
    list.push({ name, ...s, offline: age > OFFLINE_AFTER_MS });
  }
  return list;
}

function buildStatusEmbed(list) {
  const live = list.filter((s) => !s.offline);
  const color = !list.length ? 0x95a5a6 : live.length ? 0x57f287 : 0xed4245;

  const embed = new EmbedBuilder()
    .setTitle('📊 Статус сервера')
    .setColor(color)
    .setFooter({ text: STATUS_FOOTER })
    .setTimestamp(new Date());

  if (!list.length) {
    embed.setDescription('Данных ещё нет — жду первый сигнал от сервера.');
    return embed;
  }

  embed.addFields(
    list.slice(0, 25).map((s) => {
      const name = `${s.offline ? '🔴' : '🟢'} ${clip(cleanText(s.name), 200)}`;
      let value;
      if (s.offline) {
        value = `**Офлайн**\nПоследний сигнал: <t:${Math.floor(s.lastSeen / 1000)}:R>`;
      } else {
        const lines = [`**Онлайн:** ${s.online}/${s.max}`];
        const round = ROUND_STATES[s.round];
        if (round) {
          const since = s.round === 'in_progress' && s.roundStartedAt ? ` (начался <t:${s.roundStartedAt}:R>)` : '';
          lines.push(`**Раунд:** ${round}${since}`);
        }
        value = lines.join('\n');
      }
      return { name, value, inline: list.length > 1 };
    }),
  );

  return embed;
}

// Что показать сейчас: статус бота, название канала-счётчика, эмбед и «ключ» (меняется, когда что-то изменилось).
function computeView(list) {
  const live = list.filter((s) => !s.offline);

  let presence;
  let counterName;
  if (!list.length) {
    presence = { status: 'idle', text: PRESENCE_TEXT.noData };
    counterName = 'Онлайн: нет данных';
  } else if (!live.length) {
    presence = { status: 'idle', text: PRESENCE_TEXT.offline };
    counterName = 'Сервер офлайн';
  } else {
    const online = live.reduce((sum, s) => sum + s.online, 0);
    const max = live.reduce((sum, s) => sum + s.max, 0);
    presence = { status: 'online', text: PRESENCE_TEXT.live(online, max) };
    counterName = `Онлайн: ${online}/${max}`;
  }

  const key = JSON.stringify([
    presence,
    counterName,
    list.map((s) => [s.name, s.online, s.max, s.round, s.roundStartedAt, s.offline]),
  ]);

  return { presence, counterName, embed: buildStatusEmbed(list), key };
}

// ───────────────────────── Discord ─────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));

client.once(Events.ClientReady, (c) => console.log(`Бот вошёл как ${c.user.tag}`));
client.on(Events.Error, (err) => console.error('Discord client error:', err));

async function deliver(serverName, events) {
  await ready;

  // Группируем эмбеды по каналам, чтобы слать пачками (до 5 эмбедов в сообщении).
  const byChannel = new Map();
  for (const evt of events) {
    const { embed, cat } = buildEmbed(evt, serverName);
    const channelId = CHANNELS[cat] || DEFAULT_CHANNEL;
    if (!byChannel.has(channelId)) byChannel.set(channelId, []);
    byChannel.get(channelId).push(embed);
  }

  for (const [channelId, embeds] of byChannel) {
    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      console.error(`Не удалось получить канал ${channelId}:`, err.message);
      continue;
    }
    if (!channel || !channel.isTextBased()) {
      console.error(`Канал ${channelId} не текстовый или недоступен боту`);
      continue;
    }
    for (let i = 0; i < embeds.length; i += 5) {
      try {
        await channel.send({ embeds: embeds.slice(i, i + 5), allowedMentions: { parse: [] } });
      } catch (err) {
        console.error(`Не удалось отправить в ${channelId}:`, err.message);
      }
    }
  }
}

// Очередь доставки: порядок событий сохраняется, даже если запросы приходят внахлёст.
let deliveryChain = Promise.resolve();

// ───────────────────────── Онлайн сервера: вывод в Discord ─────────────────────────
const STATUS_TICK_MS = 10 * 1000;           // как часто проверяем, что изменилось (в т.ч. «сервер замолчал»)
const STATUS_MAX_AGE_MS = 60 * 1000;        // сообщение со статусом обновляем минимум раз в минуту
const COUNTER_MIN_INTERVAL_MS = 6 * 60 * 1000; // у Discord лимит на переименование канала: 2 раза за 10 минут

let statusMessage = null;
let refreshing = false;
let lastPresenceKey = '';
let lastStatusKey = '';
let lastStatusEditAt = 0;
let lastCounterName = '';
let lastCounterAt = 0;
let counterBusy = false;

async function updateStatusMessage(embed) {
  const channel = await client.channels.fetch(STATUS_CHANNEL);
  if (!channel || !channel.isTextBased()) {
    throw new Error('CHANNEL_STATUS не текстовый или недоступен боту');
  }

  // После перезапуска релея ищем своё прежнее сообщение со статусом среди последних в канале.
  // Если получить историю не удалось — бросаем ошибку, а не шлём новое сообщение (иначе был бы спам).
  if (!statusMessage) {
    const recent = await channel.messages.fetch({ limit: 25 });
    statusMessage =
      recent.find(
        (m) => m.author.id === client.user.id && m.embeds.some((e) => e.footer && e.footer.text === STATUS_FOOTER),
      ) || null;
  }

  if (statusMessage) {
    try {
      await statusMessage.edit({ embeds: [embed], allowedMentions: { parse: [] } });
      return;
    } catch (err) {
      if (err && err.code === 10008) statusMessage = null; // сообщение удалили — создадим заново
      else throw err;
    }
  }

  statusMessage = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

// Переименование канала не ждём: при лимите Discord запрос может висеть минутами.
function maybeUpdateCounter(name) {
  if (!COUNTER_CHANNEL || counterBusy || name === lastCounterName) return;
  if (Date.now() - lastCounterAt < COUNTER_MIN_INTERVAL_MS) return;

  counterBusy = true;
  lastCounterAt = Date.now();

  (async () => {
    const channel = await client.channels.fetch(COUNTER_CHANNEL);
    if (!channel || typeof channel.setName !== 'function') {
      throw new Error('CHANNEL_COUNTER недоступен боту или нельзя переименовать');
    }
    if (channel.name !== name) await channel.setName(name);
    lastCounterName = name;
  })()
    .catch((err) => console.error('Не удалось обновить канал-счётчик:', err.message))
    .finally(() => {
      counterBusy = false;
    });
}

async function refreshStatus() {
  if (refreshing || !client.isReady()) return;
  refreshing = true;

  try {
    const list = snapshotServers();
    const view = computeView(list);
    const now = Date.now();

    // 1) Статус самого бота. Обновляем только при изменении (у Discord лимит на смену статуса).
    const presenceKey = `${view.presence.status}|${view.presence.text}`;
    if (presenceKey !== lastPresenceKey) {
      lastPresenceKey = presenceKey;
      client.user.setPresence({
        status: view.presence.status,
        activities: [{ name: view.presence.text, type: ActivityType.Watching }],
      });
    }

    // Пока от сервера не пришло ни одного сигнала (например, сразу после перезапуска релея),
    // сообщение со статусом и название канала не трогаем: иначе затрём настоящие данные
    // значением «нет данных», а лимит на переименование канала не даст быстро исправить.
    if (!list.length) return;

    // 2) Сообщение со статусом.
    if (STATUS_CHANNEL && (view.key !== lastStatusKey || now - lastStatusEditAt > STATUS_MAX_AGE_MS)) {
      lastStatusKey = view.key;
      lastStatusEditAt = now; // фиксируем попытку, чтобы при ошибке не долбить Discord каждые 10 секунд
      await updateStatusMessage(view.embed);
    }

    // 3) Название канала-счётчика.
    maybeUpdateCounter(view.counterName);
  } catch (err) {
    console.error('Не удалось обновить статус:', err.message);
  } finally {
    refreshing = false;
  }
}

ready.then(() => {
  refreshStatus();
  setInterval(refreshStatus, STATUS_TICK_MS);
});

// ───────────────────────── HTTP ─────────────────────────
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.get('/', (_req, res) => res.type('text').send('SCP:SL Discord relay is running'));
app.get('/health', (_req, res) => res.json({ ok: true, discord: client.isReady(), servers: servers.size }));

app.post('/events', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const body = req.body;
  if (!body || !Array.isArray(body.events)) return res.status(400).json({ error: 'bad payload' });

  const events = body.events.filter((e) => e && typeof e.type === 'string').slice(0, 200);
  const serverName = typeof body.server === 'string' ? body.server : 'SCP:SL';

  deliveryChain = deliveryChain
    .then(() => deliver(serverName, events))
    .catch((err) => console.error('deliver failed:', err));

  return res.status(202).json({ accepted: events.length });
});

// Сигнал «я жив» от плагина: онлайн, максимум, состояние раунда.
app.post('/status', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!acceptStatus(req.body)) return res.status(400).json({ error: 'bad payload' });

  refreshStatus(); // не ждём ближайшего тика: первое появление и смена онлайна видны сразу
  return res.status(202).json({ ok: true });
});

// Битый JSON и т.п.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(400).json({ error: 'bad request' }));

app.listen(PORT, '0.0.0.0', () => console.log(`Релей слушает порт ${PORT}`));

client.login(TOKEN).catch((err) => {
  console.error('Не удалось войти в Discord:', err.message);
  process.exit(1);
});
